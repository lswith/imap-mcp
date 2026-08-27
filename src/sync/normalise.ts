/**
 * Turning a fetched message into the row the schema wants.
 *
 * Two jobs, and the second one is a security control rather than tidying.
 *
 * HTML is reduced to plain text at index time, because there is no body_html
 * column: storing both copies would double the largest thing in the database
 * for a second rendering nothing reads.
 *
 * And message bodies are attacker-controlled text. Everything that survives
 * here is eventually read by a model, so the characters that exist to hide
 * text from a human reader — zero-width spaces, bidi overrides, the Unicode
 * tag block — are removed at index time rather than at read time. Doing it
 * here means every reader gets it, including one nobody has written yet, and
 * it is what the FTS index ends up built over.
 *
 * Every invisible character in this file is written as an escape. A file about
 * hidden characters is the last place to put one where it cannot be seen.
 */

import type { MailboxMessage } from "../imap";

/**
 * D1 caps a single value at 2 MB. A body is the only field that can approach
 * that, and a thread quoted forty times deep carries no information in its
 * tail, so it is truncated well below the limit rather than risking a whole
 * message failing to store.
 */
export const MAX_BODY_CHARS = 256 * 1024;

/** Shared with attachments.ts, so a truncated body and a truncated
 *  attachment read the same way. */
export const TRUNCATION_MARKER = "\n[truncated by imap-mcp]";

/** The row shape store.ts binds. Field order matches the INSERT. */
export type MessageRow = {
  folderId: number;
  uidValidity: number;
  uid: number;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  /** JSON array. */
  referenceIds: string;
  subject: string;
  fromAddress: string | null;
  /** JSON arrays, as the server gave them. */
  fromAddresses: string;
  toAddresses: string;
  ccAddresses: string;
  internalDate: number;
  sentDate: number | null;
  sizeBytes: number | null;
  /** JSON array. */
  flags: string;
  bodyText: string | null;
  /** 0 or 1 — SQLite has no boolean. */
  hasAttachments: number;
  /**
   * The message was too large to fetch, so this row was written from its
   * headers alone: no body, no attachments, and no In-Reply-To or References
   * either — a header-only FETCH does not ask for them. 0 or 1.
   */
  oversize: number;
};

// ---------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------

/**
 * Characters that carry no visible text.
 *
 * Every one of these can sit inside a sentence a human reads as ordinary and a
 * model reads as something else: zero-width spaces splitting a word past a
 * filter, bidi overrides reversing a rendered line, the Unicode tag block
 * (U+E0000–U+E007F) spelling out whole instructions that render as nothing at
 * all.
 *
 * C0 controls except tab, newline and carriage return; DEL and the C1 block;
 * soft hyphen; the Arabic letter mark; the Mongolian vowel separator;
 * zero-width spaces and joiners; the bidi marks, embeddings, overrides and
 * isolates; word joiner and the invisible operators; the BOM.
 *
 * Emoji variation selectors (U+FE00–U+FE0F) are deliberately NOT here. They
 * cannot hide text — they choose a glyph — and stripping them mangles emoji.
 */
// Removing control characters from attacker-controlled text is the entire
// purpose of this pattern, so it has to be allowed to name them.
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: see above
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** U+2028 and U+2029 are line breaks rather than hidden characters. */
const UNICODE_BREAKS = /[\u2028\u2029]/g;

/**
 * Removes hidden characters and normalises the encoding.
 *
 * NFC last, so "café" written as e + U+0301 and as U+00E9 store identically
 * and match the same FTS query.
 */
