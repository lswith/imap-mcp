import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEnumerate } from "../src/enumerate";
import type { SyncChunk } from "../src/queue";
import { FakeMailbox, fakeMessage } from "./support/fake-mailbox";
import { FakeQueue } from "./support/fake-queue";

// Enumeration is the cron half of #6: list uids, work out which uid buckets are
// not fully indexed yet, and post those ranges to a queue. It runs against the
// real D1 binding inside workerd — the gap detection is a SQL query, so a
// fixture would be testing the wrong thing — with a fake Mailbox and a fake
// queue. Test defaults use buckets of ten uids, set in vitest.config.ts.

function syncEnv(queue: FakeQueue, overrides: Partial<Env> = {}): Env {
  return { ...env, SYNC_QUEUE: queue, ...overrides } as unknown as Env;
}

type FolderRow = {
  id: number;
  uidValidity: number;
  lastSyncedUid: number;
  lastSyncedAt: number | null;
};

async function folderRow(name = "Archive"): Promise<FolderRow | null> {
  return env.DB.prepare(
    `SELECT id, uidvalidity AS uidValidity, last_synced_uid AS lastSyncedUid,
            last_synced_at AS lastSyncedAt
     FROM folders WHERE name = ?`,
  )
    .bind(name)
    .first<FolderRow>();
}

