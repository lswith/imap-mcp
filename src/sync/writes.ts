/**
 * The three writes this system can make to a mailbox (#12).
 *
 * Everything a caller can be refused is refused here rather than in the MCP
 * server. Policy belongs with the credential: this is the only worker that can
 * reach the mailbox, so a check that lives here is one there is no path around,
 * whereas a check in the caller is a check an injected instruction only has to
 * get past one layer of.
 *
 * Three properties hold across all of it and none is incidental:
 *
 *   - Nothing here can send. There is no SMTP client anywhere in this repo.
 *   - Nothing here can delete. `\Deleted` is set in exactly one function, over
 *     exactly one uid, immediately after that uid has been copied somewhere
 *     else, and only once the server has confirmed the copy with COPYUID.
 *   - Every flag write is believed only after reading it back. cf-imap cannot
 *     parse the STORE confirmation once CONDSTORE is on (#8 wants it on
 *     session-wide), so the STORE response is not merely weak evidence — it is
 *     empty.
 *
 * Expected refusals are returned, not thrown. These calls arrive over a service
 * binding, and a rejected RPC promise reaches the other side as a bare Error
 * with the shape of the failure lost.
 */

import type { Mailbox, MessageFlags } from "../imap";
import {
  ALLOWED_FLAGS,
  type DraftRequest,
  type FlagRequest,
  type MessageTarget,
  type MoveRequest,
  type WriteOutcome,
} from "../writes";
import type { SyncConfig } from "./config";
import { buildDraft } from "./draft";
import { resolveDestination, resolveDrafts } from "./folders";
import type { Logger } from "./log";
import { deleteMessage } from "./store";

const ALLOWED = new Set<string>(ALLOWED_FLAGS);

function refuse(reason: string): WriteOutcome {
  return { ok: false, reason };
}

/**
 * Opens the folder for writing, and refuses if it is not the one the caller
 * meant.
 *
 * The same guard the queue consumer applies before storing a range: a folder
 * that has been renumbered since the search that produced this id has every uid
 * pointing at a different message, so acting on one would apply the caller's
 * intent to a message they never saw. Refusing costs them a re-search.
 */
async function open(mailbox: Mailbox, target: MessageTarget): Promise<WriteOutcome | undefined> {
  const state = await mailbox.selectFolder(target.folder, { readOnly: false });
  const uidValidity = state.uidValidity ?? 0;
  if (uidValidity !== target.uidValidity) {
    return refuse(
      `${target.folder} has UIDVALIDITY ${uidValidity}, not ${target.uidValidity}: it was ` +
        "renumbered since this message was indexed, so uid " +
        `${target.uid} no longer names it. Search again.`,
    );
  }
  return undefined;
}

/** The flags the server holds for one uid, or nothing if it holds no such uid. */
function flagsFor(verified: MessageFlags[], uid: number): string[] | undefined {
  return verified.find((entry) => entry.uid === uid)?.flags;
}

export async function flagMessage(
  mailbox: Mailbox,
  request: FlagRequest,
  log: Logger,
): Promise<WriteOutcome> {
  const add = request.add ?? [];
  const remove = request.remove ?? [];

  if (add.length === 0 && remove.length === 0) {
    return refuse("Nothing to do: name at least one flag to set or to clear.");
  }
  const unknown = [...add, ...remove].filter((flag) => !ALLOWED.has(flag));
  if (unknown.length > 0) {
    return refuse(
      `Cannot set ${unknown.map((flag) => JSON.stringify(flag)).join(", ")}. ` +
        `Only ${ALLOWED_FLAGS.join(", ")} may be changed — \\Deleted in particular is not ` +
        "settable, because this system cannot delete mail.",
    );
  }
  const both = add.filter((flag) => remove.includes(flag));
  if (both.length > 0) {
    return refuse(`${both.join(", ")} appears in both add and remove.`);
  }

  const rejected = await open(mailbox, request);
  if (rejected) return rejected;

  let verified: MessageFlags[] = [];
  if (add.length > 0) verified = await mailbox.setFlags(request.uid, add, "add");
  if (remove.length > 0) verified = await mailbox.setFlags(request.uid, remove, "remove");

  const held = flagsFor(verified, request.uid);
  if (!held) {
    return refuse(
      `uid ${request.uid} is no longer in ${request.folder}. It may have been moved or ` +
        "deleted by another mail client.",
    );
  }

  // The read-back is the assertion, not a formality. A server that accepted the
  // STORE and changed nothing is indistinguishable from a success on the wire.
  const missing = add.filter((flag) => !held.includes(flag));
  const lingering = remove.filter((flag) => held.includes(flag));
  if (missing.length > 0 || lingering.length > 0) {
    log.warn(`${request.folder}: uid ${request.uid} did not take the flag change`);
    return refuse(
      `The server accepted the change but ${[...missing, ...lingering].join(", ")} did not ` +
        `take: uid ${request.uid} still carries ${held.join(", ") || "no flags"}.`,
    );
  }

  return {
    ok: true,
    detail: `uid ${request.uid} in ${request.folder} now carries ${held.join(", ") || "no flags"}`,
  };
}

