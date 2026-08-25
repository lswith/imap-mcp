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
  /** ISO date, converted to the epoch milliseconds the schema stores. */
  date?: string;
  hasAttachments?: boolean;
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

  const row = await env.DB.prepare(
    `INSERT INTO messages (folder_id, uidvalidity, uid, subject, from_address,
                           internal_date, body_text, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      folderId,
      message.uidValidity ?? folderUidValidity ?? 100,
      message.uid ?? nextUid++,
      message.subject ?? "",
      message.from ?? null,
      Date.parse(message.date ?? "2026-03-04T09:12:00Z"),
      message.body ?? null,
      message.hasAttachments ? 1 : 0,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("failed to seed message");
  return row.id;
}

/** Clears everything between tests; the cascade takes messages and the FTS rows with it. */
export async function clearIndex(): Promise<void> {
  await env.DB.prepare("DELETE FROM folders").run();
  nextUid = 1;
}
