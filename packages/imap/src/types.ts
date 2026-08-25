/**
 * The mailbox contract the rest of imap-mcp is written against.
 *
 * Nothing here mentions the underlying client library. That is the point: the
 * project is generic by design — host, port and credentials are configuration,
 * and swapping the IMAP client (or the provider) should be a change to
 * cf-imap-mailbox.ts alone.
 */

/**
 * Connection settings. Every value is supplied by the caller; there are no
 * provider constants in this package.
 */
export type MailboxConfig = {
  host: string;
  port: number;
  /**
   * Negotiate TLS. Defaults to true: port 993 gets implicit TLS (RFC 8314),
   * any other port upgrades with STARTTLS.
   */
  tls?: boolean;
  username: string;
  /**
   * The mailbox password. On iCloud this is an app-specific password granting
   * full mailbox access including SMTP send, so it is held in a closure and
   * scrubbed out of every error this package throws — see errors.ts.
   */
  password: string;
  /** Read timeout for a single IMAP response, in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Extensions to ENABLE, e.g. ["CONDSTORE"].
   *
   * Issued in the authenticated state, before the first SELECT, because
   * RFC 5161 requires that ordering and getting it wrong is silent: with
   * ENABLE after SELECT the server simply omits HIGHESTMODSEQ, which reads as
   * "no CONDSTORE support" and isn't. That is also why this is connection
   * configuration rather than a method — after a folder is selected it is too
   * late, so there is no way to call it too late.
   *
   * Detect what actually took effect from FolderState.highestModSeq, not from
   * the ENABLE reply: iCloud confirms an empty list while plainly having
   * enabled it.
   */
  enable?: string[];
};

/** A UID range. `to: "*"` means "the highest UID in the folder". */
export type UidRange = { from: number; to: number | "*" };

/**
 * Messages to act on, always by UID. Sequence numbers are deliberately not
 * accepted anywhere in this interface: they shift under any expunge, including
 * one made by another mail client mid-sync.
 */
export type UidSet = number | number[] | UidRange;

export type MailboxFolder = {
  name: string;
  /** Hierarchy delimiter, e.g. "/". Empty when the server reports NIL. */
  delimiter: string;
  /** Attributes with the leading backslash stripped, e.g. ["HasNoChildren"]. */
  attributes: string[];
};

/** What SELECT (or EXAMINE) reported about a folder. */
export type FolderState = {
  name: string;
  /** EXISTS — the number of messages in the folder. */
  exists: number;
  /** RECENT. Deprecated in IMAP4rev2; present for IMAP4rev1 servers. */
  recent: number;
  unseen?: number;
  uidNext?: number;
  /**
   * UIDVALIDITY. If this changes between syncs, every UID recorded for the
   * folder is meaningless and the folder must be re-synced from scratch (#8).
   */
  uidValidity?: number;
  /**
   * HIGHESTMODSEQ (CONDSTORE, RFC 7162). Its presence — not the ENABLE reply —
   * is how to tell that CONDSTORE is actually in effect for this folder.
   */
  highestModSeq?: number;
  /** The server said NOMODSEQ: this folder does not support mod-sequences. */
  noModSeq: boolean;
  flags: string[];
  permanentFlags: string[];
  readOnly: boolean;
};

export type MailboxAttachment = {
  filename: string;
  mimeType: string;
  /** Size of the decoded content in bytes. */
  size: number;
  /** The original Content-Transfer-Encoding, e.g. "base64". */
  encoding: string;
  /** Decoded content, re-encoded as base64 — the form R2 wants (#9). */
  contentBase64: string;
  contentId?: string;
  isInline: boolean;
};

/**
 * A message as this package hands it over: decoded, but not sanitized and not
 * wrapped in an untrusted-content envelope. Message bodies are
 * attacker-controlled text; framing them is the job of whatever hands them to
 * a model (#5, #7), not of the IMAP layer.
 */
export type MailboxMessage = {
  uid: number;
  /** Sequence number at fetch time. Recorded for debugging; never persist it. */
  seq: number;
  /** Flags with the leading backslash stripped, e.g. ["Seen", "Flagged"]. */
  flags: string[];
  internalDate: Date;
  /** RFC822.SIZE in bytes. */
  size: number;
  from: string[];
  to: string[];
  cc: string[];
  subject: string;
  messageId: string;
  contentType: string;
  /** All headers, lowercased names, unfolded, RFC 2047 encoded-words decoded. */
  headers: Record<string, string>;
  rawHeaders: string;
  text?: string;
  html?: string;
  /** The full raw message when the body was fetched, otherwise the headers. */
  raw: string;
  attachments: MailboxAttachment[];
};