export function stripInvisible(text: string): string {
  return text.replace(UNICODE_BREAKS, "\n").replace(INVISIBLE, "").normalize("NFC");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Dropped with their content: none of it is body text a reader wants. */
const DISCARDED = ["script", "style", "head", "noscript", "template", "iframe", "object"];

/** Rendered as a line break. */
const BLOCK = [
  "address",
  "article",
  "blockquote",
  "br",
  "dd",
  "div",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
];

/** Rendered as a tab: a layout table's cells should not run together. */
const CELL = ["td", "th"];

/**
 * Where a line break and a cell break go, marked in the first pass and turned
 * into real characters after the second.
 *
 * Markers rather than "\n" and "\t" directly, because HTML source whitespace
 * is not content — the indentation of a generated mail template would
 * otherwise be indistinguishable from the line structure of the message. So
 * all real whitespace collapses to single spaces the way a renderer would, and
 * only these survive it. They are C0 controls, so a message that contained one
 * of its own gets a stray line break in its indexed text and nothing worse.
 */
const BREAK = "\u0001";
const CELL_BREAK = "\u0002";

/** Inline CSS that hides an element without a `hidden` attribute. */
const HIDING_CSS = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0/i;

/**
 * Reduces an HTML body to plain text.
 *
 * Two passes, because HTMLRewriter's `remove()` suppresses an element from the
 * OUTPUT but still runs handlers over its content — a text handler collecting
 * as it went would happily collect the inside of a `<script>` that had been
 * removed. So the first pass rewrites (dropping subtrees, marking line breaks)
 * and the second reads the text of what survived. Pinned by a test.
 *
 * A real parser rather than tag-stripping regexes, because the input is
 * hostile by assumption: `<div title="<script>">` and an unclosed tag are
 * exactly what a regex loses to.
 */
export async function htmlToText(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();

  for (const tag of DISCARDED) {
    rewriter = rewriter.on(tag, { element: (element) => void element.remove() });
  }

  rewriter = rewriter.on("[hidden]", { element: (element) => void element.remove() });
  rewriter = rewriter.on('[aria-hidden="true"]', { element: (element) => void element.remove() });
  // Matched in the handler rather than with an attribute selector, because
  // `[style*="display:none"]` is a literal substring match: it catches
  // `display:none` and misses `display: none`.
  rewriter = rewriter.on("[style]", {
    element: (element) => {
      if (HIDING_CSS.test(element.getAttribute("style") ?? "")) element.remove();
    },
  });

  for (const tag of BLOCK) {
    // Both sides: without the closing one, text that follows a table or a list
    // runs straight into its last cell.
    rewriter = rewriter.on(tag, {
      element: (element) => {
        element.before(BREAK, { html: false });
        element.after(BREAK, { html: false });
      },
    });
  }
  for (const tag of CELL) {
    rewriter = rewriter.on(tag, {
      element: (element) => void element.before(CELL_BREAK, { html: false }),
    });
  }

  const cleaned = await rewriter.transform(new Response(html)).text();

  const parts: string[] = [];
  await new HTMLRewriter()
    // onDocument rather than on("*"): text outside any element still counts,
    // and comments are never delivered to a text handler, so they drop out for
    // free.
    .onDocument({
      text: (chunk) => {
        parts.push(chunk.text);
      },
    })
    .transform(new Response(cleaned))
    .text();

  return collapseHtmlWhitespace(decodeEntities(parts.join("")));
}

/**
 * The named character references worth carrying. Numeric ones are all handled.
 *
 * HTMLRewriter hands text chunks over exactly as they appear in the source —
 * `&amp;` arrives as five characters — so this runs before stripInvisible
 * rather than after it. That ordering is the point rather than an accident:
 * `&#8203;` is a zero-width space written in a form a hidden-character filter
 * would otherwise walk straight past.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  dagger: "†",
  deg: "°",
  divide: "÷",
  emsp: "\u2003",
  ensp: "\u2002",
  euro: "€",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  micro: "µ",
  middot: "·",
  nbsp: "\u00A0",
  ndash: "–",
  para: "¶",
  permil: "‰",
  plusmn: "±",
  pound: "£",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  sect: "§",
  thinsp: "\u2009",
  times: "×",
  trade: "™",
  yen: "¥",
  // The invisible ones resolve to their real character deliberately, so
  // stripInvisible removes them a moment later rather than leaving "&zwj;"
  // sitting in the indexed text.
  lrm: "\u200E",
  rlm: "\u200F",
  shy: "\u00AD",
  zwj: "\u200D",
  zwnj: "\u200C",
};

const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match, body: string) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? match;

    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    // A lone surrogate or an out-of-range value would throw. An undecodable
    // reference is left as written rather than losing the text around it.
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
    if (code >= 0xd800 && code <= 0xdfff) return match;
    return String.fromCodePoint(code);
  });
}

/**
 * Source whitespace out, marked breaks in.
 *
 * A run of markers becomes one line break rather than one each: nested divs
 * and a list inside a table are how mail is built, and double-spacing the
 * result adds nothing a reader or an FTS index can use.
 */
function collapseHtmlWhitespace(text: string): string {
  return tidyLines(
    text
      .replace(/\s+/g, " ")
      // biome-ignore-start lint/suspicious/noControlCharactersInRegex: these are
      // the BREAK and CELL_BREAK markers this function inserted a moment ago,
      // and matching them back out is the point.
      .replace(/[ \u0001]*\u0001[ \u0001]*/g, "\n")
      .replace(/[ \u0002]*\u0002[ \u0002]*/g, "\t"),
    // biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above
  );
}

/** The final pass on any body: no trailing spaces, no runs of blank lines. */
export function tidyLines(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Message → row
// ---------------------------------------------------------------------------

/**
 * The body to index: the text/plain part when there is one, the HTML reduced
 * to text otherwise.
 *
 * Plain text keeps its own whitespace — the indentation of a quoted diff or a
 * signature is content — so only the HTML path collapses runs of spaces.
 */
export async function normaliseBody(message: MailboxMessage): Promise<string | null> {
  const plain = message.text?.trim() ? tidyLines(message.text) : "";
  const text = plain || (message.html ? await htmlToText(message.html) : "");
  if (!text) return null;

  const stripped = stripInvisible(text);
  if (!stripped) return null;
  return stripped.length > MAX_BODY_CHARS
    ? stripped.slice(0, MAX_BODY_CHARS) + TRUNCATION_MARKER
    : stripped;
}

/**
 * The address out of `Display Name <ada@example.com>`, lowercased.
 *
 * Lowercased because from_address is what search_messages (#7) filters a
 * sender on, and a correspondent who writes Ada@Example.com in one message and
 * ada@example.com in the next is one correspondent.
 */
export function extractAddress(value: string): string | null {
  const angled = value.match(/<([^<>]+)>/);
  const address = (angled ? angled[1] : value).trim().replace(/^["']+|["']+$/g, "");
  return address ? address.toLowerCase() : null;
}

/** The Date header as epoch ms, or null. It is frequently absent or nonsense. */
export function parseSentDate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param options.oversize The message exceeded the fetch budget, so only its
 * headers were read. The body and attachment columns are then left empty rather
 * than filled from a message that was never fetched — or, worse, from one whose
 * MIME was truncated mid-part.
 */
export async function toMessageRow(
  message: MailboxMessage,
  folderId: number,
  uidValidity: number,
  options: { oversize?: boolean } = {},
): Promise<MessageRow> {
  const oversize = options.oversize === true;
  const references = (message.headers.references ?? "")
    .split(/\s+/)
    .filter((id) => id.startsWith("<"));

  return {
    folderId,
    uidValidity,
    uid: message.uid,
    rfcMessageId: message.messageId || null,
    inReplyTo: message.headers["in-reply-to"]?.trim() || null,
    referenceIds: JSON.stringify(references),
    // Subjects get the same treatment as bodies: a zero-width space hides just
    // as well in a subject line, and that column is indexed too.
    subject: stripInvisible(message.subject ?? ""),
    fromAddress: message.from.length > 0 ? extractAddress(message.from[0]) : null,
    fromAddresses: JSON.stringify(message.from),
    toAddresses: JSON.stringify(message.to),
    ccAddresses: JSON.stringify(message.cc),
    internalDate: internalDateOf(message),
    sentDate: parseSentDate(message.headers.date),
    sizeBytes: Number.isFinite(message.size) ? message.size : null,
    flags: JSON.stringify(message.flags),
    bodyText: oversize ? null : await normaliseBody(message),
    hasAttachments: !oversize && message.attachments.length > 0 ? 1 : 0,
    oversize: oversize ? 1 : 0,
  };
}

/**
 * internal_date is NOT NULL and is the column every date filter should prefer,
 * so an unusable INTERNALDATE falls back to the Date header and then to the
 * epoch. Visibly wrong beats silently plausible.
 */
function internalDateOf(message: MailboxMessage): number {
  const internal = message.internalDate?.getTime();
  if (typeof internal === "number" && Number.isFinite(internal)) return internal;
  return parseSentDate(message.headers.date) ?? 0;
}
