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
 * A runaway guard on the scan, not a result limit.
 *
 * The scan reads two short columns, so it can afford to be wide — and it has to
 * be, because a limit small enough to matter is a limit that decides which
 * rows the exact check sees. This number exists so a pathological window cannot
 * read without bound; reaching it is reported as truncation rather than passed
 * off as a finished search.
 */
export const SUBJECT_CANDIDATES = 500;

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
 * SQL narrows and TypeScript decides — and the shape below exists because
 * those two sentences were not actually true of each other. While the
 * candidate query carried both the previews and the row limit, whatever it cut
 * was never judged: any subject its prefilter admitted and the exact check
 * rejected was a slot a genuine older reply could have had. Three rounds of
 * tightening the prefilter each moved the decoy's shape rather than removing
 * it — "X — daily digest 47", then "Weekly X", then "URGENT: X" — because no
 * expression SQLite can write is `normaliseSubject`, and anything short of it
 * admits *something* the check will reject.
 *
 * So the limit no longer decides. The scan below reads identity and subject
 * only — no previews, so a wide read is cheap — TypeScript filters it exactly,
 * and only the rows that survived are fetched in full. A decoy can now cost a
 * row in the scan; it cannot cost a genuine reply its place.
 *
 * What is left for SQL is a **superset test**, and that is all it has to be:
 * everything normalisation strips is a reply prefix ending in a colon, so an
 * exact match's key is either the needle itself or a colon followed by it.
 * Admitting more than that is now merely wasteful. It is still `=` against a
 * `substr`, never `LIKE`, so there is no pattern language for a subject to
 * smuggle a wildcard through: `_` is common in real subjects.
 *
 * Whitespace is removed from both sides rather than collapsed, because
 * normalisation collapses it and a prefilter that disagreed would drop
 * "Re:  Report   from operations" before anything judged it. Removing rather
 * than collapsing because SQLite has no regex to collapse with, and every
 * character `\s` matches rather than the four obvious ones — see
 * `SUBJECT_WHITESPACE`.
 *
 * One imprecision remains, and it can only cause a miss, never a false
 * include, because TypeScript is what decides: **SQLite's `lower()` is
 * ASCII-only**, so two subjects differing only in the case of a non-ASCII
 * letter are invisible to each other here. workerd exposes no Unicode-aware
 * fold, so the fix is a normalised-subject column written at index time — a
 * schema change and a backfill, and therefore its own ticket. A test pins it.
 */

/**
 * Every character JavaScript's `\s` matches, as code points.
 *
 * This list is the single source of both halves of the whitespace agreement:
 * the SQL prefilter removes exactly these, and so does the needle it is
 * compared against. Writing it out matters because the two halves run in
 * different languages — `normaliseSubject` collapses `\s`, which is 25
 * characters including the non-breaking space and the en and em spaces, while
 * SQLite has no character class at all.
 *
 * A test scans the BMP and asserts this list is exactly what `\s` matches, so
 * "these agree" is proved rather than intended. Index-time stripping does not
 * help: a non-breaking space is legitimate text, so `stripInvisible` rightly
 * leaves it in the subject it stores.
 */
export const SUBJECT_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as const;

/**
 * The subject reduced to what a comparison should see: lowercased as far as
 * SQLite can, with every whitespace character removed.
 *
 * Generated rather than written out, because twenty-five nested `replace()`
 * calls are not something to keep correct by hand — and because generating it
 * from the same list the needle uses is what makes the two sides agree by
 * construction rather than by review.
 */
const SUBJECT_KEY = SUBJECT_WHITESPACE.reduce(
  (expression, code) => `replace(${expression}, char(${code}), '')`,
  "lower(m.subject)",
);
const SUBJECT_SCAN = `
  SELECT m.id, m.subject
  FROM messages m
  JOIN folders f ON f.id = m.folder_id
  WHERE ${GENERATION_GUARD}
    AND m.internal_date BETWEEN ?1 AND ?2
    AND ( ${SUBJECT_KEY} = ?3
       OR substr(${SUBJECT_KEY}, -(length(?3) + 1)) = ':' || ?3 )
  ORDER BY m.internal_date DESC, m.id DESC
  LIMIT ?4`;