/** Pretends a previous run already indexed these uids. */
async function alreadyIndexed(folderId: number, uidValidity: number, uids: number[]) {
  for (const uid of uids) {
    await env.DB.prepare(
      `INSERT INTO messages (folder_id, uidvalidity, uid, subject, internal_date)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(folderId, uidValidity, uid, `Message ${uid}`, 1_700_000_000_000)
      .run();
  }
}

function ranges(chunks: SyncChunk[]): string[] {
  return chunks.map((chunk) => `${chunk.folder} ${chunk.from}:${chunk.to}`);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("enumeration", () => {
  it("posts one message per uid bucket, carrying the uids that exist in it", async () => {
    const mailbox = new FakeMailbox({
      uidValidity: 4242,
      messages: [fakeMessage(1), fakeMessage(2), fakeMessage(11), fakeMessage(25)],
    });
    const queue = new FakeQueue();

    const result = await runEnumerate(syncEnv(queue), { connect: async () => mailbox });

    const folder = await folderRow();
    const common = { v: 1 as const, folder: "Archive", folderId: folder!.id, uidValidity: 4242 };
    expect(queue.sent).toEqual<SyncChunk[]>([
      { ...common, from: 1, to: 10, uids: [1, 2] },
      { ...common, from: 11, to: 20, uids: [11] },
      { ...common, from: 21, to: 30, uids: [25] },
    ]);
    expect(result.enqueued).toBe(3);
    // Identifiers only: enumeration never fetches a body.
    expect(mailbox.fetches).toEqual([]);
  });

  it("enumerates by uid range and date only — never by content or size", async () => {
    // The spike found LARGER/SMALLER and every string criterion unusable on
    // iCloud. This test is the guard: a future content search fails it.
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });

    await runEnumerate(syncEnv(new FakeQueue(), { SYNC_SINCE: "2022-03-01" }), {
      connect: async () => mailbox,
    });

    expect(mailbox.searches.length).toBeGreaterThan(0);
    for (const criteria of mailbox.searches) {
      expect(Object.keys(criteria).sort()).toEqual(["since", "uids"]);
      expect(criteria.uids).toMatchObject({ from: expect.any(Number), to: expect.any(Number) });
      expect(criteria.since).toEqual(new Date("2022-03-01"));
    }
  });

  it("skips buckets already fully indexed, and re-posts one that is short", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => fakeMessage(index + 1));
    const mailbox = new FakeMailbox({ messages });
    const queue = new FakeQueue();

    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });
    const folder = await folderRow();
    // Bucket 0 complete, bucket 1 half done, bucket 2 untouched.
    await alreadyIndexed(folder!.id, 100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    await runEnumerate(syncEnv(queue), { connect: async () => mailbox });

    expect(ranges(queue.sent)).toEqual(["Archive 11:20", "Archive 21:30"]);
  });

  it("enqueues nothing once every bucket is complete", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => fakeMessage(index + 1));
    const mailbox = new FakeMailbox({ messages });

    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });
    const folder = await folderRow();
    await alreadyIndexed(
      folder!.id,
      100,
      messages.map((message) => message.uid),
    );

    const queue = new FakeQueue();
    const result = await runEnumerate(syncEnv(queue), { connect: async () => mailbox });

    expect(queue.sent).toEqual([]);
    expect(result.enqueued).toBe(0);
  });

  it("walks the folder in uid windows rather than one SEARCH over all of it", async () => {
    const mailbox = new FakeMailbox({
      messages: [fakeMessage(1), fakeMessage(15), fakeMessage(25)],
    });

    await runEnumerate(syncEnv(new FakeQueue(), { SYNC_ENUMERATE_WINDOW: "10" }), {
      connect: async () => mailbox,
    });

    expect(mailbox.searches.map((criteria) => criteria.uids)).toEqual([
      { from: 1, to: 10 },
      { from: 11, to: 20 },
      { from: 21, to: 30 },
    ]);
  });

  it("stops at the per-run ceiling instead of enqueuing the whole folder", async () => {
    const messages = Array.from({ length: 50 }, (_, index) => fakeMessage(index + 1));
    const mailbox = new FakeMailbox({ messages });
    const queue = new FakeQueue();

    await runEnumerate(syncEnv(queue, { SYNC_MAX_CHUNKS_PER_RUN: "2" }), {
      connect: async () => mailbox,
    });

    expect(ranges(queue.sent)).toEqual(["Archive 1:10", "Archive 11:20"]);
  });

  it("shares the per-run ceiling across folders so the first cannot starve the rest", async () => {
    const mailbox = new FakeMailbox({
      folders: [
        {
          name: "Archive",
          messages: Array.from({ length: 50 }, (_, index) => fakeMessage(index + 1)),
        },
        { name: "Sent", uidValidity: 7, messages: [fakeMessage(1), fakeMessage(11)] },
      ],
    });
    const queue = new FakeQueue();

    await runEnumerate(
      syncEnv(queue, { SYNC_FOLDERS: "Archive, Sent", SYNC_MAX_CHUNKS_PER_RUN: "4" }),
      {
        connect: async () => mailbox,
      },
    );

    expect(ranges(queue.sent)).toEqual([
      "Archive 1:10",
      "Archive 11:20",
      "Sent 1:10",
      "Sent 11:20",
    ]);
    expect(queue.sent.at(-1)).toMatchObject({ folder: "Sent", uidValidity: 7 });
  });

  it("records the watermark as the last uid before the first gap, not the last enqueued", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => fakeMessage(index + 1));
    const mailbox = new FakeMailbox({ messages });

    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });
    expect((await folderRow())!.lastSyncedUid).toBe(0);

    const folder = await folderRow();
    await alreadyIndexed(folder!.id, 100, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });

    const after = await folderRow();
    expect(after!.lastSyncedUid).toBe(10);
    expect(after!.lastSyncedAt).toBeGreaterThan(0);
  });

  it("selects read-only and closes the connection", async () => {
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });

    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });

    expect(mailbox.selects).toEqual([{ name: "Archive", readOnly: true }]);
    expect(mailbox.closed).toBe(true);
  });

  it("reports a failure to close without losing the work that came before it", async () => {
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    vi.spyOn(mailbox, "close").mockRejectedValue(new Error("socket already gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = new FakeQueue();

    await runEnumerate(syncEnv(queue), { connect: async () => mailbox });

    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();
    expect(warnings).toContain("closing the mailbox failed");
    expect(ranges(queue.sent)).toEqual(["Archive 1:10"]);
  });

  it("uses one connection for every configured folder", async () => {
    const mailbox = new FakeMailbox({
      folders: [
        { name: "Archive", messages: [fakeMessage(1)] },
        { name: "Sent", messages: [fakeMessage(1)] },
      ],
    });
    const connect = vi.fn(async () => mailbox);

    await runEnumerate(syncEnv(new FakeQueue(), { SYNC_FOLDERS: "Archive,Sent" }), { connect });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(mailbox.selects.map((select) => select.name)).toEqual(["Archive", "Sent"]);
  });

  it("does nothing to an empty folder, but still records it", async () => {
    const mailbox = new FakeMailbox({ messages: [] });
    const queue = new FakeQueue();

    const result = await runEnumerate(syncEnv(queue), { connect: async () => mailbox });

    expect(queue.sent).toEqual([]);
    expect(mailbox.searches).toEqual([]);
    expect(result.folders).toMatchObject([{ folder: "Archive", exists: 0, enqueued: 0 }]);
    expect(await folderRow()).toMatchObject({ uidValidity: 100 });
  });

  it("keeps rows apart when UIDVALIDITY changes, and drops the watermark", async () => {
    const mailbox = new FakeMailbox({ uidValidity: 100, messages: [fakeMessage(1)] });
    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });
    const folder = await folderRow();
    await alreadyIndexed(folder!.id, 100, [1]);
    await runEnumerate(syncEnv(new FakeQueue()), { connect: async () => mailbox });
    expect((await folderRow())!.lastSyncedUid).toBe(1);

    mailbox.setUidValidity(101);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = new FakeQueue();
    await runEnumerate(syncEnv(queue), { connect: async () => mailbox });
    const warnings = warn.mock.calls.map(String).join("\n");
    warn.mockRestore();

    expect(warnings).toContain("UIDVALIDITY changed");
    // The old rows are stale, so the same uid is enqueued again under the new
    // value, and the watermark no longer counts them.
    expect(queue.sent).toMatchObject([{ uidValidity: 101, from: 1, to: 10, uids: [1] }]);
    expect((await folderRow())!.lastSyncedUid).toBe(0);
  });

  it("attempts every folder when one of them fails, and still fails the run", async () => {
    // A folder renamed in the mail client should not stop the others indexing
    // — but a folder that is permanently wrong should show up as a red tick
    // rather than as a quiet gap in the index.
    const mailbox = new FakeMailbox({ folders: [{ name: "Archive", messages: [fakeMessage(1)] }] });
    const queue = new FakeQueue();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runEnumerate(syncEnv(queue, { SYNC_FOLDERS: "Nonexistent,Archive" }), {
        connect: async () => mailbox,
      }),
    ).rejects.toThrow(/Nonexistent/);

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(logged).toContain("Nonexistent: enumeration failed");
    expect(ranges(queue.sent)).toEqual(["Archive 1:10"]);
  });
});

describe("enumeration configuration", () => {
  it("refuses a nonsense bound rather than enumerating an arbitrary number", async () => {
    const queue = new FakeQueue();
    await expect(runEnumerate(syncEnv(queue, { SYNC_CHUNK_UIDS: "hunter2" }), {})).rejects.toThrow(
      /^SYNC_CHUNK_UIDS must be an integer between 1 and 100000$/,
    );
    await expect(runEnumerate(syncEnv(queue, { SYNC_SINCE: "not a date" }), {})).rejects.toThrow(
      /^SYNC_SINCE must be an ISO date$/,
    );
    await expect(runEnumerate(syncEnv(queue, { SYNC_FOLDERS: " , " }), {})).rejects.toThrow(
      /^SYNC_FOLDERS is not set$/,
    );
  });
});
