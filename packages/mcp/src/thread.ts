/**
 * Thread reconstruction, from the index and nothing else.
 *
 * There is no `thread_id` column and no IMAP `THREAD` command in the picture:
 * a conversation is derived here, from the three headers the sync worker
 * records — Message-ID, In-Reply-To and References.
 *
 * What this returns is the *shape* of a conversation — identity, subject and a
 * short preview per message — never the bodies. Reading a thread must not be a
 * way to put fifty attacker-written bodies in front of a model in one call;
 * `get_message` serves one body at a time, by id, and that is the only path.
 */

import {
  GENERATION_GUARD,
  loadSeed,
  type MessageOutcome,
  PREVIEW_COLUMNS,
  type PreviewRow,
  type ThreadIdentity,
  type ThreadPreview,
  toPreview,
} from "./message";

/** As many messages as `search_messages` will return hits, and for the same reason. */
export const MAX_THREAD_MESSAGES = 50;

/**
 * How many Message-IDs of the seed's own ancestry are matched against.
 *
 * A mailing-list `References` header runs to hundreds of entries. Unbounded,
 * that is both a per-row cost on every candidate and a query that grows with
 * attacker-supplied input.
 */
export const MAX_THREAD_IDS = 32;

/**
 * Below this, the subject fallback does not run.
 *
 * A message subjected "Hi" would otherwise return an arbitrary slice of the
 * mailbox with a note claiming it was a conversation.
 */
const MIN_SUBJECT_CHARS = 8;

/** How far either side of the seed the subject fallback will look: 30 days. */
export const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How the messages were decided to belong together.
 *
 * Rendered outside the frame, because it is an assertion this server is making
 * about the mail rather than anything the mail said. `"subject"` in particular
 * has to be visible: it means the grouping is a guess.
 */
export type ThreadBasis = "references" | "subject" | "alone";

export type ThreadOutcome =
  | {
      ok: true;
      /** The id the caller named. Always present in `messages`. */
      seedId: number;
      basis: ThreadBasis;
      /** Oldest first, which is how a conversation reads. */
      messages: ThreadPreview[];
      /** True when older members were dropped to fit MAX_THREAD_MESSAGES. */
      truncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * A Message-ID as it appears in a header.
 *
 * A regex rather than `startsWith("<")` because `in_reply_to` is the raw header
 * value: it may hold several ids, or trailing comment text. Excluding the
 * brackets from the body of the match means a malformed `<a<b@x>c>` yields the
 * well-formed id inside rather than a nesting mess, and the length bound stops
 * a pathological header producing one enormous "id".
 */
const MESSAGE_ID = /<[^<>\s]{1,512}>/gu;

/**
 * Reply and forward prefixes, in the languages a mailbox actually sees.
 *
 * The outer `+` repeats, so "Re: Fwd: Re:" strips in one pass, and `\[\d+\]`
 * catches the "Re[2]:" some clients emit. The `:` is required, so a subject
 * that merely starts with the letters — "Reference numbers" — is left alone.
 */
const REPLY_PREFIX =
  /^\s*(?:(?:re|aw|fw|fwd|wg|sv|vs|antw|odp|rif|res|tr)\s*(?:\[\d+\])?\s*:\s*)+/iu;

export function normaliseSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Every Message-ID the seed's own headers name: itself, its parent, its ancestry.
 *
 * `reference_ids` is JSON this repo wrote, but a backfill or a hand-fix could
 * leave anything there and a throw would take the tool down with it.
 */
export function identityClosure(seed: ThreadIdentity): string[] {
  const ids: string[] = [];
  const collect = (value: string | null | undefined) => {
    if (value) ids.push(...(value.match(MESSAGE_ID) ?? []));
  };

  collect(seed.rfcMessageId);
  collect(seed.inReplyTo);
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(seed.referenceIds);
  } catch {
    parsed = [];
  }
  if (Array.isArray(parsed))
    for (const value of parsed) collect(typeof value === "string" ? value : null);

  const unique = [...new Set(ids)];
  if (unique.length <= MAX_THREAD_IDS) return unique;

  // References is ordered oldest first, so the head is the thread root — the one
  // id every conformant member of the thread carries — and the tail is the
  // immediate ancestry. The middle is the part both ends already imply.
  const half = MAX_THREAD_IDS / 2;
  return [...unique.slice(0, half), ...unique.slice(-half)];
}

/**
 * The header pass: one query, one round.
 *
 * RFC 5322 §3.6.4 makes a conformant reply's References the parent's References
 * plus the parent's Message-ID, so every conformant member of a thread carries
 * the root and the seed's closure contains it. One query therefore reaches
 * ancestors, siblings and descendants at any depth at once. Iterating a
 * transitive closure would buy only the clients that truncate References, at
 * the price of another full scan per round — and those clients are exactly what
 * the subject fallback is for.
 *
 * The honest cost of that: a *partly* broken thread stays partial, because the
 * fallback fires only when this pass finds nothing at all.
 */
