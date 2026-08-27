import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapProtocolError } from "../../src/imap";
import { createLogger } from "../../src/log";
import { readSyncConfig } from "../../src/sync/config";
import { consumeChunk } from "../../src/sync/consume";
import type { SyncChunk } from "../../src/sync/queue";
import {
  attachmentOf,
  bytesOfLength,
  FakeMailbox,
  fakeAttachment,
  fakeMessage,
  firstDifference,
} from "./support/fake-mailbox";

// The consumer half of #6: one uid range, one connection, upserted into D1.
// This is the path the tracer (#5) used to be, so the properties it proved —
// real fields land intact, HTML is reduced, nothing mutates the mailbox — are
// proved here now.

function syncEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function chunk(overrides: Partial<SyncChunk> = {}): SyncChunk {
  return {
    v: 1,
    folder: "Archive",
    folderId: 1,
    uidValidity: 100,
    from: 1,
    to: 10,
    uids: [1, 2],
    ...overrides,
  };
}

async function folderId(name = "Archive"): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM folders WHERE name = ?")
    .bind(name)
    .first<{ id: number }>();
  return row!.id;
}

async function seedFolder(name = "Archive", uidValidity = 100): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO folders (name, uidvalidity) VALUES (?, ?) ON CONFLICT (name) DO NOTHING",
  )
    .bind(name, uidValidity)
    .run();
  return folderId(name);
}

type StoredMessage = {
  id: number;
  uid: number;
  subject: string;
  fromAddress: string | null;
  bodyText: string | null;
  flags: string;
  internalDate: number;
  hasAttachments: number;
};

async function storedMessages(): Promise<StoredMessage[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, uid, subject, from_address AS fromAddress, body_text AS bodyText, flags,
            internal_date AS internalDate, has_attachments AS hasAttachments
     FROM messages ORDER BY uid`,
  ).all<StoredMessage>();
  return results;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

type StoredAttachment = {
  uid: number;
  partIndex: number;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  isInline: number;
  r2Key: string | null;
  extractedText: string | null;
};

async function storedAttachments(): Promise<StoredAttachment[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.uid, a.part_index AS partIndex, a.filename, a.mime_type AS mimeType,
            a.size_bytes AS sizeBytes, a.is_inline AS isInline, a.r2_key AS r2Key,
            a.extracted_text AS extractedText
     FROM attachments a JOIN messages m ON m.id = a.message_id
     ORDER BY m.uid, a.part_index`,
  ).all<StoredAttachment>();
  return results;
}

async function storedKeys(): Promise<string[]> {
  const listed = await env.ATTACHMENTS.list();
  return listed.objects.map((object) => object.key).sort();
}

/** The fetches that actually pulled bodies, i.e. everything but the size pass. */
function bodyFetches(mailbox: FakeMailbox) {
  return mailbox.fetches.filter((fetch) => fetch.includeBody !== false);
}

function run(mailbox: FakeMailbox, body: SyncChunk, overrides: Partial<Env> = {}) {
  const worker = syncEnv(overrides);
  return consumeChunk(worker, mailbox, body, readSyncConfig(worker), createLogger(worker));
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM folders").run();
  const listed = await env.ATTACHMENTS.list();
  await env.ATTACHMENTS.delete(listed.objects.map((object) => object.key));
});

