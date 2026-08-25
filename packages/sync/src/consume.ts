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

import type { Mailbox, MailboxMessage } from "@imap-mcp/imap";
import type { SyncConfig } from "./config";
import type { Logger } from "./log";
import { toMessageRow } from "./normalise";
import type { SyncChunk } from "./queue";
import { upsertMessages } from "./store";

export type ChunkOutcome = {
  /** Rows written. */
  stored: number;
  /** The folder was renumbered after enumeration, so the range was dropped. */
  stale: boolean;
};

export async function consumeChunk(
  env: Env,
  mailbox: Mailbox,
  chunk: SyncChunk,
  config: SyncConfig,
  log: Logger,
): Promise<ChunkOutcome> {
  const state = await mailbox.selectFolder(chunk.folder, { readOnly: true });
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

function slices(uids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let start = 0; start < uids.length; start += size) {
    out.push(uids.slice(start, start + size));
  }
  return out;
}
