/**
 * A caller's search string, turned into an FTS5 MATCH expression.
 *
 * MATCH takes a query language, not a string of words, and handing it a raw
 * user string is wrong twice over. It breaks: an unbalanced quote, a bare `*`,
 * a stray `(` or a leading `-` are all `fts5: syntax error`, which would turn
 * an ordinary search into a 500. And it leaks reach: operators, column filters
 * and NEAR are syntax a caller was never offered.
 *
 * So the string is parsed here rather than passed through. Every term comes out
 * as an FTS5 string literal, which is the one form where the content cannot be
 * syntax, and terms are joined by whitespace — FTS5's implicit AND. What a
 * caller can express is exactly what the tool's description promises: keywords,
 * quoted phrases, and a trailing star.
 */

/**
 * How many terms one query may carry.
 *
 * A bound rather than a judgement about search quality: the expression goes
 * into a prepared statement, and nothing should be able to make that statement
 * arbitrarily long by pasting a message into the query field.
 */
export const MAX_QUERY_TERMS = 16;

/** Longest single term. Anything past this is a paste, not a search. */
const MAX_TERM_CHARS = 128;

/**
 * Whether a term holds anything `unicode61` would index.
 *
 * A quoted string of pure punctuation tokenizes to nothing, and an empty phrase
 * is itself a syntax error — so `"-()"` would fail in exactly the way quoting
 * was supposed to prevent. Letters and numbers are what survive the tokenizer,
 * so a term without one is dropped rather than emitted.
 */
const HAS_TOKEN = /[\p{L}\p{N}]/u;

type Term = { text: string; prefix: boolean };

/**
 * Splits on whitespace, except inside double quotes, which hold a phrase
 * together. An unterminated quote runs to the end of the string rather than
 * being an error: the caller was typing, not writing syntax.
 *
 * A quote only opens a phrase at the start of a term. Mid-term it is an
 * ordinary character, so `O"Brien` stays one term and reaches `quote()` with a
 * quote still in it — which is the case the doubling exists for.
 */
function splitTerms(query: string): Term[] {
  const terms: Term[] = [];
  let index = 0;

  while (index < query.length) {
    const char = query[index];
    if (char === undefined || /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const end = query.indexOf('"', index + 1);
      const text = query.slice(index + 1, end === -1 ? query.length : end);
      terms.push({ text, prefix: false });
      index = end === -1 ? query.length : end + 1;
      continue;
    }

    let end = index;
    while (end < query.length && !/\s/.test(query[end] as string)) end += 1;
    const raw = query.slice(index, end);
    // Trailing stars collapse to one prefix flag. The schema's own comment
    // names `会議*` as the workaround for CJK indexing as a single token, so
    // this is the one piece of query syntax that survives on purpose.
    const text = raw.replace(/\*+$/, "");
    terms.push({ text, prefix: text.length !== raw.length });
    index = end;
  }

  return terms;
}

/** Escapes for an FTS5 string literal: a double quote is doubled, nothing else is special. */
function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The MATCH expression for this query, or null when nothing usable is left.
 *
 * Null is a real answer, not a failure: `search_messages` turns it into a tool
 * error asking for search terms, which is more use than a query that matches
 * everything or a syntax error that matches nothing.
 */
export function toMatchExpression(query: string): string | null {
  const terms = splitTerms(query)
    .map((term) => ({ ...term, text: term.text.slice(0, MAX_TERM_CHARS) }))
    .filter((term) => HAS_TOKEN.test(term.text))
    .slice(0, MAX_QUERY_TERMS);

  if (terms.length === 0) return null;
  return terms
    .map((term) => `${quote(term.text.toLowerCase())}${term.prefix ? "*" : ""}`)
    .join(" ");
}
