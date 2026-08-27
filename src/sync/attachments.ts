/**
 * Attachments: bytes to R2, metadata for D1, text where a Worker can read it (#9).
 *
 * Pulled at sync time rather than on demand, which is a security decision
 * rather than a caching one: fetching on demand would put a live IMAP
 * connection on the read path, one tool call away from attacker-written text.
 * The bytes could not live in D1 in any case — its per-value limit is 2 MB.
 *
 * Three properties of what follows are load-bearing:
 *
 *   - The R2 key is DERIVED from (folder, uidvalidity, uid, part). Nothing is
 *     generated, so re-syncing a message overwrites its objects rather than
 *     duplicating them, and no bookkeeping is needed to make that true.
 *   - The `put` happens BEFORE the D1 write, and the caller writes no message
 *     row if it fails. Gap detection (#6) counts `messages` rows, so a row that
 *     could land while its bytes did not would mark the uid bucket complete and
 *     the range would never be enqueued again.
 *   - A single attachment failing is never a message failing. A fifteen-year
 *     mailbox holds plenty of malformed MIME, and one of them must not be able
 *     to stop a range from ever being indexed.
 */

import type { MailboxAttachment, MailboxMessage } from "../imap";
import type { Logger } from "../log";
import { stripInvisible, TRUNCATION_MARKER, tidyLines } from "./normalise";

/**
 * Longest extracted document stored.
 *
 * The same ceiling message bodies get, and for the same reason: D1 caps a
 * single value at 2 MB, and a spreadsheet exported to CSV is exactly the kind
 * of attachment that reaches it.
 */
export const MAX_EXTRACTED_CHARS = 256 * 1024;

/**
 * What can be turned into text inside a Worker, by extension.
 *
 * Deliberately short. PDF is the obvious absence and the reason is that there
 * is no good Workers-native parser for one — it is stored and retrievable but
 * never indexed, which the README says out loud. `.docx` is a zip of XML and
 * therefore reachable, but reading it needs a zip reader this does not have
 * yet; it sits with PDF for now.
 */
const EXTRACTABLE_EXTENSIONS = new Set(["txt", "md", "csv"]);

/**
 * The same question asked of the MIME type, for the many attachments that
 * arrive with no useful filename — cf-imap names those "untitled".
 */
const EXTRACTABLE_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);

const EXTENSION = /\.([a-z0-9]+)$/i;

/** Longest filename echoed into a log line. */
const MAX_LOGGED_FILENAME = 80;

/** The row shape store.ts binds, one per part of a message. */
export type AttachmentRow = {
  /** Position in the message's attachment list, and half of the upsert key. */
  partIndex: number;
  filename: string | null;
  mimeType: string | null;
  /** Size of what was actually stored, not of what the headers claimed. */
  sizeBytes: number | null;
  /** The original Content-Transfer-Encoding, e.g. "base64". */
  encoding: string | null;
  contentId: string | null;
  /** 0 or 1 — SQLite has no boolean. */
  isInline: number;
  /** Null when the bytes could not be decoded, so the failure stays visible. */
  r2Key: string | null;
  extractedText: string | null;
};

/**
 * Where this part's bytes live.
 *
 * `uidvalidity` is in the key rather than only in the row because a folder that
 * changed it holds different messages under the same uids. Without it, a
 * re-synced folder would overwrite the previous generation's objects while its
 * rows were still addressable.
 */
export function attachmentKey(
  folderId: number,
  uidValidity: number,
  uid: number,
  partIndex: number,
): string {
  return `att/${folderId}/${uidValidity}/${uid}/${partIndex}`;
}

/**
 * Whether this attachment is one of the formats text is extracted from.
 *
 * The extension wins when there is one, and an unrecognised extension is a
 * "no" rather than a reason to consult the MIME type: mail labels attachments
 * `application/octet-stream` constantly, but it also labels a PDF `text/plain`
 * occasionally, and "notes.txt.pdf" is a PDF.
 */
export function isExtractable(filename: string, mimeType: string): boolean {
  const extension = EXTENSION.exec(filename)?.[1]?.toLowerCase();
  if (extension !== undefined) return EXTRACTABLE_EXTENSIONS.has(extension);
  return EXTRACTABLE_TYPES.has(mimeType.trim().toLowerCase());
}

