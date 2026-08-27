/**
 * The three write tools (#12).
 *
 * This layer performs no write. It resolves a message id into the uid
 * coordinates IMAP addresses messages by, records the attempt, hands the
 * request to the write service (src/sync/handlers.ts), and records what came
 * back.
 *
 * Nothing here decides whether a write is allowed. That judgement lives in the
 * mailbox layer, src/sync/writes.ts — a check on this side is a check an
 * injected instruction only has to get past one layer of, and there is no
 * second layer here. Keeping every refusal on the far side of the `WriteService`
 * interface is what this split meant when it was a service binding, and it is
 * still what makes the policy assertable in one place now that the call is
 * direct.
 */

import type {
  DraftRequest,
  FlagRequest,
  MessageTarget,
  MoveRequest,
  WriteOutcome,
  WriteService,
} from "../writes";
import { recordAttempt, recordOutcome } from "./audit";

/** How many prior Message-IDs a reply carries. Long References headers are refused by some servers. */
const MAX_REFERENCES = 20;

type Resolved =
  | { readonly ok: true; readonly target: MessageTarget }
  | { readonly ok: false; readonly reason: string };

type ReplyContext = {
  subject: string;
  rfcMessageId: string | null;
  references: string[];
};

function refuse(reason: string): WriteOutcome {
  return { ok: false, reason };
}

/**
 * A message id, as uid coordinates.
 *
 * Joined on the folder's current UIDVALIDITY, the same way search is: a folder
 * that has been renumbered leaves the previous generation of rows in `messages`
 * rather than colliding with them, and each of those uids now names a different
 * message or none at all. Search merely hides them. A write has to refuse them,
 * because acting on one applies the caller's intent to a message they never saw.
 */
async function resolve(db: D1Database, messageId: number): Promise<Resolved> {
  const row = await db
    .prepare(
      `SELECT m.id AS messageId, f.name AS folder, m.uidvalidity AS uidValidity, m.uid
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = ? AND (f.uidvalidity IS NULL OR m.uidvalidity = f.uidvalidity)`,
    )
    .bind(messageId)
    .first<MessageTarget>();

  if (!row) {
    return {
      ok: false,
      reason:
        `No message ${messageId} in the index. Use an id from a search result — and if that ` +
        "search was a while ago, run it again: the folder may have been re-indexed since.",
    };
  }
  return { ok: true, target: row };
}

