/**
 * The Mailbox implementation, and the only file in this repository that
 * imports cf-imap.
 *
 * Issue #3 weighed vendoring the client against depending on it and settled on
 * depending: the generic-by-design requirement is served by the interface in
 * types.ts, not by owning someone else's MIME parser. What that costs is one
 * defect we cannot fix at the source and must work around here — see setFlags.
 *
 * Swapping cf-imap for another client, or for a provider that is not IMAP at
 * all, means rewriting this file and nothing else.
 */

import type { Email, SearchEmailsProps } from "cf-imap";
import { CFImap, ImapError } from "cf-imap";
import {
  ImapAuthError,
  ImapProtocolError,
  ImapTimeoutError,
  type MailboxError,
  passwordForms,
  redactSecrets,
} from "./errors";
import type {
  AppendedMessage,
  AppendOptions,
  CopyResult,
  FetchOptions,
  FlagMode,
  FolderState,
  Mailbox,
  MailboxConfig,
  MailboxFolder,
  MailboxMessage,
  MessageFlags,
  SearchCriteria,
  UidSet,
} from "./types";
import { formatUidSet, toUidRuns } from "./uids";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Connects and authenticates.
 *
 * `config.enable` is issued here — authenticated, before any folder is
 * selected — because that ordering is required (RFC 5161) and its absence is
 * silent rather than loud (#8).
 */
export async function connectMailbox(config: MailboxConfig): Promise<Mailbox> {
  const secrets = passwordForms(config.username, config.password);
  const client = new CFImap({
    host: config.host,
    port: config.port,
    tls: config.tls ?? true,
    auth: { username: config.username, password: config.password },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  await guard(() => client.connect(), secrets, "connect");

  const enable = config.enable;
  if (enable?.length) await guard(() => client.enable(enable), secrets, "command");

  return new CfImapMailbox(client, secrets);
}

/**
 * Runs one cf-imap call, turning whatever comes out of it into a typed,
 * scrubbed MailboxError.
 */
async function guard<T>(
  fn: () => Promise<T>,
  secrets: readonly string[],
  phase: "connect" | "command",
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw toMailboxError(cause, secrets, phase);
  }
}

function toMailboxError(
  cause: unknown,
  secrets: readonly string[],
  phase: "connect" | "command",
): MailboxError {
  // Scrub in place rather than dropping the cause: a caller that logs
  // `error.cause` must not be the hole the credential escapes through, and a
  // cause carrying the original stack is worth keeping.
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = redactSecrets(raw, secrets);
  if (cause instanceof Error) cause.message = message;
  if (cause instanceof ImapError) cause.messageText = redactSecrets(cause.messageText, secrets);

  if (cause instanceof ImapError) {
    // A tagged NO/BAD before the connection is usable is the server rejecting
    // the credentials. Not retryable, by design.
    if (phase === "connect")
      return new ImapAuthError(`IMAP authentication failed: ${message}`, cause);
    return new ImapProtocolError(message, cause);
  }

  if (/timed out/i.test(raw)) return new ImapTimeoutError(message, cause);

  return new ImapProtocolError(message, cause);
}

class CfImapMailbox implements Mailbox {
  /**
   * Truly private, not TypeScript-private: the cf-imap instance holds the
   * password in an ordinary property, so a `#` field is what keeps
   * JSON.stringify(mailbox) from reaching it.
   */
  readonly #client: CFImap;
  readonly #secrets: readonly string[];

  constructor(client: CFImap, secrets: readonly string[]) {
    this.#client = client;
    this.#secrets = secrets;
  }

  get capabilities(): readonly string[] {
    return [...this.#client.capabilities];
  }

  async listFolders(namespace = "", filter = "*"): Promise<MailboxFolder[]> {
    const folders = await this.#run(() => this.#client.getFolders(namespace, filter));
    return folders.map((folder) => ({
      name: folder.name,
      delimiter: folder.delimiter,
      attributes: folder.attributes,
    }));
  }

  async selectFolder(name: string, options: { readOnly?: boolean } = {}): Promise<FolderState> {
    const info = await this.#run(() =>
      options.readOnly ? this.#client.examine(name) : this.#client.selectFolder(name),
    );
    return {
      name,
      exists: info.emails,
      recent: info.recent,
      unseen: info.unseen,
      uidNext: info.uidNext,
      uidValidity: info.uidValidity,
      highestModSeq: info.highestModSeq,
      noModSeq: info.nomodSeq === true,
      flags: info.flags,
      permanentFlags: info.permanentFlags,
      readOnly: info.readOnly,
    };
  }

  async status(
    name: string,
    items?: Array<"MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN">,
  ): Promise<Record<string, number>> {
    return this.#run(() => this.#client.status(name, items));
  }

  async fetchMessages({
    uids,
    includeBody = true,
    byteLimit,
  }: FetchOptions): Promise<MailboxMessage[]> {
    const messages: MailboxMessage[] = [];
    for (const run of toUidRuns(uids)) {
      const emails = await this.#run(() =>
        this.#client.fetchEmails({
          limit: run.from === run.to ? run.from : [run.from, run.to],
          useUid: true,
          fetchBody: includeBody,
          byteLimit,
          // Not a caller option anywhere in this interface: indexing a mailbox
          // must never mark mail as read (#5).
          peek: true,
        }),
      );
      for (const email of emails) messages.push(toMessage(email));
    }
    return messages;
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    const props = toSearchProps(criteria);
    return this.#run(() => this.#client.searchEmails(props));
  }

  async setFlags(uids: UidSet, flags: string[], mode: FlagMode = "add"): Promise<MessageFlags[]> {
    await this.#run(() => this.#client.storeFlags(formatUidSet(uids), flags, mode, true));

    // The STORE response is deliberately discarded. cf-imap parses the
    // untagged FETCH confirmation with a regex that has no room for the
    // `MODSEQ (n)` RFC 7162 §3.1.3 requires the server to append once
    // CONDSTORE is enabled, so with CONDSTORE on — which #8 wants
    // session-wide — it reports zero rows for a write that landed. Reading the
    // flags back is the only answer that is true either way, and #8/#12 both
    // require the verification regardless.
    const verified = await this.fetchMessages({ uids, includeBody: false });
    return verified.map((message) => ({ uid: message.uid, flags: message.flags }));
  }

  async copy(uids: UidSet, target: string): Promise<CopyResult | null> {
    const result = await this.#run(() => this.#client.copy(target, formatUidSet(uids), true));
    if (!result) return null;
    return {
      uidValidity: result.uidValidity,
      sourceUids: result.sourceUIDs,
      destUids: result.destUIDs,
    };
  }

  async expunge(uids: UidSet): Promise<number[]> {
    // UID EXPUNGE, never a bare EXPUNGE: the range is required by the
    // signature, so there is no way to sweep the whole folder by accident (#12).
    return this.#run(() => this.#client.expunge({ range: formatUidSet(uids), useUid: true }));
  }

  async append(
    folder: string,
    message: string | Uint8Array,
    options: AppendOptions = {},
  ): Promise<AppendedMessage | null> {
    const result = await this.#run(() =>
      this.#client.append(folder, message, options.flags, options.internalDate),
    );
    return result ? { uidValidity: result.uidValidity, uid: result.uid } : null;
  }

  async close(): Promise<void> {
    await this.#run(() => this.#client.logout());
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    return guard(fn, this.#secrets, "command");
  }
}

