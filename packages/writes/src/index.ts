/**
 * The contract for the three write tools (#12).
 *
 * A package rather than a shared file, and a package that imports nothing at
 * all, because of where it has to sit. `packages/sync` owns the IMAP
 * connection and the app-specific password; `packages/mcp` must never depend on
 * `@imap-mcp/imap` and so cannot import sync's types either. This is the one
 * thing both may hold.
 *
 * Types only. There is no runtime code here beyond two frozen constants, so
 * nothing this package exports can reach a socket, a database or a log line.
 *
 * `WriteEntrypoint` in packages/sync declares `implements WriteService`, and
 * packages/mcp types its service binding as the same interface. RPC over a
 * service binding is structurally typed at the boundary — a renamed field would
 * otherwise compile on both sides and fail only in production — so that
 * declaration is what turns drift into a red build.
 */

/**
 * A message as this system addresses it: the D1 row id, plus the coordinates
 * that identify it on the server.
 *
 * Both, deliberately. The uid triple is what IMAP acts on; the id is what the
 * audit row points at, and what a model actually holds after a search. The MCP
 * server resolves one into the other, so the sync worker never reads `messages`
 * and the mailbox is addressed by uid exactly as it is everywhere else.
 *
 * `uidValidity` rides along so the write can be refused rather than misapplied
 * when a folder has been renumbered since the search that produced the id.
 */
export type MessageTarget = {
  /** `messages.id` in D1. */
  messageId: number;
  /** Full IMAP path of the folder the message is in. */
  folder: string;
  uidValidity: number;
  uid: number;
};

/**
 * Flags a caller may set or clear.
 *
 * An allowlist rather than a denylist, and short on purpose. `\Deleted` is the
 * obvious exclusion — setting it is how a message disappears from every mail
 * client, and how another client's bare `EXPUNGE` destroys it — but a denylist
 * would still have admitted arbitrary keywords, which are a way to write
 * attacker-chosen text into a mailbox. These three are the flags a mail
 * assistant has any business touching, and every one of them flips back.
 */
export const ALLOWED_FLAGS = ["Seen", "Flagged", "Answered"] as const;

export type AllowedFlag = (typeof ALLOWED_FLAGS)[number];

/**
 * Folders no message may be moved into, by the leaf of their name.
 *
 * The whole point of the allowlist is that the worst an injected instruction
 * achieves is misfiling something recoverable. A move into Trash or Junk is
 * neither: iCloud empties Trash on a 30-day timer, and Junk is where mail goes
 * to stop being read. Matched case-insensitively against the leaf, so
 * `INBOX/Trash` is caught as well as `Trash`; the `\Trash` and `\Junk`
 * special-use attributes are checked separately, because iCloud does not
 * reliably advertise them.
 */
export const DENIED_DESTINATIONS = [
  "trash",
  "deleted messages",
  "junk",
  "junk e-mail",
  "spam",
  "bulk mail",
] as const;

export type FlagRequest = MessageTarget & {
  /** Flags to set. Must all be in {@link ALLOWED_FLAGS}. */
  add?: string[];
  /** Flags to clear. Must all be in {@link ALLOWED_FLAGS}. */
  remove?: string[];
};

export type MoveRequest = MessageTarget & {
  /** Full IMAP path of the destination folder. */
  destination: string;
};

/**
 * A draft to append, already resolved.
 *
 * The threading headers arrive fully formed rather than as "reply to message
 * 412": working out an In-Reply-To means reading `messages`, and the sync
 * worker deliberately does not.
 */
export type DraftRequest = {
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  /** RFC 5322 Message-ID of the message being replied to, angle brackets included. */
  inReplyTo?: string;
  /** The References header's contents, in order, angle brackets included. */
  references?: string[];
};

/**
 * What a write did.
 *
 * An outcome rather than a thrown error, matching `SearchOutcome` and
 * `AccessConfigOutcome`: the caller has to look at `ok` to reach the value, so
 * a refusal cannot be walked past by forgetting a `catch`. It also has to cross
 * a service binding, and a rejected RPC promise arrives as a bare `Error` with
 * the shape of the failure lost.
 *
 * `detail` and `reason` are both written into the audit row, so neither may
 * ever carry any part of the app-specific password.
 */
export type WriteOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The whole of what the MCP server may ask the sync worker to do.
 *
 * Three methods, and there is no fourth. There is no send — this system has no
 * SMTP client at all — and no delete: `\Deleted` is reachable only inside
 * `moveMessage`, over the single uid it has just copied somewhere else.
 */
export interface WriteService {
  flagMessage(request: FlagRequest): Promise<WriteOutcome>;
  moveMessage(request: MoveRequest): Promise<WriteOutcome>;
  createDraft(request: DraftRequest): Promise<WriteOutcome>;
}
