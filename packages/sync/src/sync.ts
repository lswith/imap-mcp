/**
 * The tracer: connect, select one folder, fetch a bounded UID range, normalise,
 * store (#5).
 *
 * This is the first complete path through the system and deliberately the
 * simplest one. There is no queue — fan-out is #6 — and no incremental
 * enumeration — watermarks and UIDVALIDITY recovery are #8. Keeping those
 * apart means a failure in this path is unambiguous: it is the mailbox, the
 * parse, or the write, and nothing else.
 *
 * Every fetch is non-mutating. The Mailbox interface has no way to fetch
 * without PEEK, so indexing cannot mark mail as read even by mistake.
 */

import { connectMailbox, type Mailbox, type MailboxMessage } from "@imap-mcp/imap";
import { readSyncConfig, type SyncConfig } from "./config";
import { createLogger, describeError, type Logger } from "./log";
import { toMessageRow } from "./normalise";
import { recordSyncWatermark, resetSyncWatermark, upsertFolder, upsertMessages } from "./store";

export type SyncResult = {
  folder: string;
  uidValidity: number;
  /** Messages the folder holds, from EXISTS. */
  exists: number;
  /** UIDs found in the window. */
  scanned: number;
  /** Rows written. */
  stored: number;
  /** The highest uid stored, which is what the watermark records. */
  highestUid: number;
  durationMs: number;
};

export type SyncDeps = {
  connect?: (config: SyncConfig) => Promise<Mailbox>;
  log?: Logger;
};

/**
 * `connect` is a seam for tests, which drive a fake Mailbox.
 *
 * The real protocol is covered where it belongs — packages/imap runs the
 * genuine cf-imap client against a scripted IMAP server — and that harness
 * aliases `cloudflare:sockets`, which cannot be done inside workerd, where
 * these tests have to run to reach D1.
 */
export async function runSync(env: Env, deps: SyncDeps = {}): Promise<SyncResult> {
  const startedAt = Date.now();
  const log = deps.log ?? createLogger(env);
  const config = readSyncConfig(env);
  const connect = deps.connect ?? defaultConnect;

  const mailbox = await connect(config);
  try {
    // EXAMINE rather than SELECT: read-only at the protocol level, so this
    // worker cannot change anything about the folder it is indexing.
    const state = await mailbox.selectFolder(config.folder, { readOnly: true });
    const uidValidity = state.uidValidity ?? 0;
    const folder = await upsertFolder(db(env), state);

    if (folder.previousUidValidity !== null && folder.previousUidValidity !== uidValidity) {
      // Loud, because every uid recorded under the old value now means
      // something else. #8 owns the re-sync; all this run does is refuse to
      // carry a watermark across the discontinuity.
      log.warn(
        `${config.folder}: UIDVALIDITY changed from ${folder.previousUidValidity} to ` +
          `${uidValidity} — previously indexed uids are stale until a full re-sync (#8)`,
      );
      await resetSyncWatermark(db(env), folder.id);
    }

    if (state.exists === 0) {
      log.info(`${config.folder}: empty, nothing to sync`);
      return result(config, uidValidity, state.exists, [], 0, startedAt);
    }

    // The window: UIDs 1..batchSize, where a full backfill would start. SEARCH
    // resolves it to the uids that actually exist, so the fetch can be split
    // into chunks — a range ending in "*" cannot be — and so the log line says
    // how many messages were really in range rather than how wide the range
    // was.
    const uids = (await mailbox.search({ uids: { from: 1, to: config.batchSize } })).sort(
      (a, b) => a - b,
    );
    log.info(
      `${config.folder}: uidvalidity ${uidValidity}, ${state.exists} messages, ` +
        `${uids.length} in uids 1:${config.batchSize}`,
    );
    if (uids.length === 0) {
      return result(config, uidValidity, state.exists, [], 0, startedAt);
    }

    let stored = 0;
    for (const chunk of chunks(uids, config.chunkSize)) {
      // Chunked rather than fetched in one command: a message can carry tens
      // of megabytes of attachments, all of which are decoded into memory by
      // the parse, and a worker has ~128 MB. Peak memory is bounded by the
      // chunk size rather than by the size of the window.
      const messages = await mailbox.fetchMessages({ uids: chunk, includeBody: true });
      const rows = await Promise.all(
        messages.map((message: MailboxMessage) => toMessageRow(message, folder.id, uidValidity)),
      );
      stored += await upsertMessages(db(env), rows, Date.now());
    }

    const highestUid = uids[uids.length - 1];
    await recordSyncWatermark(db(env), folder.id, highestUid, Date.now());

    return result(config, uidValidity, state.exists, uids, stored, startedAt);
  } finally {
    // Guarded: a failure closing the connection must not replace the error
    // that is on its way out of here.
    try {
      await mailbox.close();
    } catch (error) {
      log.warn(`closing the mailbox failed: ${describeError(error)}`);
    }
  }
}

/** A one-line summary, safe to log: counts and names, never message content. */
export function summarise(result: SyncResult): string {
  return (
    `${result.folder}: stored ${result.stored} of ${result.scanned} messages ` +
    `(uidvalidity ${result.uidValidity}, highest uid ${result.highestUid}) in ${result.durationMs}ms`
  );
}

function defaultConnect(config: SyncConfig): Promise<Mailbox> {
  return connectMailbox({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    // No `enable: ["CONDSTORE"]`: nothing in this slice reads a mod-sequence,
    // and ENABLE is connection configuration that #8 will want set here when
    // it does.
  });
}

function db(env: Env): D1Database {
  return env.DB;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

function result(
  config: SyncConfig,
  uidValidity: number,
  exists: number,
  uids: readonly number[],
  stored: number,
  startedAt: number,
): SyncResult {
  return {
    folder: config.folder,
    uidValidity,
    exists,
    scanned: uids.length,
    stored,
    highestUid: uids.length > 0 ? uids[uids.length - 1] : 0,
    durationMs: Date.now() - startedAt,
  };
}
