import { env } from "cloudflare:test";
import type { DraftRequest, FlagRequest, MoveRequest } from "@imap-mcp/writes";
import { beforeEach, describe, expect, it } from "vitest";
import { readSyncConfig } from "../src/config";
import { createLogger } from "../src/log";
import { createDraft, flagMessage, moveMessage } from "../src/writes";
import { WritableMailbox, type WritableMailboxOptions } from "./support/writable-mailbox";

// The three write tools, as the sync worker performs them (#12). Everything a
// caller is refused is refused here rather than in the MCP server: policy has
// to live with the credential, so there is no way to reach the mailbox that
// skips it.

function syncEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function log(overrides: Partial<Env> = {}) {
  return createLogger(syncEnv(overrides));
}

function config(overrides: Partial<Env> = {}) {
  return readSyncConfig(syncEnv(overrides));
}

function mailbox(options: WritableMailboxOptions = {}): WritableMailbox {
  return new WritableMailbox(options);
}

function target() {
  return { messageId: 1, folder: "Archive", uidValidity: 100, uid: 12 };
}

function flag(overrides: Partial<FlagRequest> = {}): FlagRequest {
  return { ...target(), add: ["Seen"], ...overrides };
}

function move(overrides: Partial<MoveRequest> = {}): MoveRequest {
  return { ...target(), destination: "Saved", ...overrides };
}

function draft(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return { to: ["bob@example.invalid"], subject: "Hello", body: "Hi there", ...overrides };
}

/** A messages row for the uid the fixtures act on, so a move has one to delete. */
async function seedMessage(): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO folders (name, uidvalidity) VALUES ('Archive', 100) ON CONFLICT (name) DO NOTHING",
  ).run();
  const folder = await env.DB.prepare("SELECT id FROM folders WHERE name = 'Archive'").first<{
    id: number;
  }>();
  const row = await env.DB.prepare(
    `INSERT INTO messages (folder_id, uidvalidity, uid, subject, internal_date)
     VALUES (?, 100, 12, 'Quarterly invoice', 0) RETURNING id`,
  )
    .bind(folder!.id)
    .first<{ id: number }>();
  return row!.id;
}

async function messageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM messages").first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_log"),
    env.DB.prepare("DELETE FROM folders"),
  ]);
});

describe("flag_message", () => {
  it("sets a flag and reports what the server holds afterwards", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ add: ["Seen", "Flagged"] }), log());

    expect(outcome).toEqual({ ok: true, detail: expect.stringContaining("Flagged") });
    expect(box.writes).toEqual(["setFlags 12 add Seen,Flagged"]);
  });

  it("clears a flag", async () => {
    const box = mailbox({
      folders: [{ name: "Archive", uidValidity: 100, messages: [{ uid: 12, flags: ["Seen"] }] }],
    });

    const outcome = await flagMessage(box, flag({ add: undefined, remove: ["Seen"] }), log());

    expect(outcome.ok).toBe(true);
    expect(box.writes).toEqual(["setFlags 12 remove Seen"]);
  });

  it("opens the folder writable", async () => {
    const box = mailbox();

    await flagMessage(box, flag(), log());

    expect(box.selects).toEqual([{ name: "Archive", readOnly: false }]);
  });

  it("refuses \\Deleted, which is how a message would be destroyed", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ add: ["Deleted"] }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("Deleted") });
    expect(box.writes).toEqual([]);
  });

  it("refuses a flag that is not on the allowlist", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ add: ["$Phishing"] }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual([]);
  });

  it("refuses a request that sets and clears the same flag", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ add: ["Seen"], remove: ["Seen"] }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual([]);
  });

  it("refuses a request that changes nothing", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ add: [], remove: [] }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual([]);
  });

  it("refuses when the folder has been renumbered since the search", async () => {
    const box = mailbox();

    const outcome = await flagMessage(box, flag({ uidValidity: 99 }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("UIDVALIDITY") });
    expect(box.writes).toEqual([]);
  });

  it("refuses when the uid is no longer in the folder", async () => {
    const box = mailbox({ folders: [{ name: "Archive", uidValidity: 100, messages: [] }] });

    const outcome = await flagMessage(box, flag(), log());

    expect(outcome.ok).toBe(false);
  });

  it("believes the read-back, not the STORE, when a write silently does not land", async () => {
    // cf-imap cannot parse the STORE confirmation under CONDSTORE at all, so
    // the read-back is the only truthful answer. A server that accepted the
    // command and changed nothing has to be reported as a failure.
    const box = mailbox({ ignoreFlags: ["Flagged"] });

    const outcome = await flagMessage(box, flag({ add: ["Flagged"] }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("Flagged") });
  });
});

