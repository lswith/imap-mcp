import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAD_ID, NOT_FOUND } from "../src/message";
import { getThread, identityClosure, MAX_THREAD_IDS, MAX_THREAD_MESSAGES } from "../src/thread";
import { clearIndex, seedMessage } from "./support/seed";

const ROOT = "<root@example.invalid>";
const REPLY = "<reply@example.invalid>";
const SECOND = "<second@example.invalid>";

async function thread(id: number) {
  const outcome = await getThread(env.DB, { id });
  if (!outcome.ok) throw new Error(`expected a thread, got: ${outcome.reason}`);
  return outcome;
}

/** The three-message conversation most of these tests are about. */
async function seedConversation(): Promise<{ root: number; reply: number; second: number }> {
  const root = await seedMessage({
    subject: "Quarterly invoice",
    rfcMessageId: ROOT,
    date: "2026-03-01T09:00:00Z",
  });
  const reply = await seedMessage({
    subject: "Re: Quarterly invoice",
    rfcMessageId: REPLY,
    inReplyTo: ROOT,
    referenceIds: [ROOT],
    date: "2026-03-02T09:00:00Z",
  });
  const second = await seedMessage({
    subject: "Re: Quarterly invoice",
    rfcMessageId: SECOND,
    inReplyTo: REPLY,
    referenceIds: [ROOT, REPLY],
    date: "2026-03-03T09:00:00Z",
  });
  return { root, reply, second };
}

describe("json1 through D1", () => {
  // The header pass binds its whole identity closure as one JSON array and
  // expands it with json_each. The workerd binary carries the json1 symbols,
  // but that D1's authorizer lets a table-valued function through is not
  // something the docs say — so it is pinned here rather than assumed. If this
  // goes red on a workerd bump, the fallback is instr() per id.
  it("expands a bound JSON array with json_each", async () => {
    const { results } = await env.DB.prepare("SELECT value FROM json_each(?)")
      .bind(JSON.stringify(["<a@x>", "<b@x>"]))
      .all<{ value: string }>();

    expect(results.map((row) => row.value)).toEqual(["<a@x>", "<b@x>"]);
  });

  it("guards a malformed value with json_valid inside json_each", async () => {
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM json_each(CASE WHEN json_valid(?) THEN ? ELSE '[]' END)",
    )
      .bind("not json", "not json")
      .all<{ n: number }>();

    expect(results[0]?.n).toBe(0);
  });
});

describe("identityClosure", () => {
  it("gathers every id the seed carries, without duplicates", async () => {
    const closure = identityClosure({
      rfcMessageId: SECOND,
      inReplyTo: REPLY,
      referenceIds: JSON.stringify([ROOT, REPLY]),
    });

    expect([...closure].sort()).toEqual([ROOT, REPLY, SECOND].sort());
  });

  it("reads several ids out of one raw In-Reply-To header", async () => {
    const closure = identityClosure({
      rfcMessageId: null,
      inReplyTo: `${ROOT} ${REPLY} (from Alice)`,
      referenceIds: "[]",
    });

    expect([...closure].sort()).toEqual([ROOT, REPLY].sort());
  });

  it("ignores headers that hold no well-formed id at all", async () => {
    expect(
      identityClosure({ rfcMessageId: "", inReplyTo: "no ids here", referenceIds: "[]" }),
    ).toEqual([]);
  });

  it("ignores a reference_ids column holding JSON that is not a list of ids", async () => {
    expect(
      identityClosure({ rfcMessageId: ROOT, inReplyTo: null, referenceIds: '"a string"' }),
    ).toEqual([ROOT]);
    expect(
      identityClosure({ rfcMessageId: ROOT, inReplyTo: null, referenceIds: JSON.stringify([7]) }),
    ).toEqual([ROOT]);
  });

  it("survives a reference_ids column that is not JSON", async () => {
    expect(
      identityClosure({ rfcMessageId: ROOT, inReplyTo: null, referenceIds: "not json" }),
    ).toEqual([ROOT]);
  });

  it("caps a long References header, keeping both ends", async () => {
    const ids = Array.from({ length: 400 }, (_, n) => `<${n}@example.invalid>`);

    const closure = identityClosure({
      rfcMessageId: null,
      inReplyTo: null,
      referenceIds: JSON.stringify(ids),
    });

    expect(closure).toHaveLength(MAX_THREAD_IDS);
    // The head is the thread root, which every conformant member carries; the
    // tail is the immediate ancestry. The middle is what both ends imply.
    expect(closure[0]).toBe(ids[0]);
    expect(closure.at(-1)).toBe(ids.at(-1));
  });
});

