import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAD_ID, getMessage, MAX_BODY_CHARS, NOT_FOUND, STALE } from "../../src/mcp/message";
import { clearIndex, seedAttachment, seedMessage } from "./support/seed";

/** Anything that would mean a database error reached a caller. */
const LEAKED_SQL = /d1_error|sqlite|no such|SELECT /i;

async function found(id: number) {
  const outcome = await getMessage(env.DB, { id });
  if (!outcome.ok) throw new Error(`expected a message, got: ${outcome.reason}`);
  return outcome.message;
}

async function refused(id: number): Promise<string> {
  const outcome = await getMessage(env.DB, { id });
  if (outcome.ok) throw new Error(`expected a refusal for id ${id}`);
  expect(outcome.reason).not.toMatch(LEAKED_SQL);
  return outcome.reason;
}

describe("getMessage", () => {
  beforeEach(clearIndex);

  it("returns the body and the envelope for an id search handed out", async () => {
    const id = await seedMessage({
      folder: "Archive",
      uid: 9931,
      subject: "Quarterly invoice",
      body: "the shipment arrives Tuesday",
      from: "alice@example.com",
      fromAddresses: ["Alice <alice@example.com>"],
      toAddresses: ["bob@example.com"],
      ccAddresses: ["carol@example.com"],
      flags: ["Seen"],
      sizeBytes: 4096,
      date: "2026-03-04T09:12:00Z",
    });

    expect(await found(id)).toMatchObject({
      id,
      folder: "Archive",
      uid: 9931,
      subject: "Quarterly invoice",
      fromAddress: "alice@example.com",
      fromAddresses: ["Alice <alice@example.com>"],
      toAddresses: ["bob@example.com"],
      ccAddresses: ["carol@example.com"],
      flags: ["Seen"],
      sizeBytes: 4096,
      internalDate: Date.parse("2026-03-04T09:12:00Z"),
      body: "the shipment arrives Tuesday",
      bodyChars: "the shipment arrives Tuesday".length,
      attachments: [],
    });
  });

  it("refuses an unknown id by name rather than leaking a database error", async () => {
    expect(await refused(4212)).toBe(NOT_FOUND);
  });

  it("refuses every shape of id that is not a positive whole number", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(await refused(id)).toBe(BAD_ID);
    }
  });

  it("tells a superseded generation apart from an id that never existed", async () => {
    // The folder has moved on to 200; this row's uids no longer address
    // anything on the server, but the row itself is still there.
    const id = await seedMessage({ folderUidValidity: 200, uidValidity: 100 });

    expect(await refused(id)).toBe(STALE);
    expect(STALE).not.toBe(NOT_FOUND);
  });

  it("still serves a folder that has never reported a UIDVALIDITY", async () => {
    const id = await seedMessage({ folderUidValidity: null, uidValidity: 0, body: "hello" });

    expect((await found(id)).body).toBe("hello");
  });

  it("caps the body and says how much of it there was", async () => {
    const body = "x".repeat(MAX_BODY_CHARS + 500);
    const id = await seedMessage({ body });

    const message = await found(id);

    expect(message.body).toHaveLength(MAX_BODY_CHARS);
    expect(message.bodyChars).toBe(body.length);
  });

  it("handles a message indexed with no body at all", async () => {
    const id = await seedMessage({ body: null });

    const message = await found(id);

    expect(message.body).toBeNull();
    expect(message.bodyChars).toBe(0);
  });

  it("reports a message whose attachments were never indexed", async () => {
    // #9 writes them now, but a row indexed before it landed still has none,
    // and so does an oversize one. Either way the metadata is absent rather
    // than empty, and the difference matters to what gets said about it.
    const id = await seedMessage({ hasAttachments: true });

    const message = await found(id);

    expect(message.hasAttachments).toBe(true);
    expect(message.attachments).toEqual([]);
    expect(message.oversize).toBe(false);
  });

  it("reports a message that was too large to fetch as such", async () => {
    // #9 gives an oversize message a row with no body, no attachments and no
    // reference headers, so that its uid bucket is not permanently short.
    // Serving that as an empty message would be a lie about the mailbox.
    const id = await seedMessage({ oversize: true, body: null, sizeBytes: 40_000_000 });

    const message = await found(id);

    expect(message.oversize).toBe(true);
    expect(message.body).toBeNull();
  });

  it("returns attachment rows in part order once there are any", async () => {
    const id = await seedMessage({ hasAttachments: true });
    await seedAttachment(id, { partIndex: 1, filename: "logo.png", isInline: true });
    await seedAttachment(id, {
      partIndex: 0,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 184_000,
    });

    expect((await found(id)).attachments).toEqual([
      {
        partIndex: 0,
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 184_000,
        isInline: false,
      },
      { partIndex: 1, filename: "logo.png", mimeType: null, sizeBytes: null, isInline: true },
    ]);
  });

  it("reads a recipient column that is not the JSON the sync worker writes", async () => {
    // Nothing writes this today — every list column goes through
    // JSON.stringify — but a backfill or a hand-fix could, and a parse that
    // threw would take the whole tool down over a column nothing depends on.
    const id = await seedMessage({ toAddresses: ["bob@example.com"] });
    await env.DB.prepare("UPDATE messages SET to_addresses = ?, cc_addresses = ? WHERE id = ?")
      .bind("not json", JSON.stringify({ not: "a list" }), id)
      .run();

    const message = await found(id);

    expect(message.toAddresses).toEqual([]);
    expect(message.ccAddresses).toEqual([]);
  });

  it("addresses each folder's copy of one message separately", async () => {
    const inbox = await seedMessage({ folder: "INBOX", rfcMessageId: "<one@example.invalid>" });
    const archive = await seedMessage({ folder: "Archive", rfcMessageId: "<one@example.invalid>" });

    expect((await found(inbox)).folder).toBe("INBOX");
    expect((await found(archive)).folder).toBe("Archive");
  });

  describe("without a network", () => {
    // The structural half of "neither tool opens an IMAP connection" is that
    // only src/imap/cf-imap-mailbox.ts may import the protocol client (a lint
    // rule); this is the behavioural half. `fetch` is the only other way out
    // of the isolate.
    beforeEach(() => {
      vi.stubGlobal("fetch", () => {
        throw new Error("this tool must not reach the network");
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("answers from D1 alone", async () => {
      const id = await seedMessage({ body: "offline" });

      expect((await found(id)).body).toBe("offline");
    });
  });
});