describe("move_message", () => {
  it("copies, marks deleted and UID EXPUNGEs, in that order", async () => {
    const id = await seedMessage();
    const box = mailbox();

    const outcome = await moveMessage(env.DB, box, move({ messageId: id }), log());

    expect(outcome).toEqual({ ok: true, detail: expect.stringContaining("Saved") });
    expect(box.writes).toEqual(["copy 12 -> Saved", "setFlags 12 add Deleted", "expunge 12"]);
    expect(box.uidsIn("Archive")).toEqual([]);
    expect(box.uidsIn("Saved")).toHaveLength(1);
  });

  it("deletes the index row, which now names a uid that addresses nothing", async () => {
    const id = await seedMessage();

    await moveMessage(env.DB, mailbox(), move({ messageId: id }), log());

    expect(await messageCount()).toBe(0);
  });

  it("stops before marking \\Deleted when the copy is unconfirmed", async () => {
    const id = await seedMessage();
    const box = mailbox({ copyWithoutUid: true });

    const outcome = await moveMessage(env.DB, box, move({ messageId: id }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("COPYUID") });
    expect(box.writes).toEqual(["copy 12 -> Saved"]);
    expect(box.uidsIn("Archive")).toEqual([12]);
    expect(await messageCount()).toBe(1);
  });

  it("does not expunge when the \\Deleted flag did not land", async () => {
    const id = await seedMessage();
    const box = mailbox({ ignoreFlags: ["Deleted"] });

    const outcome = await moveMessage(env.DB, box, move({ messageId: id }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual(["copy 12 -> Saved", "setFlags 12 add Deleted"]);
    expect(await messageCount()).toBe(1);
  });

  it("refuses Trash by name", async () => {
    const box = mailbox();

    const outcome = await moveMessage(env.DB, box, move({ destination: "Trash" }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("Trash") });
    expect(box.writes).toEqual([]);
  });

  it("refuses a folder carrying the \\Junk attribute whatever it is called", async () => {
    const box = mailbox({
      folders: [
        { name: "Archive", uidValidity: 100, messages: [{ uid: 12, flags: [] }] },
        { name: "Rubbish", uidValidity: 200, attributes: ["HasNoChildren", "Junk"] },
      ],
    });

    const outcome = await moveMessage(env.DB, box, move({ destination: "Rubbish" }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual([]);
  });

  it("refuses a nested Trash", async () => {
    const box = mailbox({
      folders: [
        { name: "Archive", uidValidity: 100, messages: [{ uid: 12, flags: [] }] },
        { name: "INBOX/Trash", uidValidity: 200 },
      ],
    });

    const outcome = await moveMessage(env.DB, box, move({ destination: "INBOX/Trash" }), log());

    expect(outcome.ok).toBe(false);
  });

  it("refuses a folder the server does not have", async () => {
    const box = mailbox();

    const outcome = await moveMessage(env.DB, box, move({ destination: "Nowhere" }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("Nowhere") });
    expect(box.writes).toEqual([]);
  });

  it("refuses a move into the folder the message is already in", async () => {
    const box = mailbox();

    const outcome = await moveMessage(env.DB, box, move({ destination: "Archive" }), log());

    expect(outcome.ok).toBe(false);
    expect(box.writes).toEqual([]);
  });

  it("refuses when the folder has been renumbered since the search", async () => {
    const box = mailbox();

    const outcome = await moveMessage(env.DB, box, move({ uidValidity: 99 }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("UIDVALIDITY") });
    expect(box.writes).toEqual([]);
  });
});

describe("create_draft", () => {
  it("appends to Drafts with the \\Draft flag", async () => {
    const box = mailbox();

    const outcome = await createDraft(box, draft(), config(), log());

    expect(outcome.ok).toBe(true);
    expect(box.writes).toEqual(["append Drafts (Draft,Seen)"]);
    expect(box.appended).toContain("To: bob@example.invalid");
    expect(box.appended).toContain("Subject: Hello");
  });

  it("threads a reply", async () => {
    const box = mailbox();

    const outcome = await createDraft(
      box,
      draft({
        subject: "Re: Quarterly invoice",
        inReplyTo: "<abc@example.invalid>",
        references: ["<root@example.invalid>", "<abc@example.invalid>"],
      }),
      config(),
      log(),
    );

    expect(outcome.ok).toBe(true);
    expect(box.appended).toContain("In-Reply-To: <abc@example.invalid>");
    expect(box.appended).toContain("References: <root@example.invalid> <abc@example.invalid>");
  });

  it("refuses a header carrying a newline, which would forge headers", async () => {
    const box = mailbox();

    const outcome = await createDraft(
      box,
      draft({ subject: "Hi\r\nBcc: everyone@example.invalid" }),
      config(),
      log(),
    );

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("line break") });
    expect(box.writes).toEqual([]);
  });

  it("refuses a recipient carrying a newline", async () => {
    const box = mailbox();

    const outcome = await createDraft(
      box,
      draft({ to: ["bob@example.invalid\nCc: mallory@example.invalid"] }),
      config(),
      log(),
    );

    expect(outcome.ok).toBe(false);
  });

  it("refuses a draft with no recipient", async () => {
    const box = mailbox();

    const outcome = await createDraft(box, draft({ to: [] }), config(), log());

    expect(outcome.ok).toBe(false);
  });

  it("encodes a non-ASCII subject as an RFC 2047 word", async () => {
    const box = mailbox();

    await createDraft(box, draft({ subject: "Rechnung für März" }), config(), log());

    expect(box.appended).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(box.appended).not.toContain("März");
  });

  it("finds Drafts by its special-use attribute", async () => {
    const box = mailbox({
      folders: [
        { name: "Archive", uidValidity: 100 },
        { name: "Entwürfe", uidValidity: 400, attributes: ["HasNoChildren", "Drafts"] },
      ],
    });

    await createDraft(box, draft(), config(), log());

    expect(box.writes).toEqual(["append Entwürfe (Draft,Seen)"]);
  });

  it("falls back to the literal name, since iCloud advertises no \\Drafts", async () => {
    const box = mailbox({
      folders: [
        { name: "Archive", uidValidity: 100 },
        { name: "Drafts", uidValidity: 400, attributes: ["HasNoChildren"] },
      ],
    });

    await createDraft(box, draft(), config(), log());

    expect(box.writes).toEqual(["append Drafts (Draft,Seen)"]);
  });

  it("honours DRAFTS_FOLDER when the mailbox names it something else", async () => {
    const box = mailbox({
      folders: [
        { name: "Archive", uidValidity: 100 },
        { name: "Mail/Concepts", uidValidity: 400, attributes: ["HasNoChildren"] },
      ],
    });

    await createDraft(box, draft(), config({ DRAFTS_FOLDER: "Mail/Concepts" }), log());

    expect(box.writes).toEqual(["append Mail/Concepts (Draft,Seen)"]);
  });

  it("refuses when no Drafts folder can be found", async () => {
    const box = mailbox({ folders: [{ name: "Archive", uidValidity: 100 }] });

    const outcome = await createDraft(box, draft(), config(), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("DRAFTS_FOLDER") });
    expect(box.writes).toEqual([]);
  });

  it("succeeds, and says so, when the server sends no APPENDUID", async () => {
    const box = mailbox({ appendWithoutUid: true });

    const outcome = await createDraft(box, draft(), config(), log());

    expect(outcome.ok).toBe(true);
  });

  it("carries Cc, and omits From and Message-ID when no sender is configured", async () => {
    const box = mailbox();

    // IMAP_USER is "ada" in this suite — a local part, as iCloud's LOGIN wants
    // — so there is no address to write, and a draft with no From is legal.
    await createDraft(box, draft({ cc: ["carol@example.invalid"] }), config(), log());

    expect(box.appended).toContain("Cc: carol@example.invalid");
    expect(box.appended).not.toContain("From:");
    expect(box.appended).not.toContain("Message-ID:");
  });

  it("refuses when DRAFTS_FOLDER names a folder the server does not have", async () => {
    const box = mailbox();

    const outcome = await createDraft(box, draft(), config({ DRAFTS_FOLDER: "Nowhere" }), log());

    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining("DRAFTS_FOLDER") });
    expect(box.writes).toEqual([]);
  });

  it("uses DRAFT_FROM as the sender", async () => {
    const box = mailbox();

    await createDraft(box, draft(), config({ DRAFT_FROM: "ada@example.invalid" }), log());

    expect(box.appended).toContain("From: ada@example.invalid");
    expect(box.appended).toMatch(/Message-ID: <[0-9a-f-]+@example\.invalid>/);
  });
});
