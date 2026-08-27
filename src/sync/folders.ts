/**
 * Which folder a write is allowed to touch.
 *
 * Both questions here are answered from one `LIST` rather than from
 * configuration, because configuration cannot tell you what the mailbox
 * actually contains — and both of the things this module decides are things a
 * wrong answer makes irreversible.
 */

import type { MailboxFolder } from "../imap";
import { DENIED_DESTINATIONS } from "../writes";

/**
 * A folder, or the reason the caller cannot have it.
 *
 * Same shape as WriteOutcome and SearchOutcome: the name is unreachable without
 * looking at `ok`, so a refusal cannot be walked past.
 */
export type FolderChoice =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The last segment of a folder path, lowercased.
 *
 * Nested, because `INBOX/Trash` is a Trash folder and `Archive/Junk mail` is
 * not one this system should be moving into either. The delimiter comes off
 * the LIST response rather than being assumed: it is "/" on iCloud and "." on
 * plenty of other servers.
 */
function leaf(folder: MailboxFolder): string {
  const parts = folder.delimiter ? folder.name.split(folder.delimiter) : [folder.name];
  return (parts.at(-1) ?? folder.name).trim().toLowerCase();
}

function hasAttribute(folder: MailboxFolder, attribute: string): boolean {
  return folder.attributes.some((candidate) => candidate.toLowerCase() === attribute);
}

/**
 * Matched exactly first, then case-insensitively.
 *
 * Exact-first matters: IMAP folder names are case-sensitive, so a mailbox may
 * genuinely hold both `Saved` and `saved`, and picking the wrong one would file
 * mail somewhere the caller cannot see. The insensitive pass exists only
 * because a model asked for "drafts" should not fail on the capital.
 */
function byName(folders: readonly MailboxFolder[], name: string): MailboxFolder | undefined {
  const wanted = name.trim();
  return (
    folders.find((folder) => folder.name === wanted) ??
    folders.find((folder) => folder.name.toLowerCase() === wanted.toLowerCase())
  );
}

/**
 * Where a message may be moved.
 *
 * The allowlist is the mailbox itself minus a fixed denylist, which is the
 * narrowest useful answer: a caller can file mail anywhere it could already
 * read it, and the worst an injected instruction achieves is misfiling
 * something recoverable. Trash and Junk are excluded because neither is
 * recoverable in the same sense — iCloud empties Trash on a 30-day timer, and
 * mail in Junk stops being read long before that.
 *
 * Two independent tests for the same thing, deliberately. The attribute is the
 * right answer and the name is the one that works: iCloud does not reliably
 * advertise `\Trash` or `\Junk`, so a check that trusted attributes alone would
 * pass a folder plainly called Trash.
 */
export function resolveDestination(
  folders: readonly MailboxFolder[],
  requested: string,
  source: string,
): FolderChoice {
  const folder = byName(folders, requested);
  if (!folder) {
    return { ok: false, reason: `No folder named ${JSON.stringify(requested)} on the server.` };
  }
  if (folder.name === source) {
    return { ok: false, reason: `That message is already in ${folder.name}.` };
  }
  if (
    DENIED_DESTINATIONS.includes(leaf(folder) as (typeof DENIED_DESTINATIONS)[number]) ||
    hasAttribute(folder, "trash") ||
    hasAttribute(folder, "junk")
  ) {
    return {
      ok: false,
      reason:
        `${folder.name} is not an allowed destination. Moves into Trash and Junk are ` +
        "refused, because this server has no way to undo one.",
    };
  }
  return { ok: true, name: folder.name };
}

/**
 * Where a draft is appended.
 *
 * By attribute where the server offers one, and by name where it does not —
 * iCloud advertises no `\Drafts` special-use at all, so the literal-name
 * fallback is the path that actually runs in production rather than a
 * defensive extra. DRAFTS_FOLDER overrides both, for a mailbox whose drafts
 * folder is called neither.
 */
export function resolveDrafts(
  folders: readonly MailboxFolder[],
  override: string | undefined,
): FolderChoice {
  if (override) {
    const folder = byName(folders, override);
    if (!folder) {
      return {
        ok: false,
        reason: `DRAFTS_FOLDER names ${JSON.stringify(override)}, which the server does not have.`,
      };
    }
    return { ok: true, name: folder.name };
  }

  const special = folders.find((folder) => hasAttribute(folder, "drafts"));
  if (special) return { ok: true, name: special.name };

  const named = folders.find((folder) => leaf(folder) === "drafts");
  if (named) return { ok: true, name: named.name };

  return {
    ok: false,
    reason:
      "No Drafts folder found: no folder advertises \\Drafts and none is named Drafts. Set DRAFTS_FOLDER.",
  };
}