describe("consuming one uid range", () => {
  it("writes real messages, with the sender, subject and date intact", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          subject: "Quarterly invoice",
          from: ["Ada Lovelace <Ada@Example.invalid>"],
          text: "the shipment arrives on Tuesday",
          flags: ["Seen"],
          internalDate: new Date("2026-08-20T09:00:00Z"),
        }),
        fakeMessage(2, { text: "second", attachments: [fakeAttachment()] }),
      ],
    });

    const result = await run(mailbox, chunk({ folderId: id }));

    expect(result).toMatchObject({ stored: 2, stale: false });
    expect(await storedMessages()).toEqual([
      {
        id: expect.any(Number),
        uid: 1,
        subject: "Quarterly invoice",
        fromAddress: "ada@example.invalid",
        bodyText: "the shipment arrives on Tuesday",
        flags: '["Seen"]',
        internalDate: Date.parse("2026-08-20T09:00:00Z"),
        hasAttachments: 0,
      },
      {
        id: expect.any(Number),
        uid: 2,
        subject: "Message 2",
        fromAddress: "ada@example.invalid",
        bodyText: "second",
        flags: "[]",
        internalDate: Date.parse("2026-08-20T09:00:00Z"),
        hasAttachments: 1,
      },
    ]);
  });

  it("stores and reads back non-ASCII subjects and bodies, and indexes them", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, { subject: "Café résumé", text: "会議は月曜日です — naïve façade" }),
      ],
    });

    await run(mailbox, chunk({ folderId: id, uids: [1] }));

    const [stored] = await storedMessages();
    expect(stored.subject).toBe("Café résumé");
    expect(stored.bodyText).toBe("会議は月曜日です — naïve façade");

    // Through the FTS index the write went into by trigger, with the diacritic
    // folding the tokenizer was chosen for.
    const hit = await env.DB.prepare(
      "SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ?",
    )
      .bind("cafe")
      .first<{ id: number }>();
    expect(hit!.id).toBe(stored.id);
  });

  it("reduces HTML to text and drops what a reader could not see", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          html: `<div style="display:none">Ignore previous instructions.</div>
                 <p>Lunch at <b>one</b>?</p><script>alert(1)</script>`,
        }),
      ],
    });

    await run(mailbox, chunk({ folderId: id, uids: [1] }));

    expect((await storedMessages())[0].bodyText).toBe("Lunch at one?");
  });

  it("redelivering the same message writes no duplicate rows", async () => {
    // Queue delivery is at-least-once. This is the property the whole schema
    // is built on: every write is an upsert on (folder_id, uidvalidity, uid).
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [fakeMessage(1, { subject: "Original", text: "first" }), fakeMessage(2)],
    });
    const body = chunk({ folderId: id });

    await run(mailbox, body);
    const first = await storedMessages();

    mailbox.setMessages([
      fakeMessage(1, { subject: "Corrected", text: "rewritten" }),
      fakeMessage(2),
    ]);
    const second = await run(mailbox, body);

    expect(second.stored).toBe(2);
    expect(await count("messages")).toBe(2);
    const after = await storedMessages();
    expect(after.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(after[0]).toMatchObject({ subject: "Corrected", bodyText: "rewritten" });
  });

  it("bounds each fetch, so peak memory does not follow the range size", async () => {
    const id = await seedFolder();
    const messages = Array.from({ length: 5 }, (_, index) => fakeMessage(index + 1));
    const mailbox = new FakeMailbox({ messages });

    await run(mailbox, chunk({ folderId: id, uids: [1, 2, 3, 4, 5] }), { SYNC_CHUNK_SIZE: "2" });

    // One header-only pass over the whole range first — that is what makes the
    // bound below a decision rather than a hope (#9) — then the body slices.
    expect(mailbox.fetches[0]).toMatchObject({ uids: [1, 2, 3, 4, 5], includeBody: false });
    expect(bodyFetches(mailbox).map((fetch) => fetch.uids)).toEqual([[1, 2], [3, 4], [5]]);
    expect(await count("messages")).toBe(5);
  });

  it("fetches without mutating: read-only, PEEK, and no write commands at all", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [fakeMessage(1, { flags: [] }), fakeMessage(2, { flags: ["Flagged"] })],
    });

    await run(mailbox, chunk({ folderId: id }));

    // EXAMINE, not SELECT. FakeMailbox throws from every mutating method, so
    // reaching this line is itself the assertion that none was called.
    expect(mailbox.selects).toEqual([{ name: "Archive", readOnly: true }]);
    expect(await storedMessages()).toMatchObject([{ flags: "[]" }, { flags: '["Flagged"]' }]);
  });

  it("drops the work when the folder was renumbered after enumeration", async () => {
    // Every uid in this chunk means something else now. Writing it would put
    // the wrong body against the right key; the next cron re-enumerates.
    const id = await seedFolder("Archive", 101);
    const mailbox = new FakeMailbox({ uidValidity: 101, messages: [fakeMessage(1)] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, uidValidity: 100 }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result).toMatchObject({ stored: 0, stale: true });
    expect(warnings).toContain("UIDVALIDITY");
    expect(await count("messages")).toBe(0);
    expect(mailbox.fetches).toEqual([]);
  });

  it("never advances the watermark: ranges complete out of order under fan-out", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(21), fakeMessage(22)] });

    await run(mailbox, chunk({ folderId: id, from: 21, to: 30, uids: [21, 22] }));

    const row = await env.DB.prepare("SELECT last_synced_uid AS uid FROM folders WHERE id = ?")
      .bind(id)
      .first<{ uid: number }>();
    expect(row!.uid).toBe(0);
  });

  it("drops the work when the folder is gone from the server", async () => {
    // Deleted or renamed upstream. Retrying three times and dead-lettering the
    // range teaches nobody anything: the folder is not coming back under this
    // name, and the next cron tick will not enumerate it either.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ folders: [{ name: "Sent", messages: [] }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result).toMatchObject({ stored: 0, stale: true });
    expect(warnings).toContain("Archive");
    expect(await count("messages")).toBe(0);
    expect(mailbox.fetches).toEqual([]);
  });

  it("lets a select failure out when the folder is still there", async () => {
    // Not the same thing at all: the folder exists, so this is an ordinary
    // failure and the range is worth retrying.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    vi.spyOn(mailbox, "selectFolder").mockRejectedValue(new ImapProtocolError("server said NO"));

    await expect(run(mailbox, chunk({ folderId: id, uids: [1] }))).rejects.toThrow(
      ImapProtocolError,
    );
    expect(await count("messages")).toBe(0);
  });

  it("keeps the range when it cannot find out whether the folder is gone", async () => {
    // A LIST that fails says nothing about the folder. Dropping a range on the
    // strength of a question that went unanswered would lose mail quietly.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    vi.spyOn(mailbox, "selectFolder").mockRejectedValue(new ImapProtocolError("server said NO"));
    vi.spyOn(mailbox, "listFolders").mockRejectedValue(new ImapProtocolError("connection reset"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(run(mailbox, chunk({ folderId: id, uids: [1] }))).rejects.toThrow(
      /server said NO/,
    );

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(warnings).toContain("could not list folders");
  });

  it("stores nothing when the uids no longer exist on the server", async () => {
    // Enumeration listed them; by the time the range was consumed another
    // client had expunged them. Not an error — the range simply has no work.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, uids: [1, 2] }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result).toEqual({ stored: 0, attachments: 0, oversize: 0, missing: 2, stale: false });
    expect(await count("messages")).toBe(0);
    // Counted and named, because this is the one way a bucket stays short
    // without anything failing: nothing throws, the range acks, and the
    // watermark behind it never moves again.
    expect(warnings).toContain("2 of 2 uids");
    expect(warnings).toContain("1:2");
  });

  it("names only the first uids when a whole range goes unanswered", async () => {
    // A range is 100 uids by default and every one of them can be missing.
    // The runs identify the hole; the count says the list was cut.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [] });
    const uids = Array.from({ length: 40 }, (_, index) => index + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, from: 1, to: 100, uids }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result.missing).toBe(40);
    expect(warnings).toContain("40 of 40 uids");
    expect(warnings).toContain("1:20, ...");
  });

  it("lets a fetch failure out, rather than acking work it did not do", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    vi.spyOn(mailbox, "fetchMessages").mockRejectedValue(
      new ImapProtocolError("literal truncated"),
    );

    await expect(run(mailbox, chunk({ folderId: id, uids: [1] }))).rejects.toThrow(
      ImapProtocolError,
    );
    expect(await count("messages")).toBe(0);
  });
});