describe("getThread", () => {
  beforeEach(clearIndex);

  it("returns the conversation oldest first, marking the message asked for", async () => {
    const { root, reply, second } = await seedConversation();

    const found = await thread(reply);

    expect(found.messages.map((message) => message.id)).toEqual([root, reply, second]);
    expect(found.basis).toBe("references");
    expect(found.seedId).toBe(reply);
    expect(found.truncated).toBe(false);
  });

  it("reaches the root and a sibling from a leaf, in one pass", async () => {
    const { root, reply, second } = await seedConversation();

    expect((await thread(second)).messages.map((message) => message.id)).toEqual([
      root,
      reply,
      second,
    ]);
  });

  it("matches a reply that only carries In-Reply-To", async () => {
    const root = await seedMessage({ rfcMessageId: ROOT, subject: "Quarterly invoice" });
    const reply = await seedMessage({
      rfcMessageId: REPLY,
      inReplyTo: `${ROOT} (from Alice)`,
      subject: "Re: Quarterly invoice",
    });

    expect((await thread(root)).messages.map((message) => message.id)).toContain(reply);
  });

  it("is not derailed by a row whose reference_ids is not JSON", async () => {
    const { root } = await seedConversation();
    await seedMessage({ subject: "unrelated", referenceIds: "not json at all" });

    expect((await thread(root)).messages).toHaveLength(3);
  });

  it("groups only what the headers name, not what merely shares a subject", async () => {
    const { root } = await seedConversation();
    const decoy = await seedMessage({
      subject: "Re: Quarterly invoice",
      date: "2026-03-02T12:00:00Z",
    });

    const found = await thread(root);

    expect(found.messages.map((message) => message.id)).not.toContain(decoy);
    expect(found.basis).toBe("references");
  });

  it("returns every folder's copy of a message rather than collapsing them", async () => {
    const inbox = await seedMessage({
      folder: "INBOX",
      uid: 1,
      rfcMessageId: ROOT,
      subject: "Quarterly invoice",
    });
    const archive = await seedMessage({
      folder: "Archive",
      uid: 1,
      rfcMessageId: ROOT,
      subject: "Quarterly invoice",
    });

    const found = await thread(inbox);

    expect(found.messages.map((message) => message.id).sort()).toEqual([inbox, archive].sort());
    expect(found.messages.map((message) => message.folder).sort()).toEqual(["Archive", "INBOX"]);
  });

  it("excludes a row left behind by a UIDVALIDITY change", async () => {
    const current = await seedMessage({
      folder: "Archive",
      folderUidValidity: 200,
      uidValidity: 200,
      rfcMessageId: ROOT,
      subject: "Quarterly invoice",
    });
    const stale = await seedMessage({
      folder: "Archive",
      folderUidValidity: 200,
      uidValidity: 100,
      rfcMessageId: REPLY,
      referenceIds: [ROOT],
      subject: "Re: Quarterly invoice",
    });

    expect((await thread(current)).messages.map((message) => message.id)).toEqual([current]);
    expect(stale).toBeGreaterThan(0);
  });

  it("keeps the newest of an oversized thread, and says it did", async () => {
    const ids: number[] = [];
    for (let n = 0; n < MAX_THREAD_MESSAGES + 10; n++) {
      ids.push(
        await seedMessage({
          rfcMessageId: `<${n}@example.invalid>`,
          referenceIds: [ROOT],
          subject: "Quarterly invoice",
          internalDate: Date.parse("2026-03-01T00:00:00Z") + n * 60_000,
        }),
      );
    }

    const found = await thread(ids[0] as number);

    expect(found.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(found.truncated).toBe(true);
    // The message asked for survives the cap even when it is the oldest.
    expect(found.messages.map((message) => message.id)).toContain(ids[0]);
    expect(found.messages.map((message) => message.id)).toContain(ids.at(-1));
  });

  describe("mail whose headers link nothing", () => {
    // There was a subject fallback here: same normalised subject, within thirty
    // days, when the reference headers found nothing. It is gone deliberately.
    // It could not be made correct — no SQL predicate is normaliseSubject, so
    // the scan always admitted subjects the exact check rejected, and five
    // rounds of narrowing it only moved which subjects those were. And what it
    // bought was a guess that had to label itself a guess. Returning the one
    // message that was actually asked for is the honest answer.
    it("does not group two messages merely because their subjects match", async () => {
      const first = await seedMessage({ subject: "Report from operations" });
      await seedMessage({ subject: "Re: Report from operations" });

      const found = await thread(first);

      expect(found.messages.map((message) => message.id)).toEqual([first]);
      expect(found.basis).toBe("alone");
    });

    it("answers with the seed alone for a message carrying no ids at all", async () => {
      const first = await seedMessage({ subject: "Report from operations" });

      const found = await thread(first);

      expect(found.messages).toHaveLength(1);
      expect(found.truncated).toBe(false);
    });
  });

  it("refuses an id that is not a positive whole number before touching D1", async () => {
    await expect(getThread(env.DB, { id: 0 })).resolves.toMatchObject({
      ok: false,
      reason: BAD_ID,
    });
  });

  it("refuses an unknown seed in the same words get_message uses", async () => {
    const outcome = await getThread(env.DB, { id: 4212 });

    expect(outcome).toMatchObject({ ok: false, reason: NOT_FOUND });
  });

  describe("without a network", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", () => {
        throw new Error("this tool must not reach the network");
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("answers from D1 alone", async () => {
      const { root } = await seedConversation();

      expect((await thread(root)).messages).toHaveLength(3);
    });
  });
});
