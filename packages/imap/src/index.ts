/**
 * @imap-mcp/imap — the mailbox interface the rest of the repo talks to.
 *
 * Only packages/sync may depend on this package: it is the worker that owns
 * the IMAP connection and the app-specific password, and that split is the
 * security design rather than a packaging choice.
 *
 * ```ts
 * const mailbox = await connectMailbox({
 *   host: env.IMAP_HOST,
 *   port: Number(env.IMAP_PORT),
 *   username: env.IMAP_USER,
 *   password: env.IMAP_PASSWORD,
 *   enable: ["CONDSTORE"],
 * });
 * const folder = await mailbox.selectFolder("Archive", { readOnly: true });
 * const messages = await mailbox.fetchMessages({ uids: { from: 1, to: 50 } });
 * await mailbox.close();
 * ```
 */

export { connectMailbox } from "./cf-imap-mailbox";
export {
  ImapAuthError,
  ImapProtocolError,
  ImapTimeoutError,
  MailboxError,
  // Exported for the sync worker's logger: every line it emits goes through
  // these, so a credential cannot escape through a log call this package never
  // sees. The scrubbing inside this package is unaffected by that.
  passwordForms,
  redactSecrets,
} from "./errors";
export type {
  AppendedMessage,
  AppendOptions,
  CopyResult,
  FetchOptions,
  FlagMode,
  FolderState,
  Mailbox,
  MailboxAttachment,
  MailboxConfig,
  MailboxFolder,
  MailboxMessage,
  MessageFlags,
  SearchCriteria,
  UidRange,
  UidSet,
} from "./types";
export { formatUidSet, MAX_UID } from "./uids";
