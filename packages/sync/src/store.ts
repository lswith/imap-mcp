/**
 * The D1 writes.
 *
 * Every message write is an upsert on (folder_id, uidvalidity, uid). That is
 * not defensiveness about this worker, which runs once an hour from cron — it
 * is the contract the rest of the system is built on. Queue delivery (#6) is
 * at-least-once, so no consumer may assume it runs exactly once, and the
 * recovery path for this database is re-running the backfill (#13) over rows
 * that are already there.
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
};

/**
 * Records the folder and returns its id.
 *
 * A changed UIDVALIDITY is reported rather than acted on: every uid recorded
 * against the old value is meaningless and the folder needs re-syncing from
 * scratch, which is #8's job. Nothing breaks in the meantime because messages
 * carry their own uidvalidity — new rows sit alongside the stale ones instead
 * of colliding with them.
 */
export async function upsertFolder(db: D1Database, state: FolderState): Promise<FolderRecord> {
  const existing = await db
    .prepare("SELECT uidvalidity AS uidValidity FROM folders WHERE name = ?")
    .bind(state.name)
    .first<{ uidValidity: number | null }>();

  const row = await db
    .prepare(UPSERT_FOLDER)
    .bind(state.name, state.uidValidity ?? null, state.uidNext ?? null, state.highestModSeq ?? null)
    .first<{ id: number }>();

  if (!row) throw new Error(`Failed to record folder ${state.name}`);
  return { id: row.id, previousUidValidity: existing?.uidValidity ?? null };
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
 * The watermark #8 resumes from: the highest uid this run stored.
 *
 * Written but never read here. This slice always covers the same window from
 * the start of the folder, so that a second run re-covers the same messages
 * and the upsert is what stops them duplicating — a watermark that made the
 * second run a no-op would prove nothing. Advancing the window is #8 and #13.
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