const HEADER_PASS = `
  WITH ids(value) AS (SELECT value FROM json_each(?1))
  SELECT ${PREVIEW_COLUMNS}
  FROM messages m
  JOIN folders f ON f.id = m.folder_id
  WHERE ${GENERATION_GUARD}
    AND ( m.rfc_message_id IN (SELECT value FROM ids)
       -- json_valid() inside json_each's argument rather than as an AND guard:
       -- SQLite's evaluation order is not contractual, and one row holding
       -- non-JSON would otherwise throw "malformed JSON" and take the whole
       -- query with it.
       OR EXISTS (
            SELECT 1 FROM json_each(
              CASE WHEN json_valid(m.reference_ids) THEN m.reference_ids ELSE '[]' END) AS r
            WHERE r.value IN (SELECT value FROM ids))
       -- instr(), because in_reply_to is the raw header and can hold more than
       -- one id or trailing comment text. The other two columns hold exact
       -- values and are matched exactly.
       OR (m.in_reply_to IS NOT NULL
           AND EXISTS (SELECT 1 FROM ids WHERE instr(m.in_reply_to, ids.value) > 0)) )
  ORDER BY m.internal_date DESC, m.id DESC
  LIMIT ?2`;

/**
 * The fallback: same normalised subject, near the same time.
 *
 * SQL narrows and TypeScript decides. `instr(lower(subject), needle)` is a
 * superset test — it matches "Re: X", "Fwd: Re: X" and the unrelated "X meeting
 * notes" alike — and every row it returns is re-checked for exact equality on
 * the normalised subject. Two known imprecisions in the prefilter, SQLite's
 * ASCII-only lower() and irregular internal whitespace, can only cause a miss,
 * never a false include, because the check in TypeScript is what decides.
 */
const SUBJECT_PASS = `
  SELECT ${PREVIEW_COLUMNS}
  FROM messages m
  JOIN folders f ON f.id = m.folder_id
  WHERE ${GENERATION_GUARD}
    AND m.internal_date BETWEEN ?1 AND ?2
    AND instr(lower(m.subject), ?3) > 0
  ORDER BY m.internal_date DESC, m.id DESC
  LIMIT ?4`;

export async function getThread(db: D1Database, input: { id: number }): Promise<ThreadOutcome> {
  const seeded: MessageOutcome<ThreadPreview> = await loadSeed(db, input.id);
  if (!seeded.ok) return { ok: false, reason: seeded.reason };
  const seed = seeded.message;

  const closure = identityClosure(seed);
  let basis: ThreadBasis = "references";
  let rows = closure.length === 0 ? [] : await headerPass(db, closure);

  if (rows.every((row) => row.id === seed.id)) {
    const subject = normaliseSubject(seed.subject);
    rows = subject.length < MIN_SUBJECT_CHARS ? [] : await subjectPass(db, seed, subject);
    basis = "subject";
  }

  const messages = new Map<number, ThreadPreview>();
  // The seed goes in first so the message the caller actually named survives
  // the cap, even when it is older than every other member. The rows arrive
  // newest first, so filling to the cap from there keeps the recent end of a
  // conversation, which is the end worth keeping.
  messages.set(seed.id, seed);
  let truncated = false;
  for (const row of rows) {
    if (messages.has(row.id)) continue;
    if (messages.size >= MAX_THREAD_MESSAGES) {
      truncated = true;
      continue;
    }
    messages.set(row.id, toPreview(row));
  }

  if (messages.size === 1) basis = "alone";

  return {
    ok: true,
    seedId: seed.id,
    basis,
    // Ordered on internal_date, never sent_date: sent_date is a value the sender
    // chose, and a message claiming a Date a year hence would otherwise place
    // itself last in every thread it appears in — immediately before whatever
    // conclusion a model is about to draw. The id breaks ties, so the copies of
    // one message in several folders order stably.
    messages: [...messages.values()].sort(
      (left, right) => left.internalDate - right.internalDate || left.id - right.id,
    ),
    truncated,
  };
}

async function headerPass(db: D1Database, closure: string[]): Promise<PreviewRow[]> {
  // The whole closure binds as one JSON array rather than as placeholders: three
  // arms need the same list, and expanding it would be ninety-odd bound
  // parameters for a query that reads better with one.
  const { results } = await db
    .prepare(HEADER_PASS)
    .bind(JSON.stringify(closure), MAX_THREAD_MESSAGES + 1)
    .all<PreviewRow>();
  return results;
}

async function subjectPass(
  db: D1Database,
  seed: ThreadPreview,
  subject: string,
): Promise<PreviewRow[]> {
  const { results } = await db
    .prepare(SUBJECT_PASS)
    .bind(
      seed.internalDate - SUBJECT_WINDOW_MS,
      seed.internalDate + SUBJECT_WINDOW_MS,
      subject,
      MAX_THREAD_MESSAGES + 1,
    )
    .all<PreviewRow>();
  return results.filter((row) => normaliseSubject(row.subject) === subject);
}
