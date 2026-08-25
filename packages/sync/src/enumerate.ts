/**
 * Enumeration: the cron half of the sync path (#6).
 *
 * It lists identifiers and posts work. It never fetches a body — that is the
 * consumer's job, one uid range per invocation, so no single invocation has to
 * hold a mailbox's worth of mail inside a Worker's wall clock and memory.
 *
 * What it enqueues is decided by GAP DETECTION rather than by a cursor: one
 * query asks D1 which uid buckets are already fully indexed, and only the rest
 * go on the queue, capped per run. Three things follow from that, and they are
 * the reason it is worth the query:
 *
 *   - A folder converges. Each run enqueues what is still missing, so a large
 *     backfill completes over several cron ticks and then goes quiet, instead
 *     of re-fetching everything hourly for ever.
 *   - A range that dead-letters is picked up again next run. A cursor would
 *     step over it permanently.
 *   - The sync watermark (#8) stays honest. Ranges complete out of order under
 *     fan-out, so "highest uid stored" would claim more than is true; the
 *     highest uid below the first gap does not.
 *
 * SEARCH is used for uid ranges and dates only. A spike found `LARGER` matching
 * everything, `SMALLER` matching nothing, and every string criterion returning
 * no hits against a real iCloud folder — including `FROM "@"`, which must match
 * all mail. Whether that is iCloud or cf-imap was never isolated, and this
 * design does not depend on the answer.
 */

import { MAX_UID, type Mailbox, type SearchCriteria } from "@imap-mcp/imap";
import { readSyncConfig, type SyncConfig } from "./config";
import { createLogger, describeError, type Logger } from "./log";
import { bucketOf, bucketRange, type ChunkProducer, type SyncChunk } from "./queue";
import { type SyncDeps, withMailbox } from "./session";
import { indexedBuckets, recordSyncWatermark, resetSyncWatermark, upsertFolder } from "./store";

/**
 * How many chunks go into one sendBatch call.
 *
 * A batch is capped at 100 messages and 256 KB. At the default of 100 uids per
 * chunk a body is well under a kilobyte, so this leaves room for a deployer who
 * raises SYNC_CHUNK_UIDS considerably without having to think about it.
 */
const SEND_BATCH_SIZE = 50;

type FolderEnumeration = {
  folder: string;
  uidValidity: number;
  /** Messages the folder holds, from EXISTS. */
  exists: number;
  /** Uids seen in the windows this run walked. */
  scanned: number;
  /** Ranges posted to the queue. */
  enqueued: number;
  /** The highest uid below the first incomplete bucket. */
  watermark: number;
};

export type EnumerateResult = {
  folders: FolderEnumeration[];
  enqueued: number;
  durationMs: number;
};

export async function runEnumerate(env: Env, deps: SyncDeps = {}): Promise<EnumerateResult> {
  const startedAt = Date.now();
  const log = deps.log ?? createLogger(env);
  const config = readSyncConfig(env);
  const queue = env.SYNC_QUEUE as ChunkProducer;

  // Evenly divided rather than first-come: without this a folder mid-backfill
  // would spend the whole ceiling every run and the others would never start.
  const share = Math.max(1, Math.floor(config.maxChunksPerRun / config.folders.length));

  const folders: FolderEnumeration[] = [];
  let failure: unknown;

  await withMailbox(config, deps, log, async (mailbox) => {
    for (const name of config.folders) {
      try {
        folders.push(await enumerateFolder(env, mailbox, queue, config, log, name, share));
      } catch (error) {
        // Every folder is attempted — one renamed folder should not stop the
        // others indexing — but the run still ends in failure, so a folder
        // that is permanently wrong shows up as a red tick rather than as a
        // quiet gap in the index.
        log.error(`${name}: enumeration failed: ${describeError(error)}`);
        failure ??= error;
      }
    }
  });

  if (failure) throw failure;

  return {
    folders,
    enqueued: folders.reduce((total, folder) => total + folder.enqueued, 0),
    durationMs: Date.now() - startedAt,
  };
}

