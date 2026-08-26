/**
 * Consumption: one uid range, over one connection, into D1 and R2 (#6, #9).
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
 *
 * Sizes are read before bodies are. cf-imap materialises every attachment
 * twice — decoded and base64 — on top of the whole raw message held as a
 * string, and has no streaming API, so fetching a message is an operation with
 * a size ceiling. One header-only FETCH per range answers RFC822.SIZE for every
 * uid in it, which turns "this message is too big" from an exhausted isolate
 * into a decision taken before any bytes move.
 */

import type { FolderState, Mailbox, MailboxMessage } from "@imap-mcp/imap";
import { storeAttachments } from "./attachments";
import type { SyncConfig } from "./config";
import { describeError, type Logger } from "./log";
import { toMessageRow } from "./normalise";
import type { SyncChunk } from "./queue";
import { type MessageWrite, storeMessages } from "./store";

export type ChunkOutcome = {
  /** Message rows written. */
  stored: number;
  /** Attachments whose bytes reached R2. */
  attachments: number;
  /** Messages recorded from their headers because they were too large to fetch. */
  oversize: number;
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
    return { stored: 0, attachments: 0, oversize: 0, stale: true };
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
    return { stored: 0, attachments: 0, oversize: 0, stale: true };
  }

  // Headers and RFC822.SIZE for the whole range, before a single body is
  // pulled. Cheap — a few hundred bytes a message — and it decides both which
  // messages can be fetched at all and how many may travel together.
  const sized = await mailbox.fetchMessages({ uids: chunk.uids, includeBody: false });

  const outcome: ChunkOutcome = { stored: 0, attachments: 0, oversize: 0, stale: false };
  const fetchable: MailboxMessage[] = [];
  const skipped: MessageWrite[] = [];

  for (const message of sized) {
    if (message.size > config.maxFetchBytes) {
      skipped.push(await asOversize(message, chunk, uidValidity, config, log));
    } else {
      fetchable.push(message);
    }
  }

  if (skipped.length > 0) {
    outcome.stored += await storeMessages(env.DB, skipped, Date.now());
    outcome.oversize += skipped.length;
  }

  for (const slice of planSlices(fetchable, config.chunkSize, config.maxFetchBytes)) {
    const messages = await mailbox.fetchMessages({
      uids: slice.map((message) => message.uid),
      includeBody: true,
      // The size pass already excluded everything above this, so in the normal
      // case the server never truncates anything. It is sent anyway: RFC822.SIZE
      // is the server's own claim about a message, and a claim that turned out
      // to be low would otherwise hand the isolate more than it budgeted for.
      byteLimit: config.maxFetchBytes,
    });

    const writes: MessageWrite[] = [];
    for (const message of messages) {
      if (message.size > config.maxFetchBytes) {
        // Its body arrived truncated at byteLimit, so the MIME is damaged.
        // Indexing that would be worse than indexing nothing.
        writes.push(await asOversize(message, chunk, uidValidity, config, log));
        outcome.oversize += 1;
        continue;
      }

      // Bytes first, and D1 second, deliberately. Gap detection counts
      // `messages` rows: a row that landed while its attachment bytes did not
      // would mark the uid bucket complete, and the range would never be
      // enqueued again. Failing here leaves no row, so the next tick retries.
      const attachments = await storeAttachments(
        env.ATTACHMENTS,
        message,
        chunk.folderId,
        uidValidity,
        log,
      );
      outcome.attachments += attachments.filter((row) => row.r2Key !== null).length;
      writes.push({ row: await toMessageRow(message, chunk.folderId, uidValidity), attachments });
    }

    outcome.stored += await storeMessages(env.DB, writes, Date.now());
  }

  return outcome;
}

/**
 * How a message too large to fetch is recorded.
 *
 * A row rather than nothing: gap detection counts rows, so skipping the message
 * outright would leave its uid bucket permanently short and re-enqueue the
 * range on every tick for good. What the row cannot carry is a body or
 * attachments — see MessageRow.oversize.
 */
async function asOversize(
  message: MailboxMessage,
  chunk: SyncChunk,
  uidValidity: number,
  config: SyncConfig,
  log: Logger,
): Promise<MessageWrite> {
  log.warn(
    `${chunk.folder} uid ${message.uid}: ${message.size} bytes exceeds the ` +
      `${config.maxFetchBytes}-byte fetch budget — indexing its headers only`,
  );
  return {
    row: await toMessageRow(message, chunk.folderId, uidValidity, { oversize: true }),
    attachments: [],
  };
}

/**
 * Groups messages into fetches bounded by count AND by bytes.
 *
 * Count alone was the bound before attachments existed, and it is the wrong
 * one on its own: ten ordinary messages are a few hundred kilobytes, and ten
 * messages carrying a presentation each are not. Bytes alone is wrong too —
 * a thousand tiny messages in one FETCH is a response nothing wants to parse.
 *
 * A message on its own always gets a slice, whatever it costs: the size pass
 * has already refused anything above the budget, so the only messages here are
 * ones worth fetching.
 */
function planSlices(
  messages: readonly MailboxMessage[],
  maxCount: number,
  maxBytes: number,
): MailboxMessage[][] {
  const slices: MailboxMessage[][] = [];
  let current: MailboxMessage[] = [];
  let bytes = 0;

  for (const message of messages) {
    if (current.length > 0 && (current.length >= maxCount || bytes + message.size > maxBytes)) {
      slices.push(current);
      current = [];
      bytes = 0;
    }
    current.push(message);
    bytes += message.size;
  }
  if (current.length > 0) slices.push(current);

  return slices;
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
