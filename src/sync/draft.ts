/**
 * Assembling a draft into RFC 5322 bytes.
 *
 * The whole of this module's security value is in one function: a header value
 * containing a line break is a way to write arbitrary headers — a Bcc, a
 * different From, or a blank line followed by a body of the author's choosing.
 * Every string that reaches a header goes through `header()`, and nothing here
 * builds a header line any other way.
 *
 * Bodies are base64 rather than quoted-printable. Not for size: base64 has no
 * line-length rule to get wrong, no soft-break syntax, and no characters that
 * mean something in a header, so a body cannot influence the part of the
 * message that decides where it goes.
 */

import type { DraftRequest } from "../writes";

export type DraftOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly reason: string };

/** Anything that would end a header line, plus the NUL an IMAP literal cannot carry. */
const FORBIDDEN = /[\r\n\0]/u;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** RFC 5322 §3.3, always UTC. `toUTCString()` ends in "GMT", which is obsolete syntax. */
function rfc5322Date(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${DAYS[now.getUTCDay()]}, ${pad(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:` +
    `${pad(now.getUTCSeconds())} +0000`
  );
}

function base64(bytes: Uint8Array): string {
  // Chunked rather than spread: a body of any size would otherwise blow the
  // argument limit on String.fromCharCode.
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7e\t]*$/u.test(text);
}

/**
 * A header value, RFC 2047 encoded when it is not plain ASCII.
 *
 * Encoded whole rather than word by word. Longer than it needs to be for a
 * subject with one accent in it, and correct for every subject — the per-word
 * form has rules about which characters may sit between encoded words that are
 * easy to get subtly wrong.
 */
function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}

export function buildDraft(
  request: DraftRequest,
  from: string | undefined,
  now: Date = new Date(),
): DraftOutcome {
  const to = (request.to ?? []).map((address) => address.trim()).filter(Boolean);
  if (to.length === 0) return { ok: false, reason: "A draft needs at least one recipient." };

  const cc = (request.cc ?? []).map((address) => address.trim()).filter(Boolean);
  const references = (request.references ?? []).map((id) => id.trim()).filter(Boolean);
  const subject = request.subject ?? "";

  // Checked before anything is assembled, and checked on every value rather
  // than on the ones that look risky. A line break here is header injection.
  for (const value of [...to, ...cc, ...references, subject, request.inReplyTo ?? "", from ?? ""]) {
    if (FORBIDDEN.test(value)) {
      return {
        ok: false,
        reason:
          "A line break or null byte in a header would forge headers, so this draft was refused.",
      };
    }
  }

  const headers: string[] = [`Date: ${rfc5322Date(now)}`];
  if (from) headers.push(`From: ${encodeHeaderValue(from)}`);
  headers.push(`To: ${to.map(encodeHeaderValue).join(", ")}`);
  if (cc.length > 0) headers.push(`Cc: ${cc.map(encodeHeaderValue).join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);

  const domain = from?.split("@").at(1);
  if (domain) headers.push(`Message-ID: <${crypto.randomUUID()}@${domain}>`);
  if (request.inReplyTo) headers.push(`In-Reply-To: ${request.inReplyTo}`);
  if (references.length > 0) headers.push(`References: ${references.join(" ")}`);

  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const encoded = base64(new TextEncoder().encode(request.body ?? ""));
  const wrapped = encoded.match(/.{1,76}/gu) ?? [];

  return { ok: true, message: `${[...headers, "", ...wrapped].join("\r\n")}\r\n` };
}
