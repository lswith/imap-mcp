/**
 * Sync worker — the only part of this system that speaks IMAP.
 *
 * It owns the connection and the app-specific password, so that credential
 * lives in exactly one place: the MCP server reads the index and proxies
 * writes here over a service binding rather than holding a credential of its
 * own.
 *
 * Three entry points. The first two are the fan-out (#6):
 *
 *   scheduled  enumerate uids and post ~100-uid ranges to a queue
 *   queue      take one range, fetch it over one connection, upsert it
 *   RPC        perform one write the MCP server asked for (#12)
 *
 * Incremental sync — reading the watermark instead of re-deriving it — is #8.
 *
 * The third has no route and no fetch handler: WriteEntrypoint is reachable
 * only over a service binding, from a worker on this same account that declares
 * one. That is what lets the MCP server offer write tools while holding no
 * mailbox credential — and why `workers_dev` and `preview_urls` staying false
 * still means this worker is not on the internet at all.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { ImapAuthError, type Mailbox } from "@imap-mcp/imap";
import type {
  DraftRequest,
  FlagRequest,
  MoveRequest,
  WriteOutcome,
  WriteService,
} from "@imap-mcp/writes";
import { readSyncConfig, type SyncConfig, SyncConfigError } from "./config";
import { consumeChunk } from "./consume";
import { runEnumerate, summariseEnumeration } from "./enumerate";
import { createLogger, createScrubber, describeError, type Logger } from "./log";
import { DEAD_LETTER_QUEUE, describeChunk, parseChunk, type SyncChunk } from "./queue";
import type { SyncDeps } from "./session";
import { withMailbox } from "./session";
import { createDraft, flagMessage, moveMessage } from "./writes";

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

/**
 * One write, over one connection, reporting rather than throwing.
 *
 * Expected failures come back as outcomes because these calls arrive over a
 * service binding: a rejected RPC promise reaches the caller as a bare Error
 * with the shape of the failure lost, and the caller's job is to write an audit
 * row saying what happened — which needs a sentence, not a stack.
 *
 * An authentication failure is one of those. It does not throw here for the
 * same reason the queue path acks rather than retries: a revoked app-specific
 * password re-attempted is how an Apple ID gets locked, and a tool a model can
 * call in a loop is a faster way to do it than any cron.
 */
async function performWrite(
  env: Env,
  deps: SyncDeps,
  tool: string,
  body: (context: { mailbox: Mailbox; config: SyncConfig; log: Logger }) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  const log = deps.log ?? createLogger(env);
  const scrub = createScrubber(env);

  let config: SyncConfig;
  try {
    config = readSyncConfig(env);
  } catch (error) {
    log.error(`${tool}: refusing, ${describeError(error)}`);
    return {
      ok: false,
      reason: scrub(`This server is not configured for writes: ${describeError(error)}`),
    };
  }

  try {
    const outcome = await withMailbox(config, deps, log, (mailbox) =>
      body({ mailbox, config, log }),
    );
    log.info(`${tool}: ${outcome.ok ? outcome.detail : `refused — ${outcome.reason}`}`);
    return outcome;
  } catch (error) {
    log.error(`${tool} failed: ${describeError(error)}`);
    if (error instanceof ImapAuthError) {
      return { ok: false, reason: "The mailbox rejected this server's credentials." };
    }
    return { ok: false, reason: scrub(`The mailbox write failed: ${describeError(error)}`) };
  }
}

export function handleFlagMessage(
  env: Env,
  request: FlagRequest,
  deps: SyncDeps = {},
): Promise<WriteOutcome> {
  return performWrite(env, deps, "flag_message", ({ mailbox, log }) =>
    flagMessage(mailbox, request, log),
  );
}

export function handleMoveMessage(
  env: Env,
  request: MoveRequest,
  deps: SyncDeps = {},
): Promise<WriteOutcome> {
  return performWrite(env, deps, "move_message", ({ mailbox, log }) =>
    moveMessage(env.DB, mailbox, request, log),
  );
}

export function handleCreateDraft(
  env: Env,
  request: DraftRequest,
  deps: SyncDeps = {},
): Promise<WriteOutcome> {
  return performWrite(env, deps, "create_draft", ({ mailbox, config, log }) =>
    createDraft(mailbox, request, config, log),
  );
}

/**
 * The whole of what the MCP server may ask this worker to do.
 *
 * `implements WriteService` is load-bearing rather than documentation. RPC over
 * a service binding is structurally typed at the boundary, so a field renamed
 * on one side compiles cleanly on both and fails only in production; the
 * contract package exists to make that a red build, and this declaration is
 * where the sync half of it gets checked.
 *
 * There is no fourth method, no `fetch`, and nothing here can send or delete.
 */
export class WriteEntrypoint extends WorkerEntrypoint<Env> implements WriteService {
  flagMessage(request: FlagRequest): Promise<WriteOutcome> {
    return handleFlagMessage(this.env, request);
  }

  moveMessage(request: MoveRequest): Promise<WriteOutcome> {
    return handleMoveMessage(this.env, request);
  }

  createDraft(request: DraftRequest): Promise<WriteOutcome> {
    return handleCreateDraft(this.env, request);
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
