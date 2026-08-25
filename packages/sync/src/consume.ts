/**
 * Consumption: one uid range, over one connection, into D1 (#6).
 *
 * This is what the tracer (#5) used to do inline. The window it covers is now
 * decided by enumeration and delivered on a queue, which is the whole point —
 * a mailbox of tens of thousands of messages is a few hundred of these rather
 * than one invocation that cannot finish.
 *
 * Every fetch is non-mutating. The Mailbox interface has no way to fetch
 * without PEEK, so indexing cannot mark mail as read even by mistake.
 *
 * Nothing here writes the sync watermark. Ranges complete out of order under
 * fan-out, so a consumer that recorded "the highest uid I stored" would claim a
 * contiguity that does not exist; enumeration owns that column instead.
 */

import type { FolderState, Mailbox, MailboxMessage } from "@imap-mcp/imap";
import type { SyncConfig } from "./config";
import { describeError, type Logger } from "./log";
import { toMessageRow } from "./normalise";
import type { SyncChunk } from "./queue";
import { upsertMessages } from "./store";

export type ChunkOutcome = {
  /** Rows written. */
  stored: number;
  /**
   * The range no longer describes anything that exists — the folder was
   * renumbered after enumeration, or is gone from the server altogether — so
   * it was dropped rather than retried.
   */
  stale: boolean;
};

export async function consumeChunk(
  env: Env,
  mailbox: Mailbox,
  chunk: SyncChunk,
  config: SyncConfig,
  log: Logger,
): Promise<ChunkOutcome> {
  let state: FolderState;
  try {
    state = await mailbox.selectFolder(chunk.folder, { readOnly: true });
  } catch (error) {
    // A tagged NO on SELECT looks the same whether the folder is gone or the
    // server is merely unhappy, so ask. Only on this path: it costs a LIST, and
    // it buys not spending three retries and a dead-letter slot on a folder
    // that is not coming back under this name.
    if (await stillThere(mailbox, chunk.folder, log)) throw error;
    log.warn(
      `${chunk.folder}: not on the server — dropping uids ${chunk.from}:${chunk.to} as stale`,
    );
    return { stored: 0, stale: true };
  }
  const uidValidity = state.uidValidity ?? 0;

  if (uidValidity !== chunk.uidValidity) {
    // Every uid in this chunk now means a different message. Writing it would
    // put the wrong body against the right key, which is worse than not
    // writing it: the next cron tick re-enumerates under the new value.
    log.warn(
      `${chunk.folder}: UIDVALIDITY is ${uidValidity}, not ${chunk.uidValidity} — ` +
        `dropping uids ${chunk.from}:${chunk.to} as stale`,
    );
    return { stored: 0, stale: true };
  }

  let stored = 0;
  for (const slice of slices(chunk.uids, config.chunkSize)) {
    // Sliced rather than fetched in one command: a message can carry tens of
    // megabytes of attachments, all of which are decoded into memory by the
    // parse, and a worker has ~128 MB. Peak memory is bounded by the slice
    // size rather than by the width of the range.
    const messages = await mailbox.fetchMessages({ uids: slice, includeBody: true });
    const rows = await Promise.all(
      messages.map((message: MailboxMessage) => toMessageRow(message, chunk.folderId, uidValidity)),
    );
    stored += await upsertMessages(env.DB, rows, Date.now());
  }

  return { stored, stale: false };
}

/**
 * Whether the server still lists this folder.
 *
 * A LIST that itself fails says nothing about the folder, so it resolves to
 * "still there" and the original failure is the one that reaches the caller —
 * a range must never be dropped on the strength of a question that went
 * unanswered.
 */
async function stillThere(mailbox: Mailbox, name: string, log: Logger): Promise<boolean> {
  try {
    return (await mailbox.listFolders()).some((folder) => folder.name === name);
  } catch (error) {
    log.warn(`${name}: could not list folders to check whether it exists: ${describeError(error)}`);
    return true;
  }
}

function slices(uids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let start = 0; start < uids.length; start += size) {
    out.push(uids.slice(start, start + size));
  }
  return out;
}
