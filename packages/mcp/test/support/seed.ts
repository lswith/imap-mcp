/**
 * Rows in the shape the sync worker writes them.
 *
 * Plain inserts on purpose: `messages_fts` is external content driven by
 * triggers, so a row written this way is indexed by the same mechanism a real
 * sync would use. A fixture that touched the FTS table directly would prove
 * less than nothing.
 */

import { env } from "cloudflare:test";

export type SeedMessage = {
  folder?: string;
  /** The folder's own UIDVALIDITY. */
  folderUidValidity?: number | null;
  /** The message's, when a test needs it to differ — a stale generation. */
  uidValidity?: number;
  uid?: number;
  subject?: string;
  body?: string | null;
  from?: string | null;
  /** The raw display strings, as the server gave them. */
  fromAddresses?: string[];
  toAddresses?: string[];
  ccAddresses?: string[];
  /** ISO date, converted to the epoch milliseconds the schema stores. */
  date?: string;
  /** Epoch milliseconds directly, for what an ISO string cannot express. */
  internalDate?: number;
  /** The Date header the sender claimed, ISO. */
  sentDate?: string;
  /** Threading identity, angle brackets included, as normalise.ts writes it. */
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  /** Written as a JSON array; pass a string to seed a malformed column. */
  referenceIds?: string[] | string;
  flags?: string[];
  sizeBytes?: number | null;
  hasAttachments?: boolean;
  /** Too large to body-fetch (#9): a row with no body and no attachments. */
  oversize?: boolean;
};

export type SeedAttachment = {
  partIndex?: number;
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  encoding?: string | null;
  contentId?: string | null;
  isInline?: boolean;
};

/** Records a folder, or returns the id it already has. */
async function seedFolder(name = "Archive", uidValidity: number | null = 100): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO folders (name, uidvalidity) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET uidvalidity = excluded.uidvalidity
     RETURNING id`,
  )
    .bind(name, uidValidity)
    .first<{ id: number }>();
  if (!row) throw new Error(`failed to seed folder ${name}`);
  return row.id;
}

let nextUid = 1;

export async function seedMessage(message: SeedMessage = {}): Promise<number> {
  const folderUidValidity =
    message.folderUidValidity === undefined ? 100 : message.folderUidValidity;
  const folderId = await seedFolder(message.folder ?? "Archive", folderUidValidity);

  const references =
    typeof message.referenceIds === "string"
      ? message.referenceIds
      : JSON.stringify(message.referenceIds ?? []);

  const row = await env.DB.prepare(
    `INSERT INTO messages (folder_id, uidvalidity, uid, rfc_message_id, in_reply_to,
                           reference_ids, subject, from_address, from_addresses,
                           to_addresses, cc_addresses, internal_date, sent_date,
                           size_bytes, flags, body_text, has_attachments, oversize)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      folderId,
      message.uidValidity ?? folderUidValidity ?? 100,
      message.uid ?? nextUid++,
      message.rfcMessageId ?? null,
      message.inReplyTo ?? null,
      references,
      message.subject ?? "",
      message.from ?? null,
      JSON.stringify(message.fromAddresses ?? (message.from ? [message.from] : [])),
      JSON.stringify(message.toAddresses ?? []),
      JSON.stringify(message.ccAddresses ?? []),
      message.internalDate ?? Date.parse(message.date ?? "2026-03-04T09:12:00Z"),
      message.sentDate === undefined ? null : Date.parse(message.sentDate),
      message.sizeBytes ?? null,
      JSON.stringify(message.flags ?? []),
      message.body ?? null,
      message.hasAttachments ? 1 : 0,
      message.oversize ? 1 : 0,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("failed to seed message");
  return row.id;
}

/**
 * A row in `attachments`, which nothing writes yet (#9).
 *
 * Seeding one is how the rendering path that #9 will feed gets tested before
 * there is anything to feed it.
 */
export async function seedAttachment(
  messageId: number,
  attachment: SeedAttachment = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO attachments (message_id, part_index, filename, mime_type, size_bytes,
                              encoding, content_id, is_inline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      attachment.partIndex ?? 0,
      attachment.filename ?? null,
      attachment.mimeType ?? null,
      attachment.sizeBytes ?? null,
      attachment.encoding ?? null,
      attachment.contentId ?? null,
      attachment.isInline ? 1 : 0,
    )
    .run();
}

/**
 * Clears everything between tests; the cascade takes messages and the FTS rows
 * with it.
 *
 * `write_log` has to be deleted explicitly: its message reference is ON DELETE
 * SET NULL rather than CASCADE, deliberately, so that an audit row outlives the
 * message it describes (#12). Dropping folders therefore leaves it behind.
 */
export async function clearIndex(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM write_log"),
    env.DB.prepare("DELETE FROM folders"),
  ]);
  nextUid = 1;
}
