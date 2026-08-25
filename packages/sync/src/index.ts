/**
 * Sync worker — the only part of this system that speaks IMAP.
 *
 * It owns the connection and the app-specific password, so that credential
 * lives in exactly one place: the MCP server reads the index and proxies
 * writes here over a service binding rather than holding a credential of its
 * own.
 *
 * The cron handler runs the tracer (#5): connect, select one folder, fetch a
 * bounded UID range, normalise, write to D1. Queue fan-out follows in #6 and
 * incremental sync in #8.
 */

import { ImapAuthError } from "@imap-mcp/imap";
import { SyncConfigError } from "./config";
import { createLogger, describeError } from "./log";
import { runSync, type SyncDeps, summarise } from "./sync";

/**
 * What a cron tick does, and what it does about failure.
 *
 * Separated from the handler below for the same reason runSync takes a
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
    log.info(summarise(await runSync(env, { ...deps, log })));
  } catch (error) {
    if (error instanceof ImapAuthError || error instanceof SyncConfigError) {
      // Loudly, and once. A revoked app-specific password retried on every
      // tick is how an Apple ID gets locked, and a missing secret is not
      // something the next run can fix either.
      controller.noRetry();
      log.error(`aborting without retry: ${describeError(error)}`);
    } else {
      log.error(`sync failed: ${describeError(error)}`);
    }
    // Rethrown either way, so a failed run is recorded as one in the
    // observability timeline rather than looking like a quiet success.
    throw error;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