/** The full rows, for the handful of ids that survived the exact check. */
const PREVIEWS_BY_ID = `
  SELECT ${PREVIEW_COLUMNS}
  FROM messages m
  JOIN folders f ON f.id = m.folder_id
  WHERE m.id IN (SELECT value FROM json_each(?1))
  ORDER BY m.internal_date DESC, m.id DESC`;

export async function getThread(db: D1Database, input: { id: number }): Promise<ThreadOutcome> {
  const seeded: MessageOutcome<ThreadPreview> = await loadSeed(db, input.id);
  if (!seeded.ok) return { ok: false, reason: seeded.reason };
  const seed = seeded.message;

  const closure = identityClosure(seed);
  let basis: ThreadBasis = "references";
  let rows = closure.length === 0 ? [] : await headerPass(db, closure);

  let prefilterCut = false;
  if (rows.every((row) => row.id === seed.id)) {
    const subject = normaliseSubject(seed.subject);
    if (subject.length < MIN_SUBJECT_CHARS) {
      rows = [];
    } else {
      const candidates = await subjectPass(db, seed, subject);
      rows = candidates.rows;
      prefilterCut = candidates.cut;
    }
    basis = "subject";
  }

  const messages = new Map<number, ThreadPreview>();
  // The seed goes in first so the message the caller actually named survives
  // the cap, even when it is older than every other member. The rows arrive
  // newest first, so filling to the cap from there keeps the recent end of a
  // conversation, which is the end worth keeping.
  messages.set(seed.id, seed);
  let truncated = prefilterCut;
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

/** The needle, reduced the same way `SUBJECT_KEY` reduces the column. */
const WHITESPACE = new RegExp(
  `[${SUBJECT_WHITESPACE.map((code) => `\\u{${code.toString(16)}}`).join("")}]`,
  "gu",
);

function subjectKey(subject: string): string {
  return subject.replace(WHITESPACE, "");
}

/**
 * Candidates, and whether the prefilter itself ran out of room.
 *
 * `cut` is not the same fact as the result cap being reached: it says older
 * rows were dropped before anything judged them, so the answer may be missing
 * members it would otherwise have kept. It is reported rather than hidden.
 */
async function subjectPass(
  db: D1Database,
  seed: ThreadPreview,
  subject: string,
): Promise<{ rows: PreviewRow[]; cut: boolean }> {
  // Identity and subject only. This is the read that has to be allowed to be
  // wide, so it carries nothing wide: no body preview, no address lists.
  const { results: scanned } = await db
    .prepare(SUBJECT_SCAN)
    .bind(
      seed.internalDate - SUBJECT_WINDOW_MS,
      seed.internalDate + SUBJECT_WINDOW_MS,
      subjectKey(subject),
      SUBJECT_CANDIDATES,
    )
    .all<{ id: number; subject: string }>();

  // The decision, and the only one. Everything above it was narrowing.
  const matched = scanned.filter((row) => normaliseSubject(row.subject) === subject);
  // Ordered newest first by the scan, so this keeps the recent end of a
  // conversation — the end worth keeping when there is more than fits.
  const wanted = matched.slice(0, MAX_THREAD_MESSAGES);

  // No empty-set guard: the seed's own row matches its own subject exactly, so
  // this list always holds at least it. An empty json_each would be harmless
  // anyway, but a branch nothing can reach is worse than the query it avoids.
  const { results } = await db
    .prepare(PREVIEWS_BY_ID)
    .bind(JSON.stringify(wanted.map((row) => row.id)))
    .all<PreviewRow>();

  return {
    rows: results,
    // Two different ways to have left something out, and both are the same
    // thing to a reader: the scan hit its guard, or more subjects matched than
    // a thread may carry.
    cut: scanned.length === SUBJECT_CANDIDATES || matched.length > wanted.length,
  };
}
