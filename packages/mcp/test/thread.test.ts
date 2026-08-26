import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAD_ID, NOT_FOUND } from "../src/message";
import {
  getThread,
  identityClosure,
  MAX_THREAD_IDS,
  MAX_THREAD_MESSAGES,
  normaliseSubject,
  SUBJECT_CANDIDATES,
  SUBJECT_WINDOW_MS,
} from "../src/thread";
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

describe("normaliseSubject", () => {
  it("collapses every reply and forward prefix onto one key", async () => {
    const forms = [
      "Quarterly invoice",
      "Re: Quarterly invoice",
      "RE: Quarterly invoice",
      "Fwd: Quarterly invoice",
      "FW: Quarterly invoice",
      "AW: Quarterly invoice",
      "Re: Fwd: Re: Quarterly invoice",
      "Re[2]: Quarterly invoice",
      "  re :  Quarterly   invoice  ",
    ];

    expect(new Set(forms.map(normaliseSubject)).size).toBe(1);
  });

  it("leaves a subject that only looks like a prefix alone", async () => {
    expect(normaliseSubject("Reference numbers")).toBe("reference numbers");
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

  it("does not fall back to subjects when the headers answered", async () => {
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

  describe("the subject fallback", () => {
    it("groups a reply that carries no reference headers at all", async () => {
      const first = await seedMessage({
        subject: "Report from operations",
        date: "2026-03-01T09:00:00Z",
      });
      const reply = await seedMessage({
        subject: "Re: Report from operations",
        date: "2026-03-05T09:00:00Z",
      });

      const found = await thread(first);

      expect(found.messages.map((message) => message.id)).toEqual([first, reply]);
      expect(found.basis).toBe("subject");
    });

    it("does not reach past its window", async () => {
      const first = await seedMessage({
        subject: "Report from operations",
        internalDate: Date.parse("2026-03-01T09:00:00Z"),
      });
      await seedMessage({
        subject: "Re: Report from operations",
        internalDate: Date.parse("2026-03-01T09:00:00Z") + SUBJECT_WINDOW_MS + 60_000,
      });

      const found = await thread(first);

      expect(found.messages).toHaveLength(1);
      expect(found.basis).toBe("alone");
    });

    it("does not run at all on a subject too short to mean anything", async () => {
      const first = await seedMessage({ subject: "Hi" });
      await seedMessage({ subject: "Re: Hi" });

      expect((await thread(first)).basis).toBe("alone");
    });

    it("rejects a subject SQL matched but that is not the same subject", async () => {
      const first = await seedMessage({ subject: "Q3 invoice review" });
      const decoy = await seedMessage({ subject: "Q3 invoice review meeting notes" });

      const found = await thread(first);

      expect(found.messages.map((message) => message.id)).not.toContain(decoy);
      expect(found.basis).toBe("alone");
    });

    it("is not starved of real matches by messages that merely contain the subject", async () => {
      // The prefilter is a superset test and the exact check happens in
      // TypeScript, so anything the SQL limit cuts is decided before it is
      // judged. A daily digest whose subject carries the seed's as a prefix
      // must not be able to push the genuine reply out of the candidate set.
      const at = Date.parse("2026-03-10T09:00:00Z");
      const first = await seedMessage({ subject: "Report from operations", internalDate: at });
      const reply = await seedMessage({
        subject: "Re: Report from operations",
        internalDate: at - 60_000,
      });
      for (let n = 0; n < MAX_THREAD_MESSAGES + 10; n++) {
        await seedMessage({
          subject: `Report from operations — daily digest ${n}`,
          internalDate: at + (n + 1) * 60_000,
        });
      }

      const found = await thread(first);

      expect(found.messages.map((message) => message.id)).toEqual([reply, first]);
      expect(found.basis).toBe("subject");
    });

    it("says so when the prefilter itself ran out of room", async () => {
      // Distinct from the result cap being reached: rows were dropped before
      // anything judged them, so members may be missing that would have been
      // kept. The caller is told rather than left to assume completeness.
      const at = Date.parse("2026-03-10T09:00:00Z");
      const first = await seedMessage({ subject: "Report from operations", internalDate: at });
      for (let n = 0; n < SUBJECT_CANDIDATES; n++) {
        await seedMessage({
          subject: "Re: Report from operations",
          internalDate: at + (n + 1) * 60_000,
        });
      }

      const found = await thread(first);

      expect(found.truncated).toBe(true);
      expect(found.messages).toHaveLength(MAX_THREAD_MESSAGES);
    });

    it("runs for a seed carrying no Message-ID and no references", async () => {
      const first = await seedMessage({ subject: "Report from operations" });
      const reply = await seedMessage({ subject: "Fwd: Report from operations" });

      expect((await thread(first)).messages.map((message) => message.id)).toEqual([first, reply]);
    });

    it("degrades to alone rather than to nonsense when internal_date is the epoch", async () => {
      // internalDateOf() falls back to 0 when a message has no usable date, so
      // the window covers December 1969 and matches nothing. That is the right
      // failure: no conversation rather than an arbitrary one.
      const first = await seedMessage({ subject: "Report from operations", internalDate: 0 });
      await seedMessage({
        subject: "Re: Report from operations",
        date: "2026-03-05T09:00:00Z",
      });

      expect((await thread(first)).basis).toBe("alone");
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