/** cf-imap's Email, flattened into this project's shape. */
function toMessage(email: Email): MailboxMessage {
  return {
    uid: email.uid,
    seq: email.seq,
    flags: email.flags,
    internalDate: email.internalDate,
    size: email.size,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    messageId: email.messageID,
    contentType: email.contentType,
    headers: email.headers,
    rawHeaders: email.rawHeaders,
    text: email.body.text,
    html: email.body.html,
    raw: email.raw,
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      encoding: attachment.encoding,
      contentBase64: attachment.contentBase64,
      contentId: attachment.contentId,
      isInline: attachment.isInline,
    })),
  };
}

function toSearchProps(criteria: SearchCriteria): SearchEmailsProps {
  const props: SearchEmailsProps = { useUid: true };

  if (criteria.all) props.all = true;
  if (criteria.since) props.since = criteria.since;
  if (criteria.before) props.before = criteria.before;
  if (criteria.sentSince) props.sentSince = criteria.sentSince;
  if (criteria.sentBefore) props.sentBefore = criteria.sentBefore;
  if (criteria.from) props.from = criteria.from;
  if (criteria.to) props.to = criteria.to;
  if (criteria.subject) props.subject = criteria.subject;
  if (criteria.header) props.header = criteria.header;
  if (criteria.seen !== undefined) props.seen = criteria.seen;
  if (criteria.flagged !== undefined) props.flagged = criteria.flagged;
  if (criteria.deleted !== undefined) props.deleted = criteria.deleted;
  if (criteria.largerThan !== undefined) props.largerThan = criteria.largerThan;
  if (criteria.smallerThan !== undefined) props.smallerThan = criteria.smallerThan;
  if (criteria.uids !== undefined) props.uid = formatUidSet(criteria.uids);

  return props;
}
