/**
 * Sync worker — the only part of this system that speaks IMAP.
 *
 * It owns the connection and the app-specific password, so that credential
 * lives in exactly one place: the MCP server reads the index and proxies
 * writes here over a service binding rather than holding a credential of its
 * own.
 *
 * Two entry points, which between them are the fan-out (#6):
 *
 *   scheduled  enumerate uids and post ~100-uid ranges to a queue
 *   queue      take one range, fetch it over one connection, upsert it
 *
 * Incremental sync — reading the watermark instead of re-deriving it — is #8.
 */

import { ImapAuthError } from "@imap-mcp/imap";
import { readSyncConfig, SyncConfigError } from "./config";
import { consumeChunk } from "./consume";
import { runEnumerate, summariseEnumeration } from "./enumerate";
import { createLogger, describeError, type Logger } from "./log";
import { DEAD_LETTER_QUEUE, describeChunk, parseChunk, type SyncChunk } from "./queue";
import type { SyncDeps } from "./session";
import { withMailbox } from "./session";

/**
 * What a cron tick does, and what it does about failure.
 *
 * Separated from the handler below for the same reason runEnumerate takes a
 * `connect`: the decisions here — abort or retry, what gets logged — are the
 * ones worth testing, and testing them through the default export would mean
 * opening a real connection to do it.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  deps: SyncDeps = {},
): Promise<void> {
  const log = deps.log ?? createLogger(env);

  try {
    log.info(summariseEnumeration(await runEnumerate(env, { ...deps, log })));
  } catch (error) {
    if (isTerminal(error)) {
      // Loudly, and once. A revoked app-specific password retried on every
      // tick is how an Apple ID gets locked, and a missing secret is not
      // something the next run can fix either.
      controller.noRetry();
      log.error(`aborting without retry: ${describeError(error)}`);
    } else {
      log.error(`enumeration failed: ${describeError(error)}`);
    }
    // Rethrown either way, so a failed run is recorded as one in the
    // observability timeline rather than looking like a quiet success.
    throw error;
  }
}

/**
 * One batch of uid ranges, over one connection.
 *
 * Messages are acked individually so one bad range does not replay the rest.
 * The batch is configured at one message (see wrangler.jsonc), which makes an
 * invocation exactly one range — but the loop is written for more, so raising
 * that is a configuration change rather than a rewrite.
 */
export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  deps: SyncDeps = {},
): Promise<void> {
  const log = deps.log ?? createLogger(env);

  if (batch.queue === DEAD_LETTER_QUEUE) {
    reportDeadLetters(batch, log);
    batch.ackAll();
    return;
  }

  // Parsed before anything connects: a body that cannot be acted on is a bug
  // or a version skew, and retrying it three times before dead-lettering it
  // teaches nobody anything.
  const work: Array<{ message: Message<unknown>; chunk: SyncChunk }> = [];
  for (const message of batch.messages) {
    try {
      work.push({ message, chunk: parseChunk(message.body) });
    } catch (error) {
      log.error(`acking an unusable queue message: ${describeError(error)}`);
      message.ack();
    }
  }
  if (work.length === 0) return;

  const config = readSyncConfig(env);
  try {
    await withMailbox(config, deps, log, async (mailbox) => {
      for (const { message, chunk } of work) {
        try {
          const outcome = await consumeChunk(env, mailbox, chunk, config, log);
          log.info(`stored ${outcome.stored} of ${describeChunk(chunk)}`);
          message.ack();
        } catch (error) {
          if (isTerminal(error)) throw error;
          log.error(`${describeChunk(chunk)} failed, will retry: ${describeError(error)}`);
          message.retry();
        }
      }
    });
  } catch (error) {
    if (!isTerminal(error)) throw error;
    // Not retried, and not dead-lettered either. Re-attempting a revoked
    // password across every consumer at once is the fastest way to get an
    // Apple ID locked; the next cron tick re-enumerates whatever this batch
    // did not store, so acking loses no work.
    log.error(`aborting without retry: ${describeError(error)}`);
    batch.ackAll();
  }

  // `ctx` is unused today. It is in the signature because getQueueResult wants
  // the handler's own ExecutionContext, and because #9 will waitUntil() the R2
  // writes through it.
  void ctx;
}

/** Auth and configuration are the two failures a retry cannot fix. */
function isTerminal(error: unknown): boolean {
  return error instanceof ImapAuthError || error instanceof SyncConfigError;
}

/**
 * A range that ran out of retries.
 *
 * There is no table for this: the queue message already carries the folder and
 * the uid range, which is everything needed to say what was missed, and the
 * recovery path for this database is re-running the backfill (#13).
 */
function reportDeadLetters(batch: MessageBatch<unknown>, log: Logger): void {
  for (const message of batch.messages) {
    try {
      log.error(
        `dead-lettered after ${message.attempts} attempts: ${describeChunk(parseChunk(message.body))}`,
      );
    } catch (error) {
      log.error(`dead-lettered an unusable queue message: ${describeError(error)}`);
    }
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(controller, env);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    await handleQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