/** The Access identity, or null. A failure here must not stop the write. */
async function actorOf(access: CloudflareAccessContext | undefined): Promise<string | null> {
  try {
    return (await access?.getIdentity())?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Everything a write does around the write itself.
 *
 * `prepare` runs first and may refuse — a message id that is not in the index
 * gets an audit row and no call to the service. Whatever it returns, one row is written before
 * the call and updated after it, so there is no path through this function that
 * performs a write without recording it.
 */
async function audited<T>(
  env: Env,
  service: WriteService,
  access: CloudflareAccessContext | undefined,
  tool: string,
  args: unknown,
  prepare: () => Promise<
    { ok: true; request: T; target?: MessageTarget } | { ok: false; reason: string }
  >,
  call: (service: WriteService, request: T) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  const prepared = await prepare();
  const actor = await actorOf(access);
  const attempt = {
    tool,
    actor,
    args,
    ...(prepared.ok && prepared.target ? { target: prepared.target } : {}),
  };
  const id = await recordAttempt(env.DB, attempt);

  const outcome = await run(service, prepared, call);
  await recordOutcome(env.DB, id, outcome);
  return outcome;
}

async function run<T>(
  service: WriteService,
  prepared: { ok: true; request: T; target?: MessageTarget } | { ok: false; reason: string },
  call: (service: WriteService, request: T) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  if (!prepared.ok) return refuse(prepared.reason);

  try {
    return await call(service, prepared.request);
  } catch (error) {
    // The service reports expected failures as outcomes, so a throw is a bug
    // on its way past the audit row — there is nothing to classify, only
    // something to record.
    return refuse(
      `The write could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type FlagInput = { messageId: number; add?: string[]; remove?: string[] };
export type MoveInput = { messageId: number; destination: string };
export type DraftInput = {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
  inReplyTo?: number;
};

export function flagMessage(
  env: Env,
  service: WriteService,
  access: CloudflareAccessContext | undefined,
  input: FlagInput,
): Promise<WriteOutcome> {
  return audited<FlagRequest>(
    env,
    service,
    access,
    "flag_message",
    input,
    async () => {
      const resolved = await resolve(env.DB, input.messageId);
      if (!resolved.ok) return resolved;
      const request: FlagRequest = { ...resolved.target };
      if (input.add) request.add = input.add;
      if (input.remove) request.remove = input.remove;
      return { ok: true, request, target: resolved.target };
    },
    (service, request) => service.flagMessage(request),
  );
}

export function moveMessage(
  env: Env,
  service: WriteService,
  access: CloudflareAccessContext | undefined,
  input: MoveInput,
): Promise<WriteOutcome> {
  return audited<MoveRequest>(
    env,
    service,
    access,
    "move_message",
    input,
    async () => {
      const resolved = await resolve(env.DB, input.messageId);
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        request: { ...resolved.target, destination: input.destination },
        target: resolved.target,
      };
    },
    (service, request) => service.moveMessage(request),
  );
}

/**
 * The message a reply threads under.
 *
 * Read here rather than in the mailbox layer for the same reason the uid
 * coordinates are: working it out means reading `messages`, and the mailbox
 * layer deliberately does not. What crosses the seam is a finished In-Reply-To
 * and a finished References list.
 *
 * Joined on the folder's current UIDVALIDITY, exactly as `resolve` is. A reply
 * is a message-targeted write like the other two, and a stale generation is as
 * wrong here as it is there: the id would still name a row, but the subject and
 * threading headers would come from a message that is no longer what the caller
 * searched for.
 */
async function replyContext(db: D1Database, messageId: number): Promise<ReplyContext | undefined> {
  const row = await db
    .prepare(
      `SELECT m.subject, m.rfc_message_id AS rfcMessageId, m.reference_ids AS referenceIds
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.id = ? AND (f.uidvalidity IS NULL OR m.uidvalidity = f.uidvalidity)`,
    )
    .bind(messageId)
    .first<{ subject: string; rfcMessageId: string | null; referenceIds: string }>();
  if (!row) return undefined;

  let references: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.referenceIds);
    if (Array.isArray(parsed))
      references = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    references = [];
  }
  return { subject: row.subject, rfcMessageId: row.rfcMessageId, references };
}

/** "Re: " unless the subject already says so — in whatever case it says it. */
function replySubject(subject: string): string {
  return /^\s*re\s*:/iu.test(subject) ? subject : `Re: ${subject}`;
}

export function createDraft(
  env: Env,
  service: WriteService,
  access: CloudflareAccessContext | undefined,
  input: DraftInput,
): Promise<WriteOutcome> {
  return audited<DraftRequest>(
    env,
    service,
    access,
    "create_draft",
    input,
    async () => {
      const request: DraftRequest = { to: input.to ?? [], body: input.body };
      if (input.cc) request.cc = input.cc;
      if (input.subject) request.subject = input.subject;

      if (input.inReplyTo !== undefined) {
        const context = await replyContext(env.DB, input.inReplyTo);
        if (!context) {
          return {
            ok: false,
            reason: `No message ${input.inReplyTo} in the index to reply to. Use an id from a search result.`,
          };
        }
        if (!request.subject) request.subject = replySubject(context.subject);
        if (context.rfcMessageId) {
          request.inReplyTo = context.rfcMessageId;
          request.references = [...context.references, context.rfcMessageId].slice(-MAX_REFERENCES);
        }
      }
      return { ok: true, request };
    },
    (service, request) => service.createDraft(request),
  );
}