/**
 * The text of an attachment, or null if it has none worth indexing.
 *
 * `MailboxAttachment` carries no charset — the MIME parameter is consumed by
 * the layer below — so the encoding is guessed rather than known. UTF-8 first
 * and strictly, because a strict decode that succeeds is almost certainly
 * right; windows-1252 second, because it never fails and a plain-text file
 * written on Windows in 1998 is the case that needs it.
 */
async function extractText(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<string | null> {
  if (!isExtractable(filename, mimeType)) return null;

  const text = stripInvisible(tidyLines(decodeText(bytes)));
  if (!text) return null;
  return text.length > MAX_EXTRACTED_CHARS
    ? text.slice(0, MAX_EXTRACTED_CHARS) + TRUNCATION_MARKER
    : text;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Stores every attachment of one message and returns the rows describing them.
 *
 * Writes nothing to D1: the caller puts these rows in the same batch as the
 * message row, so the two land together or not at all.
 *
 * An `R2Bucket` rather than `Env`, because the only capability this needs is
 * the ability to put an object — and a function that took the whole
 * environment could reach the mailbox password.
 */
export async function storeAttachments(
  bucket: R2Bucket,
  message: MailboxMessage,
  folderId: number,
  uidValidity: number,
  log: Logger,
): Promise<AttachmentRow[]> {
  const rows: AttachmentRow[] = [];

  for (const [partIndex, attachment] of message.attachments.entries()) {
    const row = describe(attachment, partIndex);
    rows.push(row);

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(attachment.contentBase64);
    } catch (error) {
      // Not fatal, and not silent either. The row survives with no key, so a
      // message that lost an attachment says so rather than looking like a
      // message that never had one.
      log.warn(
        `${where(message, partIndex)}: could not decode ${name(attachment)} — ` +
          `stored no bytes: ${(error as Error).message}`,
      );
      continue;
    }

    // Deliberately no httpMetadata. `mimeType` and `filename` are written by
    // whoever sent the message, and an R2 object that carries an
    // author-chosen content type is a loaded gun for whoever later serves
    // these bytes over HTTP. D1 holds both values already.
    await bucket.put(attachmentKey(folderId, uidValidity, message.uid, partIndex), bytes);
    row.r2Key = attachmentKey(folderId, uidValidity, message.uid, partIndex);
    row.sizeBytes = bytes.length;

    // Total, deliberately: every decode path here has a fallback that cannot
    // fail, so there is nothing to catch. An extractor that CAN fail — a zip
    // reader for .docx, a PDF parser — has to swallow its own failures and
    // answer null, because an unreadable attachment must never cost a message
    // its sync.
    row.extractedText = await extractText(bytes, attachment.filename, attachment.mimeType);
  }

  return rows;
}

function describe(attachment: MailboxAttachment, partIndex: number): AttachmentRow {
  return {
    partIndex,
    filename: attachment.filename || null,
    mimeType: attachment.mimeType || null,
    sizeBytes: Number.isFinite(attachment.size) ? attachment.size : null,
    encoding: attachment.encoding || null,
    contentId: attachment.contentId ?? null,
    isInline: attachment.isInline ? 1 : 0,
    r2Key: null,
    extractedText: null,
  };
}

/**
 * base64 to bytes.
 *
 * `atob` throws on anything that is not base64, which is the behaviour wanted:
 * a silently truncated attachment stored under a real key would be worse than
 * a row that admits it has no bytes.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Where a log line is talking about. */
function where(message: MailboxMessage, partIndex: number): string {
  return `uid ${message.uid} part ${partIndex}`;
}

/**
 * A filename, safe to put in a log line.
 *
 * Flattened and capped because it is attacker-controlled: a filename holding a
 * newline could otherwise write a log line of its own choosing into the
 * observability timeline someone reads to work out what went wrong.
 */
function name(attachment: MailboxAttachment): string {
  const flat = attachment.filename.replace(/\s+/gu, " ").trim() || "(unnamed)";
  return flat.length > MAX_LOGGED_FILENAME ? `${flat.slice(0, MAX_LOGGED_FILENAME)}…` : flat;
}