export type FetchOptions = {
  uids: UidSet;
  /**
   * Fetch and parse the full message. When false only the header fields are
   * fetched — enough for flags, dates and envelopes.
   */
  includeBody?: boolean;
  /** Cap the fetched body at this many bytes. */
  byteLimit?: number;
};

/**
 * The SEARCH keys this project uses. Deliberately a small subset: on iCloud
 * server-side SEARCH is unusable for message content, so content search is
 * D1's job and this exists for date and flag windows (#6).
 */
export type SearchCriteria = {
  all?: boolean;
  /** INTERNALDATE on or after this date. */
  since?: Date;
  /** INTERNALDATE before this date. */
  before?: Date;
  /** Date: header on or after this date. */
  sentSince?: Date;
  /** Date: header before this date. */
  sentBefore?: Date;
  from?: string;
  to?: string;
  subject?: string;
  header?: { key: string; value: string };
  /** true matches SEEN, false matches UNSEEN. */
  seen?: boolean;
  /** true matches FLAGGED, false matches UNFLAGGED. */
  flagged?: boolean;
  /** true matches DELETED, false matches UNDELETED. */
  deleted?: boolean;
  largerThan?: number;
  smallerThan?: number;
  /** A UID set to restrict the search to. */
  uids?: UidSet;
};

export type FlagMode = "add" | "remove" | "replace";

/** The flags a message carries, as read back from the server after a write. */
export type MessageFlags = { uid: number; flags: string[] };

/** The COPYUID response code (RFC 9051 §7.1), if the server sent one. */
export type CopyResult = {
  /** UIDVALIDITY of the destination folder. */
  uidValidity: number;
  /** Source UID set, as the server reported it. */
  sourceUids: string;
  /** Destination UID set, as the server reported it. */
  destUids: string;
};

/** The APPENDUID response code (RFC 9051 §7.1), if the server sent one. */
export type AppendedMessage = { uidValidity: number; uid: number };

export type AppendOptions = {
  /** System flags without the backslash, e.g. ["Draft"]. */
  flags?: string[];
  internalDate?: Date;
};

export interface Mailbox {
  /** Capabilities the server advertised, e.g. ["IMAP4rev1", "UIDPLUS"]. */
  readonly capabilities: readonly string[];

  listFolders(namespace?: string, filter?: string): Promise<MailboxFolder[]>;

  selectFolder(name: string, options?: { readOnly?: boolean }): Promise<FolderState>;

  /** STATUS, for asking "is there anything new?" without selecting (#8). */
  status(
    name: string,
    items?: Array<"MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN">,
  ): Promise<Record<string, number>>;

  /**
   * Fetch messages by UID from the selected folder. Always non-mutating: this
   * interface has no way to fetch without PEEK, so indexing can never mark
   * mail as read (#5).
   */
  fetchMessages(options: FetchOptions): Promise<MailboxMessage[]>;

  /** Search the selected folder. Returns UIDs. */
  search(criteria: SearchCriteria): Promise<number[]>;

  /**
   * Set, clear or replace system flags, then read them back and return what
   * the server actually holds.
   *
   * The read-back is not belt-and-braces: under CONDSTORE the STORE
   * confirmation cannot be parsed by the underlying client at all (see
   * cf-imap-mailbox.ts), so it is the only truthful answer available.
   *
   * Flags are system flags without the leading backslash, e.g. ["Seen"].
   */
  setFlags(uids: UidSet, flags: string[], mode?: FlagMode): Promise<MessageFlags[]>;

  copy(uids: UidSet, target: string): Promise<CopyResult | null>;

  /**
   * UID EXPUNGE (RFC 9051 §6.4.9) over an explicit UID set — there is no
   * bare-EXPUNGE path in this interface, because a bare EXPUNGE also destroys
   * \Deleted messages another mail client marked and has not yet expunged (#12).
   */
  expunge(uids: UidSet): Promise<number[]>;

  append(
    folder: string,
    message: string | Uint8Array,
    options?: AppendOptions,
  ): Promise<AppendedMessage | null>;

  /** LOGOUT and close the socket. Safe to call on an already-dead connection. */
  close(): Promise<void>;
}
