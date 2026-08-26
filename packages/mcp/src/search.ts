/**
 * The read side of the index: one FTS5 query, and the query a session starts
 * from.
 *
 * Search runs against our own index rather than IMAP SEARCH, which on iCloud
 * returns nothing at all for string criteria (#6). That is not a fallback — it
 * is the reason the index exists.
 *
 * Nothing here returns `body_text`. A broad query that dumped a hundred message
 * bodies into a model's context is the injection surface this whole design is
 * arranged around, so the column is searched and snippetted and never selected.
 * Reading one is `get_message`'s job (src/message.ts), one message at a time,
 * by an id this tool handed out.
 */

import { toMatchExpression } from "./fts";

/** How many hits a caller gets when they do not say. */
export const DEFAULT_LIMIT = 20;

/**
 * The ceiling, whatever a caller asks for.
 *
 * Bounded result sets are a security property here, not a performance one:
 * every subject and snippet is attacker-controlled text, so the number of them
 * one call can put in front of a model has to have a lid a caller cannot lift.
 */
export const MAX_LIMIT = 50;

/**
 * The subject is weighted ten to one against the body, as the schema's own
 * comment recommends. `bm25()` scores are negative and smaller is better, so
 * plain ascending order is the ranked order — the sort that looks backwards is
 * the correct one.
 */
const RANK = "bm25(messages_fts, 10.0, 1.0)";

/**
 * The body column's index in `messages_fts` — (0) subject, (1) body_text.
 * `snippet()` takes the column, so this constant and the migration have to
 * agree.
 */
const BODY_COLUMN = 1;

/** Tokens of context either side of the match. FTS5 caps this at 64. */
const SNIPPET_TOKENS = 12;

export type SearchInput = {
  query: string;
  folder?: string;
  from?: string;
  since?: string;
  until?: string;
  limit?: number;
};

export type SearchHit = {
  id: number;
  folder: string;
  uid: number;
  uidValidity: number;
  subject: string;
  fromAddress: string | null;
  /** Epoch milliseconds, as everything in this schema is. */
  internalDate: number;
  hasAttachments: boolean;
  snippet: string;
};

export type SearchOutcome =
  | { ok: true; hits: SearchHit[]; more: boolean }
  | { ok: false; reason: string };

/**
 * The row as D1 hands it back. Two columns need narrowing on the way out:
 * `has_attachments` is an INTEGER, and `snippet()` answers NULL for a message
 * that was indexed with no body at all — a real case, not a defensive one.
 */
type Row = Omit<SearchHit, "hasAttachments" | "snippet"> & {
  hasAttachments: number;
  snippet: string | null;
};

/**
 * An ISO date or datetime as epoch milliseconds.
 *
 * A bare `YYYY-MM-DD` used as an upper bound means the end of that day, not its
 * first instant. Parsing it the obvious way would make `until: "2026-03-04"`
 * silently exclude everything that arrived on the 4th, which is the opposite of
 * what anyone typing that means.
 */
function parseBound(value: string, edge: "start" | "end"): number | null {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  return edge === "end" && bareDate ? at + 24 * 60 * 60 * 1000 - 1 : at;
}

export async function searchMessages(db: D1Database, input: SearchInput): Promise<SearchOutcome> {
  const match = toMatchExpression(input.query);
  if (match === null) {
    return { ok: false, reason: "The query held no searchable terms. Try one or more keywords." };
  }

  // Built as a list rather than as `? IS NULL OR ...` so an absent filter costs
  // nothing and a present one can still use its index.
  const where: string[] = [
    "messages_fts MATCH ?",
    // Messages carry their own uidvalidity, so a folder that changed it leaves
    // the previous generation sitting alongside the current one rather than
    // colliding with it. Those rows are not deleted, and without this every
    // message in a re-synced folder would come back twice — half of them under
    // uids that no longer address anything on the server.
    "(f.uidvalidity IS NULL OR m.uidvalidity = f.uidvalidity)",
  ];
  const binds: unknown[] = [match];

  if (input.folder !== undefined) {
    where.push("f.name = ?");
    binds.push(input.folder);
  }
  if (input.from !== undefined) {
    // `from_address` is stored lowercased by the sync worker, so lowercasing the
    // needle is the whole of the case handling. Substring rather than equality
    // gives up the messages_from_address index; at one mailbox's scale that
    // buys a filter a caller can use without knowing the full address first.
    where.push("m.from_address LIKE '%' || ? || '%'");
    binds.push(input.from.toLowerCase());
  }
  for (const [value, edge, comparison] of [
    [input.since, "start", ">="],
    [input.until, "end", "<="],
  ] as const) {
    if (value === undefined) continue;
    const at = parseBound(value, edge);
    if (at === null) {
      return { ok: false, reason: `Could not read ${JSON.stringify(value)} as a date.` };
    }
    where.push(`m.internal_date ${comparison} ?`);
    binds.push(at);
  }

  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  // One row past the limit, which is how "there is more" gets answered without a
  // second count(*) over the whole match set.
  binds.push(limit + 1);

  const { results } = await db
    .prepare(
      `SELECT m.id, f.name AS folder, m.uid, m.uidvalidity AS uidValidity, m.subject,
              m.from_address AS fromAddress, m.internal_date AS internalDate,
              m.has_attachments AS hasAttachments,
              snippet(messages_fts, ${BODY_COLUMN}, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN folders f ON f.id = m.folder_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${RANK}
       LIMIT ?`,
    )
    .bind(...binds)
    .all<Row>();

  return {
    ok: true,
    hits: results.slice(0, limit).map((row) => ({
      ...row,
      hasAttachments: row.hasAttachments === 1,
      snippet: row.snippet ?? "",
    })),
    more: results.length > limit,
  };
}
