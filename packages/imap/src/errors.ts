/**
 * Typed failures, and the scrubbing that keeps the mailbox password out of
 * them.
 *
 * Two repo rules meet here. The app-specific password grants full mailbox
 * access including SMTP send, so it must never reach a log line — including
 * error paths, which is where credentials usually escape. And an
 * authentication failure must fail loudly rather than retry: a revoked
 * password retried at queue speed is how an Apple ID gets locked.
 */

/** Base class for everything this package throws. */
export class MailboxError extends Error {
  /** Whether the caller may sensibly try the operation again. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MailboxError";
    this.retryable = options.retryable;
  }
}

/**
 * The server rejected the credentials. Never retryable: repeated failed logins
 * are what locks an Apple ID.
 */
export class ImapAuthError extends MailboxError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: false, cause });
    this.name = "ImapAuthError";
  }
}

/**
 * The server said something this client could not use: a NO/BAD outside
 * authentication, a malformed response, a connection dropped mid-literal.
 */
export class ImapProtocolError extends MailboxError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = "ImapProtocolError";
  }
}

/** The server did not answer within the configured timeout. */
export class ImapTimeoutError extends MailboxError {
  constructor(message: string, cause?: unknown) {
    super(message, { retryable: true, cause });
    this.name = "ImapTimeoutError";
  }
}

/**
 * Replaces every occurrence of every secret with a marker.
 *
 * Secrets are matched literally rather than by pattern: a pattern that tries
 * to recognise "a password" is a pattern that eventually fails to.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Every form of the password that could come back off the wire.
 *
 * A server is allowed to echo the command it rejected — `A3 BAD Invalid
 * command: LOGIN "user" "hunter2"` is a real response shape — so redacting the
 * plaintext alone is not enough. The quoted form (backslash-escaped, as LOGIN
 * sends it) and the base64 SASL PLAIN initial response are both derived here
 * and scrubbed alongside it.
 */
export function passwordForms(username: string, password: string): string[] {
  if (!password) return [];
  const forms = [password, password.replace(/([\\"])/g, "\\$1")];
  try {
    // SASL PLAIN initial response: NUL, authzid, NUL, authcid, NUL,
    // password (RFC 4616) — what AUTHENTICATE PLAIN puts on the wire.
    const sasl = `\u0000${username}\u0000${password}`;
    forms.push(btoa(String.fromCharCode(...new TextEncoder().encode(sasl))));
  } catch {
    // btoa is unavailable or the credential is not representable — the
    // plaintext forms above still get scrubbed.
  }
  return forms;
}