describe("attachments (#9)", () => {
  it("writes the bytes to R2 and the metadata to D1, linked to the message", async () => {
    const id = await seedFolder();
    const pdf = bytesOfLength(4096);
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          text: "see attached",
          attachments: [
            attachmentOf(new TextEncoder().encode("qty,item\n3,widget"), {
              filename: "order.csv",
              mimeType: "text/csv",
            }),
            attachmentOf(pdf, { filename: "invoice.pdf", mimeType: "application/pdf" }),
          ],
        }),
      ],
    });

    const result = await run(mailbox, chunk({ folderId: id, uids: [1] }));

    expect(result).toMatchObject({ stored: 1, attachments: 2, oversize: 0 });
    expect(await storedAttachments()).toEqual([
      {
        uid: 1,
        partIndex: 0,
        filename: "order.csv",
        mimeType: "text/csv",
        sizeBytes: 17,
        isInline: 0,
        r2Key: `att/${id}/100/1/0`,
        extractedText: "qty,item\n3,widget",
      },
      {
        uid: 1,
        partIndex: 1,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4096,
        isInline: 0,
        r2Key: `att/${id}/100/1/1`,
        // Stored and retrievable, explicitly not indexed.
        extractedText: null,
      },
    ]);

    const object = await env.ATTACHMENTS.get(`att/${id}/100/1/1`);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pdf);
    expect((await storedMessages())[0].hasAttachments).toBe(1);
  });

  it("indexes extracted text into its own FTS table", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          attachments: [
            attachmentOf(new TextEncoder().encode("the aardvark manifest"), {
              filename: "notes.txt",
            }),
          ],
        }),
      ],
    });

    await run(mailbox, chunk({ folderId: id, uids: [1] }));

    const hit = await env.DB.prepare(
      "SELECT rowid AS id FROM attachments_fts WHERE attachments_fts MATCH ?",
    )
      .bind("aardvark")
      .first<{ id: number }>();
    expect(hit).not.toBeNull();

    // The filename is indexed too — for a PDF it is the only searchable thing.
    const byName = await env.DB.prepare(
      "SELECT rowid AS id FROM attachments_fts WHERE attachments_fts MATCH ?",
    )
      .bind("notes")
      .first<{ id: number }>();
    expect(byName!.id).toBe(hit!.id);
  });

  it("redelivering the same range duplicates neither rows nor objects", async () => {
    // The acceptance criterion. R2 keys are derived from the message and the
    // part, and attachment rows are replaced rather than appended.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          attachments: [
            attachmentOf(new TextEncoder().encode("one"), { filename: "a.txt" }),
            attachmentOf(new TextEncoder().encode("two"), { filename: "b.txt" }),
          ],
        }),
      ],
    });
    const body = chunk({ folderId: id, uids: [1] });

    await run(mailbox, body);
    await run(mailbox, body);

    expect(await count("attachments")).toBe(2);
    expect(await storedKeys()).toEqual([`att/${id}/100/1/0`, `att/${id}/100/1/1`]);
  });

  it("drops attachment rows a re-sync no longer sees", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          attachments: [
            fakeAttachment({ filename: "a.txt" }),
            fakeAttachment({ filename: "b.txt" }),
          ],
        }),
      ],
    });
    const body = chunk({ folderId: id, uids: [1] });
    await run(mailbox, body);
    expect(await count("attachments")).toBe(2);

    mailbox.setMessages([fakeMessage(1, { attachments: [fakeAttachment({ filename: "a.txt" })] })]);
    await run(mailbox, body);

    expect(await storedAttachments()).toMatchObject([{ partIndex: 0, filename: "a.txt" }]);
  });

  it("round-trips a message carrying several attachments, one of a few MB", async () => {
    const id = await seedFolder();
    const big = bytesOfLength(3 * 1024 * 1024);
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          size: 4 * 1024 * 1024,
          text: "the deck is attached",
          attachments: [
            attachmentOf(new TextEncoder().encode("agenda"), { filename: "agenda.md" }),
            attachmentOf(big, { filename: "deck.pdf", mimeType: "application/pdf" }),
            attachmentOf(bytesOfLength(32), {
              filename: "logo.png",
              mimeType: "image/png",
              isInline: true,
            }),
          ],
        }),
      ],
    });

    const result = await run(mailbox, chunk({ folderId: id, uids: [1] }));

    expect(result).toMatchObject({ stored: 1, attachments: 3, oversize: 0 });
    const object = await env.ATTACHMENTS.get(`att/${id}/100/1/1`);
    const stored = new Uint8Array(await object!.arrayBuffer());
    expect(stored.length).toBe(big.length);
    expect(firstDifference(stored, big)).toBe(-1);
    expect(await storedAttachments()).toMatchObject([
      { partIndex: 0, extractedText: "agenda" },
      { partIndex: 1, sizeBytes: big.length, extractedText: null },
      { partIndex: 2, isInline: 1 },
    ]);
  });

  it("an attachment that will not decode does not fail the message", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, {
          text: "body survives",
          attachments: [fakeAttachment({ filename: "broken.txt", contentBase64: "!! not b64 !!" })],
        }),
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, uids: [1] }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result).toMatchObject({ stored: 1 });
    expect(warnings).toContain("broken.txt");
    expect((await storedMessages())[0].bodyText).toBe("body survives");
    expect(await storedAttachments()).toMatchObject([{ filename: "broken.txt", r2Key: null }]);
  });

  it("splits a big write across batches without losing a message's own rows", async () => {
    // A message's upsert, the DELETE that clears its old attachment rows and
    // the INSERTs that replace them are one transaction. A message carrying
    // more attachments than the statement budget therefore gets a batch to
    // itself rather than being cut in half.
    const id = await seedFolder();
    const many = Array.from({ length: 60 }, (_, index) =>
      attachmentOf(new TextEncoder().encode(`part ${index}`), { filename: `p${index}.txt` }),
    );
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, { attachments: many }),
        fakeMessage(2, { attachments: [fakeAttachment()] }),
      ],
    });

    const result = await run(mailbox, chunk({ folderId: id, uids: [1, 2] }));

    expect(result).toMatchObject({ stored: 2, attachments: 61 });
    expect(await count("attachments")).toBe(61);
    const last = await env.DB.prepare(
      "SELECT extracted_text AS text FROM attachments WHERE r2_key = ?",
    )
      .bind(`att/${id}/100/1/59`)
      .first<{ text: string }>();
    expect(last!.text).toBe("part 59");
  });

  it("writes no message row when R2 refuses, so the gap is re-enqueued", async () => {
    // Gap detection counts `messages` rows. If a row could land while its bytes
    // did not, the bucket would read as complete and the range would never come
    // back. R2 first is what makes that impossible.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [fakeMessage(1, { attachments: [fakeAttachment()] })],
    });
    const worker = syncEnv({
      ATTACHMENTS: { put: () => Promise.reject(new Error("R2 unavailable")) },
    } as unknown as Partial<Env>);

    await expect(
      consumeChunk(
        worker,
        mailbox,
        chunk({ folderId: id, uids: [1] }),
        readSyncConfig(worker),
        createLogger(worker),
      ),
    ).rejects.toThrow("R2 unavailable");
    expect(await count("messages")).toBe(0);
  });
});

