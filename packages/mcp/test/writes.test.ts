import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDraft, flagMessage, moveMessage } from "../src/writes";
import { authenticated } from "./support/access";
import { clearIndex, seedMessage } from "./support/seed";
import { envWithWriter, FakeWriter } from "./support/writer";

// What this package is responsible for on a write (#12): turning a message id
// into uid coordinates, recording the attempt whether or not it succeeds, and
// never opening an IMAP connection to do either.

type AuditRow = {
  tool: string;
  actor: string | null;
  messageId: number | null;
  folder: string | null;
  uidvalidity: number | null;
  uid: number | null;
  arguments: string | null;
  outcome: string;
  detail: string | null;
};

async function auditRows(): Promise<AuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT tool, actor, message_id AS messageId, folder, uidvalidity, uid,
            arguments, outcome, detail
     FROM write_log ORDER BY id`,
  ).all<AuditRow>();
  return results;
}

const access = () => authenticated().access;

beforeEach(clearIndex);

describe("flag_message", () => {
  it("resolves the message and hands the sync worker uid coordinates", async () => {
    const id = await seedMessage({ folder: "Archive", uid: 9931 });
    const writer = new FakeWriter();

    const outcome = await flagMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      add: ["Seen"],
    });

    expect(outcome).toEqual({ ok: true, detail: "done" });
    expect(writer.calls).toEqual([
      {
        method: "flagMessage",
        request: { messageId: id, folder: "Archive", uidValidity: 100, uid: 9931, add: ["Seen"] },
      },
    ]);
  });

  it("records one audit row, with the caller and the arguments", async () => {
    const id = await seedMessage({ folder: "Archive", uid: 9931 });

    await flagMessage(envWithWriter(env, new FakeWriter()), access(), {
      messageId: id,
      add: ["Flagged"],
    });

    expect(await auditRows()).toEqual([
      {
        tool: "flag_message",
        actor: "luke@example.com",
        messageId: id,
        folder: "Archive",
        uidvalidity: 100,
        uid: 9931,
        arguments: JSON.stringify({ messageId: id, add: ["Flagged"] }),
        outcome: "ok",
        detail: "done",
      },
    ]);
  });

  it("records a refusal from the sync worker as an audit row too", async () => {
    const id = await seedMessage();
    const writer = new FakeWriter({ ok: false, reason: 'Cannot set "Deleted"' });

    const outcome = await flagMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      add: ["Deleted"],
    });

    expect(outcome.ok).toBe(false);
    expect(await auditRows()).toMatchObject([{ outcome: "error", detail: expect.any(String) }]);
  });

  it("records an attempt on a message id that does not exist", async () => {
    const writer = new FakeWriter();

    const outcome = await flagMessage(envWithWriter(env, writer), access(), {
      messageId: 4242,
      add: ["Seen"],
    });

    // The interesting half of the audit log is the attempts that went nowhere:
    // a model asking to flag a message that is not in the index is exactly the
    // shape an injected instruction leaves behind.
    expect(outcome.ok).toBe(false);
    expect(writer.calls).toEqual([]);
    expect(await auditRows()).toMatchObject([
      { tool: "flag_message", messageId: null, folder: null, outcome: "error" },
    ]);
  });

  it("records the attempt when the binding itself throws", async () => {
    const id = await seedMessage();
    const writer = new FakeWriter(undefined, new Error("service binding unavailable"));

    const outcome = await flagMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      add: ["Seen"],
    });

    expect(outcome).toMatchObject({ ok: false });
    expect(await auditRows()).toMatchObject([{ outcome: "error" }]);
  });

  it("refuses a row left behind by a UIDVALIDITY change", async () => {
    // The same rows search hides: the folder has been renumbered, so this uid
    // addresses a different message now, if it addresses one at all.
    const id = await seedMessage({ folder: "Archive", folderUidValidity: 200, uidValidity: 100 });
    const writer = new FakeWriter();

    const outcome = await flagMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      add: ["Seen"],
    });

    expect(outcome.ok).toBe(false);
    expect(writer.calls).toEqual([]);
  });

  it("records a null actor rather than failing when the identity lookup does", async () => {
    const id = await seedMessage();
    const broken = {
      aud: "irrelevant",
      getIdentity: async () => {
        throw new Error("identity service unavailable");
      },
    } as unknown as CloudflareAccessContext;

    const outcome = await flagMessage(envWithWriter(env, new FakeWriter()), broken, {
      messageId: id,
      add: ["Seen"],
    });

    expect(outcome.ok).toBe(true);
    expect(await auditRows()).toMatchObject([{ actor: null, outcome: "ok" }]);
  });

  it("refuses when the service binding is missing altogether", async () => {
    const id = await seedMessage();

    const outcome = await flagMessage(envWithWriter(env, undefined), access(), {
      messageId: id,
      add: ["Seen"],
    });

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("SYNC_WRITER") });
  });
});

describe("move_message", () => {
  it("passes the destination through untouched, and audits it", async () => {
    const id = await seedMessage({ folder: "Archive", uid: 7 });
    const writer = new FakeWriter();

    await moveMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      destination: "Saved",
    });

    expect(writer.calls).toEqual([
      {
        method: "moveMessage",
        request: {
          messageId: id,
          folder: "Archive",
          uidValidity: 100,
          uid: 7,
          destination: "Saved",
        },
      },
    ]);
    expect(await auditRows()).toMatchObject([{ tool: "move_message", uid: 7, outcome: "ok" }]);
  });

  it("keeps the audit row after the move deletes the message it names", async () => {
    const id = await seedMessage({ folder: "Archive", uid: 7 });
    const writer = new FakeWriter();

    await moveMessage(envWithWriter(env, writer), access(), {
      messageId: id,
      destination: "Saved",
    });
    // What the sync worker does at the end of a successful move.
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();

    // ON DELETE SET NULL, and the folder/uid columns are denormalised so the
    // row still says what happened once the reference is gone.
    expect(await auditRows()).toMatchObject([
      { tool: "move_message", messageId: null, folder: "Archive", uid: 7, outcome: "ok" },
    ]);
  });
});

describe("create_draft", () => {
  it("drafts a new message with no threading headers", async () => {
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), {
      to: ["bob@example.invalid"],
      subject: "Lunch",
      body: "Thursday?",
    });

    expect(writer.calls).toEqual([
      {
        method: "createDraft",
        request: { to: ["bob@example.invalid"], subject: "Lunch", body: "Thursday?" },
      },
    ]);
    expect(await auditRows()).toMatchObject([
      { tool: "create_draft", messageId: null, uid: null, outcome: "ok" },
    ]);
  });

  it("threads a reply under the message it answers", async () => {
    const id = await seedMessage({
      subject: "Quarterly invoice",
      rfcMessageId: "<abc@example.invalid>",
      referenceIds: ["<root@example.invalid>"],
    });
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), {
      inReplyTo: id,
      body: "Received, thanks.",
    });

    expect(writer.calls[0]?.request).toMatchObject({
      subject: "Re: Quarterly invoice",
      inReplyTo: "<abc@example.invalid>",
      references: ["<root@example.invalid>", "<abc@example.invalid>"],
    });
  });

  it("does not double up a subject that is already a reply", async () => {
    const id = await seedMessage({
      subject: "RE: Quarterly invoice",
      rfcMessageId: "<a@b.invalid>",
    });
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), { inReplyTo: id, body: "ok" });

    expect(writer.calls[0]?.request).toMatchObject({ subject: "RE: Quarterly invoice" });
  });

  it("lets an explicit subject win over the one it would derive", async () => {
    const id = await seedMessage({ subject: "Quarterly invoice", rfcMessageId: "<a@b.invalid>" });
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), {
      inReplyTo: id,
      subject: "Something else",
      body: "ok",
    });

    expect(writer.calls[0]?.request).toMatchObject({ subject: "Something else" });
  });

  it("threads without References when the original had none recorded", async () => {
    const id = await seedMessage({ subject: "Hi", rfcMessageId: null });
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), { inReplyTo: id, body: "ok" });

    const request = writer.calls[0]?.request as { inReplyTo?: string; references?: string[] };
    expect(request.inReplyTo).toBeUndefined();
    expect(request.references ?? []).toEqual([]);
  });

  it("carries Cc, and clears flags as well as setting them", async () => {
    const id = await seedMessage();
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), {
      to: ["bob@example.invalid"],
      cc: ["carol@example.invalid"],
      body: "hi",
    });
    await flagMessage(envWithWriter(env, writer), access(), { messageId: id, remove: ["Seen"] });

    expect(writer.calls[0]?.request).toMatchObject({ cc: ["carol@example.invalid"] });
    expect(writer.calls[1]?.request).toMatchObject({ remove: ["Seen"] });
  });

  it("survives a References column that is not a JSON array", async () => {
    const id = await seedMessage({ subject: "Hi", rfcMessageId: "<a@b.invalid>" });
    // Nothing writes this today, but the column is text and the recovery path
    // for this database is re-running a backfill over rows already in it.
    await env.DB.prepare("UPDATE messages SET reference_ids = 'not json' WHERE id = ?")
      .bind(id)
      .run();
    const writer = new FakeWriter();

    await createDraft(envWithWriter(env, writer), access(), { inReplyTo: id, body: "ok" });

    expect(writer.calls[0]?.request).toMatchObject({ references: ["<a@b.invalid>"] });
  });

  it("refuses to reply to a row left behind by a UIDVALIDITY change", async () => {
    // The same rows flag_message and move_message refuse. A reply built from
    // one derives its subject and threading headers from a message that is no
    // longer the one that id names.
    const id = await seedMessage({
      folder: "Archive",
      folderUidValidity: 200,
      uidValidity: 100,
      subject: "Quarterly invoice",
      rfcMessageId: "<abc@example.invalid>",
    });
    const writer = new FakeWriter();

    const outcome = await createDraft(envWithWriter(env, writer), access(), {
      inReplyTo: id,
      body: "ok",
    });

    expect(outcome.ok).toBe(false);
    expect(writer.calls).toEqual([]);
  });

  it("refuses to reply to a message that is not in the index", async () => {
    const writer = new FakeWriter();

    const outcome = await createDraft(envWithWriter(env, writer), access(), {
      inReplyTo: 4242,
      body: "ok",
    });

    expect(outcome.ok).toBe(false);
    expect(writer.calls).toEqual([]);
    expect(await auditRows()).toMatchObject([{ tool: "create_draft", outcome: "error" }]);
  });
});