async function enumerateFolder(
  env: Env,
  mailbox: Mailbox,
  queue: ChunkProducer,
  config: SyncConfig,
  log: Logger,
  name: string,
  budget: number,
): Promise<FolderEnumeration> {
  // EXAMINE rather than SELECT: read-only at the protocol level, so this worker
  // cannot change anything about the folder it is indexing.
  const state = await mailbox.selectFolder(name, { readOnly: true });
  const uidValidity = state.uidValidity ?? 0;
  const folder = await upsertFolder(env.DB, state);

  if (folder.previousUidValidity !== null && folder.previousUidValidity !== uidValidity) {
    // Loud, because every uid recorded under the old value now means something
    // else. #8 owns the re-sync; what this run does is refuse to carry a
    // watermark across the discontinuity — and, because gap detection counts
    // only rows under the new uidvalidity, re-enqueue the folder from scratch.
    log.warn(
      `${name}: UIDVALIDITY changed from ${folder.previousUidValidity} to ${uidValidity} — ` +
        `previously indexed uids are stale until a full re-sync (#8)`,
    );
    await resetSyncWatermark(env.DB, folder.id);
  }

  const enumeration: FolderEnumeration = {
    folder: name,
    uidValidity,
    exists: state.exists,
    scanned: 0,
    enqueued: 0,
    watermark: 0,
  };

  if (state.exists === 0) {
    await recordSyncWatermark(env.DB, folder.id, 0, Date.now());
    return enumeration;
  }

  const indexed = await indexedBuckets(env.DB, folder.id, uidValidity, config.chunkUids);
  const highestUid = state.uidNext ?? MAX_UID;
  const pending: SyncChunk[] = [];
  let sawGap = false;

  for (let from = 1; from <= highestUid && enumeration.scanned < state.exists; ) {
    const to = Math.min(from + config.enumerateWindow - 1, MAX_UID);
    const uids = (await mailbox.search(window(from, to, config))).sort((a, b) => a - b);
    enumeration.scanned += uids.length;

    let budgetSpent = false;
    for (const [bucket, members] of byBucket(uids, config.chunkUids)) {
      const complete = (indexed.get(bucket) ?? 0) >= members.length;

      // The watermark is the last uid before the first hole, so it can be read
      // as "everything below this is indexed" — which is what #8 will want.
      if (!sawGap) {
        if (complete) enumeration.watermark = members[members.length - 1];
        else sawGap = true;
      }
      if (complete) continue;

      if (enumeration.enqueued >= budget) {
        budgetSpent = true;
        break;
      }
      const range = bucketRange(bucket, config.chunkUids);
      pending.push({
        v: 1,
        folder: name,
        folderId: folder.id,
        uidValidity,
        from: range.from,
        to: range.to,
        uids: members,
      });
      enumeration.enqueued += 1;
      if (pending.length >= SEND_BATCH_SIZE) await flush(queue, pending);
    }

    if (budgetSpent) break;
    if (to === MAX_UID) break;
    from = to + 1;
  }

  await flush(queue, pending);
  await recordSyncWatermark(env.DB, folder.id, enumeration.watermark, Date.now());
  return enumeration;
}

/**
 * The enumeration window.
 *
 * Uid range, and a date when one is configured. Nothing else is ever added
 * here — see the note at the top of this file.
 */
function window(from: number, to: number, config: SyncConfig): SearchCriteria {
  const criteria: SearchCriteria = { uids: { from, to } };
  if (config.since) criteria.since = config.since;
  return criteria;
}

/** Ascending buckets, each holding the uids that actually exist inside it. */
function byBucket(uids: readonly number[], size: number): Map<number, number[]> {
  const buckets = new Map<number, number[]>();
  for (const uid of uids) {
    const bucket = bucketOf(uid, size);
    const members = buckets.get(bucket);
    if (members) members.push(uid);
    else buckets.set(bucket, [uid]);
  }
  return buckets;
}

async function flush(queue: ChunkProducer, pending: SyncChunk[]): Promise<void> {
  if (pending.length === 0) return;
  await queue.sendBatch(pending.map((body) => ({ body })));
  pending.length = 0;
}

/** A one-line summary, safe to log: counts and names, never message content. */
export function summariseEnumeration(result: EnumerateResult): string {
  const folders = result.folders
    .map(
      (folder) =>
        `${folder.folder}: ${folder.scanned} uids, ${folder.enqueued} ranges queued ` +
        `(uidvalidity ${folder.uidValidity}, watermark ${folder.watermark})`,
    )
    .join("; ");
  return `${folders} — ${result.enqueued} ranges in ${result.durationMs}ms`;
}
