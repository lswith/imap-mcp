/**
 * The D1 writes.
 *
 * Every message write is an upsert on (folder_id, uidvalidity, uid). That is
 * not defensiveness — it is the contract the rest of the system is built on.
 * Queue delivery (#6) is at-least-once, so no consumer may assume it runs
 * exactly once, and the recovery path for this database is re-running the
 * backfill (#13) over rows that are already there.
 */

import type { FolderState } from "@imap-mcp/imap";
import type { MessageRow } from "./normalise";

/**
 * How many messages go into one `batch()`.
 *
 * A batch is a single implicit transaction, so this also bounds how much work
 * a failure mid-run throws away.
 */
const WRITE_BATCH_SIZE = 20;

const UPSERT_FOLDER = `
  INSERT INTO folders (name, delimiter, attributes, uidvalidity, uid_next, highest_modseq)
  VALUES (?, '', '[]', ?, ?, ?)
  ON CONFLICT (name) DO UPDATE SET
    uidvalidity = excluded.uidvalidity,
    uid_next = excluded.uid_next,
    highest_modseq = excluded.highest_modseq
  RETURNING id`;

const UPSERT_MESSAGE = `
  INSERT INTO messages (folder_id, uidvalidity, uid, rfc_message_id, in_reply_to,
                        reference_ids, subject, from_address, from_addresses,
                        to_addresses, cc_addresses, internal_date, sent_date,
                        size_bytes, flags, body_text, has_attachments, synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (folder_id, uidvalidity, uid) DO UPDATE SET
    rfc_message_id = excluded.rfc_message_id,
    in_reply_to = excluded.in_reply_to,
    reference_ids = excluded.reference_ids,
    subject = excluded.subject,
    from_address = excluded.from_address,
    from_addresses = excluded.from_addresses,
    to_addresses = excluded.to_addresses,
    cc_addresses = excluded.cc_addresses,
    internal_date = excluded.internal_date,
    sent_date = excluded.sent_date,
    size_bytes = excluded.size_bytes,
    flags = excluded.flags,
    body_text = excluded.body_text,
    has_attachments = excluded.has_attachments,
    synced_at = excluded.synced_at`;

export type FolderRecord = {
  id: number;
  /**
   * The UIDVALIDITY this folder was last seen with, before this run wrote the
   * one it just observed. Null the first time the folder is synced.
   */
  previousUidValidity: number | null;
  /**
   * The watermark the previous run left: everything at or below this uid is
   * indexed under `previousUidValidity`. Zero for a folder never synced — and
   * meaningless, therefore not to be resumed from, when the UIDVALIDITY above
   * has changed.
   */
  watermark: number;
};

/**
 * Records the folder, and returns its id along with what the last run left.
 *
 * The watermark rides back from the same statement that reads the previous
 * UIDVALIDITY, so resuming (#8) costs no extra query. A changed UIDVALIDITY is
 * reported rather than acted on: every uid recorded against the old value is
 * meaningless and the folder needs re-syncing from scratch. Nothing breaks in
 * the meantime because messages carry their own uidvalidity — new rows sit
 * alongside the stale ones instead of colliding with them.
 */
export async function upsertFolder(db: D1Database, state: FolderState): Promise<FolderRecord> {
  const existing = await db
    .prepare(
      `SELECT uidvalidity AS uidValidity, last_synced_uid AS lastSyncedUid
       FROM folders WHERE name = ?`,
    )
    .bind(state.name)
    .first<{ uidValidity: number | null; lastSyncedUid: number }>();

  const row = await db
    .prepare(UPSERT_FOLDER)
    .bind(state.name, state.uidValidity ?? null, state.uidNext ?? null, state.highestModSeq ?? null)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to record folder ${state.name}`);
  return {
    id: row.id,
    previousUidValidity: existing?.uidValidity ?? null,
    watermark: existing?.lastSyncedUid ?? 0,
  };
}

/** Upserts messages, in batches. Returns how many rows were written. */
export async function upsertMessages(
  db: D1Database,
  rows: readonly MessageRow[],
  syncedAt: number,
): Promise<number> {
  let written = 0;
  for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
    const slice = rows.slice(start, start + WRITE_BATCH_SIZE);
    await db.batch(
      slice.map((row) =>
        db
          .prepare(UPSERT_MESSAGE)
          .bind(
            row.folderId,
            row.uidValidity,
            row.uid,
            row.rfcMessageId,
            row.inReplyTo,
            row.referenceIds,
            row.subject,
            row.fromAddress,
            row.fromAddresses,
            row.toAddresses,
            row.ccAddresses,
            row.internalDate,
            row.sentDate,
            row.sizeBytes,
            row.flags,
            row.bodyText,
            row.hasAttachments,
            syncedAt,
          ),
      ),
    );
    written += slice.length;
  }
  return written;
}

/**
 * How many messages are already indexed in each uid bucket above `aboveUid`.
 *
 * This is the query gap detection is built on (#6): enumeration compares these
 * counts against what SEARCH reported and enqueues only the buckets that are
 * short. Buckets are absolute — see src/queue.ts — so the arithmetic here and
 * the arithmetic there have to agree, which is why both take the size rather
 * than assuming it.
 *
 * `aboveUid` is the watermark enumeration resumed from, and matching it here is
 * a correctness requirement rather than a saving. The bucket straddling the
 * watermark also holds rows at or below it; SEARCH from watermark + 1 reports
 * only the members above it. Counting the whole bucket against that partial
 * member list would read an incomplete bucket as complete and skip it for good.
 *
 * The UNIQUE (folder_id, uidvalidity, uid) index covers this, and the result is
 * one row per bucket rather than one per message: a folder of 40,000 messages
 * answers in 400 rows.
 */
export async function indexedBuckets(
  db: D1Database,
  folderId: number,
  uidValidity: number,
  bucketSize: number,
  aboveUid = 0,
): Promise<Map<number, number>> {
  const { results } = await db
    .prepare(
      `SELECT (uid - 1) / CAST(? AS INTEGER) AS bucket, count(*) AS n
       FROM messages WHERE folder_id = ? AND uidvalidity = ? AND uid > ?
       GROUP BY bucket`,
    )
    .bind(bucketSize, folderId, uidValidity, aboveUid)
    .all<{ bucket: number; n: number }>();

  return new Map(results.map((row) => [row.bucket, row.n]));
}

/**
 * The watermark enumeration resumes from: the highest uid below the first gap.
 *
 * Written by enumeration and by nothing else. Under queue fan-out (#6) ranges
 * complete out of order, so a consumer recording "the highest uid I stored"
 * would claim a contiguity that does not exist. Enumeration knows which
 * buckets are complete, so it is the only caller that can tell the truth here.
 *
 * Monotonic, deliberately: a run that was cut short by the per-run chunk
 * ceiling has seen less of the folder than the run before it, and must not
 * report that as ground lost.
 */
export async function recordSyncWatermark(
  db: D1Database,
  folderId: number,
  highestUid: number,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE folders SET last_synced_uid = max(last_synced_uid, ?), last_synced_at = ?
       WHERE id = ?`,
    )
    .bind(highestUid, at, folderId)
    .run();
}

/** Resets the watermark: the uids it counted are gone with the old UIDVALIDITY. */
export async function resetSyncWatermark(db: D1Database, folderId: number): Promise<void> {
  await db.prepare("UPDATE folders SET last_synced_uid = 0 WHERE id = ?").bind(folderId).run();
}
