/**
 * The contract for the three write tools (#12).
 *
 * The seam between the tool layer (src/mcp/writes.ts), which resolves ids and
 * writes the audit rows, and the mailbox layer (src/sync/writes.ts), which
 * holds every refusal. It used to be a package sitting between two Workers so
 * that the internet-facing one never imported the one holding the credential;
 * the Workers merged (#34), but the seam stays, because it is what the tool
 * tests inject a fake through and where the policy constants live.
 *
 * Types only, beyond two frozen constants — nothing exported here can reach a
 * socket, a database or a log line.
 */

/**
 * A message as this system addresses it: the D1 row id, plus the coordinates
 * that identify it on the server.
 *
 * Both, deliberately. The uid triple is what IMAP acts on; the id is what the
 * audit row points at, and what a model actually holds after a search. The tool
 * layer resolves one into the other, so the mailbox layer never reads `messages`
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
 * `AuthOutcome`: the caller has to look at `ok` to reach the value, so a
 * refusal cannot be walked past by forgetting a `catch`.
 *
 * `detail` and `reason` are both written into the audit row, so neither may
 * ever carry any part of the app-specific password.
 */
export type WriteOutcome =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The whole of what the MCP tools may ask the mailbox layer to do.
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
