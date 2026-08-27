/**
 * Logging, with the mailbox password scrubbed out of every line.
 *
 * The app-specific password grants full mailbox access including SMTP send, so
 * it must never reach a log line — including error paths, which is where
 * credentials usually escape. src/imap already scrubs everything it
 * throws; this closes the other half, which is anything this worker logs by
 * itself: a message from another library, a string built here, a value that
 * turned out to hold more than expected.
 *
 * Every console call in this Worker goes through here. There are no others, and
 * that is enforced rather than remembered: `noConsole` in biome.json is an
 * error everywhere in src/ except this file.
 *
 * It used to live in src/sync/, back when the sync half was the only half that
 * said anything. The fetch path saying nothing at all is precisely the reason a
 * deployed instance was hard to tell apart from a broken one, so the
 * logger moved out to where both halves can reach it.
 *
 * WHAT GETS LOGGED, AND AT WHICH LEVEL
 *
 *   error  something did not happen that should have
 *   warn   something is off but the run continued
 *   info   what each invocation did — one line per cron tick, queue range,
 *          request and tool call. This is the default, and it is chosen so
 *          that an idle instance is quiet and a working one is legible.
 *   debug  the steps inside those, for when a line at info says a run went
 *          wrong without saying where. Off by default: it is per-window and
 *          per-message, so it is loud in proportion to the mailbox.
 *
 * The level is the LOG_LEVEL var (wrangler.jsonc). It is a var rather than a
 * constant so raising it is a dashboard edit against a running instance, not a
 * redeploy of a mailbox that is mid-backfill.
 *
 * What never appears in a line, at any level: the password (scrubbed here),
 * message bodies, subjects, sender addresses, or a search query. A log line
 * says how many and how long, never what — mail is the user's, and the
 * dashboard is not where they agreed to keep it.
 */

import { passwordForms, redactSecrets } from "./imap";

export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

/** Lowest to highest. `silent` is a floor nothing clears, not a level. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * The configured level, or the default.
 *
 * Unlike readSyncConfig, a bad value here does not throw. Logging is how every
 * other failure gets reported, so a typo in LOG_LEVEL must not become the
 * failure that hides them: it falls back to `info` and says so at `warn`,
 * which is a level nobody can have configured their way out of hearing.
 */
export function readLogLevel(env: Env): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return DEFAULT_LOG_LEVEL;
  if (raw in SEVERITY) return raw as LogLevel;

  // Deliberately not echoed: this is the one config reader that runs before
  // anything is scrubbed, and the rule is easier to keep than to remember.
  console.warn(`LOG_LEVEL is not one of ${Object.keys(SEVERITY).join(", ")}; using info`);
  return DEFAULT_LOG_LEVEL;
}

/**
 * Built straight from Env rather than from a parsed config, so it is available
 * before validation — the point at which a configuration error is reported is
 * also a point at which the credential exists.
 *
 * `component` tags every line from one entry point: `[cron]`, `[queue]`,
 * `[mcp]`. Workers Logs groups a run's lines into one timeline already, so
 * this is not for telling invocations apart — it is for filtering *across*
 * them, which is the question a deployed instance actually raises ("is the
 * cron running at all?").
 */
export function createLogger(env: Env, component?: string): Logger {
  const scrub = createScrubber(env);
  const floor = SEVERITY[readLogLevel(env)];
  const tag = component ? `[${component}] ` : "";
  const line = (message: string) => `${tag}${scrub(message)}`;

  return {
    debug: (message) => {
      if (floor <= SEVERITY.debug) console.debug(line(message));
    },
    info: (message) => {
      if (floor <= SEVERITY.info) console.log(line(message));
    },
    warn: (message) => {
      if (floor <= SEVERITY.warn) console.warn(line(message));
    },
    error: (message) => {
      if (floor <= SEVERITY.error) console.error(line(message));
    },
  };
}

/**
 * The same scrubbing, for text that is not going to a log line.
 *
 * A write outcome (#12) lands in write_log and is read by a model; a status
 * document (src/status.ts) is JSON handed to whoever asked. Three places the
 * credential must not reach, and only one of them is a logger.
 */
export function createScrubber(env: Env): (message: string) => string {
  const secrets = passwordForms(env.IMAP_USER ?? "", env.IMAP_PASSWORD ?? "");
  return (message: string) => redactSecrets(message, secrets);
}

/**
 * An unknown thrown value as one line.
 *
 * The stack is left out on purpose: it adds file paths and no diagnosis that
 * the message and the observability timeline do not already give. The `cause`
 * chain is included because MailboxError carries the underlying failure there,
 * already scrubbed — and the logger scrubs it again regardless.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  let described = `${error.name}: ${error.message}`;
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    described += ` (caused by ${cause.name}: ${cause.message})`;
  }
  return described;
}

/** Milliseconds since `startedAt`, for the "in 412ms" tail of a summary line. */
export function since(startedAt: number): number {
  return Date.now() - startedAt;
}