/**
 * COPY, then STORE \Deleted, then UID EXPUNGE — iCloud offers no MOVE.
 *
 * The order is the whole safety argument and each step gates the next. The copy
 * happens first so nothing is marked for deletion that does not already exist
 * elsewhere; the copy must be confirmed by COPYUID, because without one nothing
 * has said it landed; the `\Deleted` write is read back before the expunge, so a
 * flag that did not take cannot be followed by a command that removes messages.
 *
 * The expunge is UID EXPUNGE over the single uid, which the Mailbox interface
 * makes the only option available. A bare EXPUNGE sweeps every `\Deleted`
 * message in the folder, including ones another mail client marked and has not
 * yet expunged — that is the difference between moving one message and silently
 * destroying somebody's pending deletions.
 */
export async function moveMessage(
  db: D1Database,
  mailbox: Mailbox,
  request: MoveRequest,
  log: Logger,
): Promise<WriteOutcome> {
  const destination = resolveDestination(
    await mailbox.listFolders(),
    request.destination,
    request.folder,
  );
  if (!destination.ok) return refuse(destination.reason);

  const rejected = await open(mailbox, request);
  if (rejected) return rejected;

  const copied = await mailbox.copy(request.uid, destination.name);
  if (!copied) {
    return refuse(
      `The server copied uid ${request.uid} to ${destination.name} without a COPYUID, so ` +
        "nothing has confirmed the copy landed. The message was left where it is.",
    );
  }

  const verified = await mailbox.setFlags(request.uid, ["Deleted"], "add");
  if (!flagsFor(verified, request.uid)?.includes("Deleted")) {
    log.warn(`${request.folder}: uid ${request.uid} would not take \\Deleted; not expunging`);
    return refuse(
      `The copy to ${destination.name} succeeded, but uid ${request.uid} would not take ` +
        "\\Deleted, so the original was left in place. There are now two copies.",
    );
  }

  // The expunge is confirmed before the index row is dropped, and the order
  // matters more than it looks. Another mail client can clear \Deleted between
  // the read-back above and this command, in which case UID EXPUNGE removes
  // nothing and says so — and deleting the row anyway would make a message that
  // is still sitting in the source folder unfindable, which is the one outcome
  // a move must never produce.
  const expunged = await mailbox.expunge(request.uid);
  if (expunged.length === 0) {
    log.warn(`${request.folder}: uid ${request.uid} was not expunged; leaving the index row`);
    return refuse(
      `The copy to ${destination.name} succeeded, but uid ${request.uid} is still in ` +
        `${request.folder}: the server expunged nothing, so something cleared \\Deleted in ` +
        "between. There are now two copies.",
    );
  }

  await deleteMessage(db, request.messageId);

  return {
    ok: true,
    detail: `uid ${request.uid} moved from ${request.folder} to ${destination.name} as uid ${copied.destUids}`,
  };
}

export async function createDraft(
  mailbox: Mailbox,
  request: DraftRequest,
  config: SyncConfig,
  log: Logger,
): Promise<WriteOutcome> {
  const built = buildDraft(request, config.draftFrom);
  if (!built.ok) return refuse(built.reason);

  const drafts = resolveDrafts(await mailbox.listFolders(), config.draftsFolder);
  if (!drafts.ok) return refuse(drafts.reason);

  // \Seen alongside \Draft: a draft you wrote yourself is not unread mail, and
  // Apple Mail shows it as one otherwise.
  const appended = await mailbox.append(drafts.name, built.message, { flags: ["Draft", "Seen"] });
  if (!appended) {
    log.warn(`${drafts.name}: APPEND returned no APPENDUID`);
    return {
      ok: true,
      detail: `draft saved to ${drafts.name} (the server reported no uid for it)`,
    };
  }
  return { ok: true, detail: `draft saved to ${drafts.name} as uid ${appended.uid}` };
}
