import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { ImapAuthError, ImapProtocolError, type Mailbox } from "@imap-mcp/imap";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SyncConfigError } from "../src/config";
import worker, { handleQueue, handleScheduled } from "../src/index";
import { describeError } from "../src/log";
import { CHUNK_QUEUE, DEAD_LETTER_QUEUE, type SyncChunk } from "../src/queue";
import { FakeMailbox, fakeMessage } from "./support/fake-mailbox";
import { FakeQueue } from "./support/fake-queue";

// The two entry points, and what each one does about failure. Kept apart from
// enumerate/consume for the reason #5 kept handleScheduled apart from runSync:
// the decisions worth testing here are abort-or-retry and what gets logged.

/** A cron tick, with noRetry() spied on: whether it is called is the assertion. */
function controller(): ScheduledController {
  return { cron: "0 * * * *", scheduledTime: Date.now(), noRetry: vi.fn() };
}

function syncEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, SYNC_QUEUE: new FakeQueue(), ...overrides } as unknown as Env;
}

function chunk(overrides: Partial<SyncChunk> = {}): SyncChunk {
  return {
    v: 1,
    folder: "Archive",
    folderId: 1,
    uidValidity: 100,
    from: 1,
    to: 10,
    uids: [1],
    ...overrides,
  };
}

function batchOf(bodies: unknown[], queue = CHUNK_QUEUE) {
  return createMessageBatch(
    queue,
    bodies.map((body, index) => ({
      id: `message-${index + 1}`,
      timestamp: new Date(1000),
      attempts: 1,
      body,
    })),
  );
}

async function seedFolder(name = "Archive", uidValidity = 100): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO folders (name, uidvalidity) VALUES (?, ?) RETURNING id",
  )
    .bind(name, uidValidity)
    .first<{ id: number }>();
  return row!.id;
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("the scheduled handler", () => {
  it("enumerates and logs one summary line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const queue = new FakeQueue();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1), fakeMessage(11)] });

    await handleScheduled(controller(), syncEnv({ SYNC_QUEUE: queue }), {
      connect: async () => mailbox,
    });

    const logged = log.mock.calls.map(String).join("\n");
    log.mockRestore();
    expect(logged).toContain("Archive: 2 uids, 2 ranges queued");
    expect(queue.sent).toHaveLength(2);
  });

  it("aborts an authentication failure without retrying", async () => {
    // A revoked app-specific password retried on every tick is how an Apple ID
    // gets locked, so this must not become a retry loop.
    const connect = vi.fn(async (): Promise<Mailbox> => {
      throw new ImapAuthError("IMAP authentication failed: NO [AUTHENTICATIONFAILED]");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduled = controller();

    await expect(handleScheduled(scheduled, syncEnv(), { connect })).rejects.toThrow(ImapAuthError);

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(scheduled.noRetry).toHaveBeenCalledOnce();
    expect(logged).toContain("aborting without retry");
  });

  it("aborts a missing setting without retrying", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduled = controller();
    const connect = vi.fn();

    await expect(
      handleScheduled(scheduled, syncEnv({ IMAP_HOST: undefined }), { connect }),
    ).rejects.toThrow(/IMAP_HOST is not set/);

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(connect).not.toHaveBeenCalled();
    expect(scheduled.noRetry).toHaveBeenCalledOnce();
    expect(logged).toContain("IMAP_HOST is not set");
  });

  it("lets an ordinary failure retry on the next tick", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduled = controller();
    const connect = async (): Promise<Mailbox> => {
      throw new ImapProtocolError("connection reset");
    };

    await expect(handleScheduled(scheduled, syncEnv(), { connect })).rejects.toThrow(
      ImapProtocolError,
    );

    error.mockRestore();
    expect(scheduled.noRetry).not.toHaveBeenCalled();
  });

  it("is reachable through the exported handler, and aborts the same way", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduled = controller();

    await expect(
      worker.scheduled(scheduled, syncEnv({ IMAP_USER: undefined }), createExecutionContext()),
    ).rejects.toThrow(SyncConfigError);

    error.mockRestore();
    expect(scheduled.noRetry).toHaveBeenCalledOnce();
  });
});