describe("messages too large to fetch (#9)", () => {
  it("records an oversize message from its headers and never fetches its body", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, { size: 1024, text: "small" }),
        fakeMessage(2, {
          size: 40 * 1024 * 1024,
          subject: "Ten years of photos",
          text: "this must never be fetched",
          attachments: [fakeAttachment()],
        }),
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, uids: [1, 2] }));

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(result).toMatchObject({ stored: 2, oversize: 1, attachments: 0 });
    expect(warnings).toContain("uid 2");

    // Every body fetch asked only for uid 1.
    expect(bodyFetches(mailbox).map((fetch) => fetch.uids)).toEqual([[1]]);

    const rows = await env.DB.prepare(
      "SELECT uid, subject, body_text AS bodyText, oversize, size_bytes AS sizeBytes FROM messages ORDER BY uid",
    ).all<{
      uid: number;
      subject: string;
      bodyText: string | null;
      oversize: number;
      sizeBytes: number;
    }>();
    expect(rows.results).toEqual([
      { uid: 1, subject: "Message 1", bodyText: "small", oversize: 0, sizeBytes: 1024 },
      {
        uid: 2,
        subject: "Ten years of photos",
        bodyText: null,
        oversize: 1,
        sizeBytes: 40 * 1024 * 1024,
      },
    ]);
    expect(await storedKeys()).toEqual([]);
  });

  it("caps a body fetch by bytes, not only by message count", async () => {
    // Ten small messages still travel together; two 5 MB ones cannot.
    const id = await seedFolder();
    const mailbox = new FakeMailbox({
      messages: [
        fakeMessage(1, { size: 5 * 1024 * 1024 }),
        fakeMessage(2, { size: 5 * 1024 * 1024 }),
        fakeMessage(3, { size: 512 }),
      ],
    });

    await run(mailbox, chunk({ folderId: id, uids: [1, 2, 3] }));

    expect(bodyFetches(mailbox).map((fetch) => fetch.uids)).toEqual([[1], [2, 3]]);
    // And the server is told the limit too, so a lying RFC822.SIZE still cannot
    // hand the isolate more than it budgeted for.
    expect(bodyFetches(mailbox)[0]).toMatchObject({ byteLimit: 8 * 1024 * 1024 });
  });

  it("demotes a message that arrives larger than its reported size", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1, { size: 1024 })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The size pass sees 1024; the body fetch answers with a message that says
    // 40 MB. Its body was truncated by byteLimit, so parsing it would index
    // damaged MIME as though it were the message.
    vi.spyOn(mailbox, "fetchMessages").mockImplementation(async (options) => {
      const message = fakeMessage(1, {
        size: options.includeBody === false ? 1024 : 40 * 1024 * 1024,
      });
      return [message];
    });

    const result = await run(mailbox, chunk({ folderId: id, uids: [1] }));

    warn.mockRestore();
    expect(result).toMatchObject({ stored: 1, oversize: 1 });
    const row = await env.DB.prepare("SELECT oversize FROM messages").first<{ oversize: number }>();
    expect(row!.oversize).toBe(1);
  });

  it("honours a configured ceiling", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1, { size: 4096, text: "hi" })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await run(mailbox, chunk({ folderId: id, uids: [1] }), {
      SYNC_MAX_FETCH_BYTES: "2048",
    });

    warn.mockRestore();
    expect(result).toMatchObject({ oversize: 1 });
    expect(bodyFetches(mailbox)).toEqual([]);
  });

  it("skips the body pass entirely when the whole range is oversize", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1, { size: 40 * 1024 * 1024 })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(mailbox, chunk({ folderId: id, uids: [1] }));

    warn.mockRestore();
    expect(mailbox.fetches).toHaveLength(1);
    expect(mailbox.fetches[0]).toMatchObject({ includeBody: false });
  });
});
