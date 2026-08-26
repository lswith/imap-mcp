/**
 * Logging, with the mailbox password scrubbed out of every line.
 *
 * The app-specific password grants full mailbox access including SMTP send, so
 * it must never reach a log line — including error paths, which is where
 * credentials usually escape. @imap-mcp/imap already scrubs everything it
 * throws; this closes the other half, which is anything this worker logs by
 * itself: a message from another library, a string built here, a value that
 * turned out to hold more than expected.
 *
 * Every console call in packages/sync goes through this. There are no others.
 */

import { passwordForms, redactSecrets } from "@imap-mcp/imap";

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

/**
 * Built straight from Env rather than from a parsed config, so it is available
 * before validation — the point at which a configuration error is reported is
 * also a point at which the credential exists.
 */
export function createLogger(env: Env): Logger {
  const scrub = createScrubber(env);
  return {
    info: (message) => console.log(scrub(message)),
    warn: (message) => console.warn(scrub(message)),
    error: (message) => console.error(scrub(message)),
  };
}

/**
 * The same scrubbing, for text that is not going to a log line.
 *
 * A write outcome (#12) crosses a service binding, lands in write_log, and is
 * read by a model — three places the credential must not reach either, and none
 * of them a logger covers.
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