describe("the queue handler", () => {
  it("acks a range it stored", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    const batch = batchOf([chunk({ folderId: id })]);
    const ctx = createExecutionContext();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleQueue(batch, syncEnv(), ctx, { connect: async () => mailbox });

    log.mockRestore();
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(await count("messages")).toBe(1);
  });

  it("handles every range in a batch over one connection", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1), fakeMessage(11)] });
    const connect = vi.fn(async () => mailbox);
    const batch = batchOf([
      chunk({ folderId: id, uids: [1] }),
      chunk({ folderId: id, from: 11, to: 20, uids: [11] }),
    ]);
    const ctx = createExecutionContext();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleQueue(batch, syncEnv(), ctx, { connect });

    log.mockRestore();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(mailbox.closed).toBe(true);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["message-1", "message-2"]);
    expect(await count("messages")).toBe(2);
  });

  it("retries an ordinary failure", async () => {
    const id = await seedFolder();
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    vi.spyOn(mailbox, "fetchMessages").mockRejectedValue(new ImapProtocolError("connection reset"));
    const batch = batchOf([chunk({ folderId: id })]);
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueue(batch, syncEnv(), ctx, { connect: async () => mailbox });

    error.mockRestore();
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages).toMatchObject([{ msgId: "message-1" }]);
    expect(result.explicitAcks).toEqual([]);
  });

  it("acks the whole batch on an authentication failure, and does not retry", async () => {
    // Retrying a revoked password at queue speed, across every consumer at
    // once, is the fastest way to get an Apple ID locked. The next cron tick
    // re-enumerates once the credential is fixed, so nothing is lost.
    const connect = vi.fn(async (): Promise<Mailbox> => {
      throw new ImapAuthError("IMAP authentication failed: NO [AUTHENTICATIONFAILED]");
    });
    const batch = batchOf([chunk(), chunk({ from: 11, to: 20 })]);
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueue(batch, syncEnv(), ctx, { connect });

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(connect).toHaveBeenCalledTimes(1);
    const result = await getQueueResult(batch, ctx);
    expect(result.ackAll).toBe(true);
    expect(result.retryMessages).toEqual([]);
    expect(logged).toContain("aborting without retry");
  });

  it("acks a malformed body rather than retrying it forever", async () => {
    const batch = batchOf([{ v: 99, folder: "Archive" }]);
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const connect = vi.fn();

    await handleQueue(batch, syncEnv(), ctx, { connect });

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(connect).not.toHaveBeenCalled();
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["message-1"]);
    expect(logged).toContain("unusable queue message");
  });

  it("lets a failed connection out, so the whole batch is retried", async () => {
    // Nothing in the batch was attempted, so acking any of it would lose work.
    // Throwing is what makes the runtime redeliver the lot.
    const connect = async (): Promise<Mailbox> => {
      throw new ImapProtocolError("connection reset");
    };
    const batch = batchOf([chunk()]);
    const ctx = createExecutionContext();

    await expect(handleQueue(batch, syncEnv(), ctx, { connect })).rejects.toThrow(
      ImapProtocolError,
    );
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.ackAll).toBe(false);
  });

  it("connects only if there is something to do", async () => {
    const batch = batchOf([]);
    const ctx = createExecutionContext();
    const connect = vi.fn();

    await handleQueue(batch, syncEnv(), ctx, { connect });

    expect(connect).not.toHaveBeenCalled();
  });

  it("is reachable through the exported handler", async () => {
    const batch = batchOf([{ nonsense: true }]);
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.queue(batch, syncEnv(), ctx);

    error.mockRestore();
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(["message-1"]);
  });
});

describe("the dead-letter queue", () => {
  it("logs the folder and uid range of every batch that ran out of retries", async () => {
    const batch = batchOf([chunk({ from: 101, to: 200 }), { garbage: true }], DEAD_LETTER_QUEUE);
    const ctx = createExecutionContext();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const connect = vi.fn();

    await handleQueue(batch, syncEnv(), ctx, { connect });

    const logged = error.mock.calls.map(String).join("\n");
    error.mockRestore();
    expect(logged).toContain("dead-lettered");
    expect(logged).toContain("Archive uids 101:200");
    expect(logged).toContain("unusable queue message");
    expect(connect).not.toHaveBeenCalled();
    expect((await getQueueResult(batch, ctx)).ackAll).toBe(true);
  });
});

describe("describeError", () => {
  it("describes an error, its cause, and a thrown non-error", () => {
    const cause = new TypeError("underlying");
    expect(describeError(new ImapProtocolError("outer", cause))).toBe(
      "ImapProtocolError: outer (caused by TypeError: underlying)",
    );
    expect(describeError(new Error("no cause"))).toBe("Error: no cause");
    expect(describeError("a string somebody threw")).toBe("a string somebody threw");
  });
});

describe("the credential", () => {
  it("never reaches a log line, including error paths", async () => {
    // The app-specific password grants full mailbox access including SMTP
    // send. @imap-mcp/imap scrubs what it throws; this covers the other half —
    // anything this worker logs itself, on both the cron and the queue path.
    const password = env.IMAP_PASSWORD!;
    expect(password).toBeTruthy();

    const captured: string[] = [];
    const capture = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];

    // A successful enumeration, and a successful consumption.
    const mailbox = new FakeMailbox({ messages: [fakeMessage(1)] });
    await handleScheduled(controller(), syncEnv(), { connect: async () => mailbox });
    const id = await env.DB.prepare("SELECT id FROM folders WHERE name = 'Archive'").first<{
      id: number;
    }>();
    await handleQueue(batchOf([chunk({ folderId: id!.id })]), syncEnv(), createExecutionContext(), {
      connect: async () => mailbox,
    });

    // A protocol error carrying the credential verbatim, the way a server that
    // echoes the command it rejected would — on both entry points.
    const leaky = async (): Promise<Mailbox> => {
      throw new ImapProtocolError(`BAD Invalid command: LOGIN "ada" "${password}"`);
    };
    await handleScheduled(controller(), syncEnv(), { connect: leaky }).catch(() => {});
    await handleQueue(batchOf([chunk()]), syncEnv(), createExecutionContext(), {
      connect: leaky,
    }).catch(() => {});

    // And the whole config object, in case a future log line reaches for it.
    const { createLogger } = await import("../src/log");
    createLogger(syncEnv()).error(`config: ${JSON.stringify(syncEnv())}`);

    for (const spy of spies) spy.mockRestore();

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(password);
    }
    expect(captured.join("\n")).toContain("[redacted]");
  });
});
