/**
 * Message fixtures: the MIME shapes a fifteen-year mailbox actually contains.
 *
 * Bodies are written with plain newlines and converted to CRLF, because that
 * is what a server sends and what the parser has to cope with.
 */

import { bytes, type FakeMessage, message } from "./server";

const INTERNAL_DATE = "20-Aug-2026 09:00:00 +0000";

export function fakeMessage(
  uid: number,
  raw: Uint8Array,
  flags: string[] = [],
  internalDate = INTERNAL_DATE,
): FakeMessage {
  return { uid, flags, internalDate, raw };
}

/** A plain text message with a base64 RFC 2047 encoded-word subject. */
export const plainText = message(`From: Ada Lovelace <ada@example.com>
To: bob@example.com
Cc: carol@example.com, dave@example.com
Subject: =?utf-8?B?SGVsbG8sIHdvcmxkIQ==?=
Message-ID: <plain-1@example.com>
Date: Thu, 20 Aug 2026 09:00:00 +0000
Content-Type: text/plain; charset=utf-8

The body of a plain message.
`);

/** Q-encoded subject, split across two adjacent encoded words. */
export const qEncodedSubject = message(`From: ada@example.com
Subject: =?utf-8?Q?J=C3=A4rjestys?= =?utf-8?Q?_ja_j=C3=A4rjestelm=C3=A4?=
Message-ID: <q-1@example.com>
Content-Type: text/plain; charset=utf-8

Body.
`);

/** quoted-printable body in ISO-8859-1, the classic western-European shape. */
export const quotedPrintableLatin1 = message(`From: ada@example.com
Subject: =?iso-8859-1?Q?Caf=E9_r=E9serv=E9?=
Message-ID: <qp-1@example.com>
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Caf=E9 au lait, r=E9serv=E9 pour Ren=E9e.
Soft line breaks stay =
invisible.
`);

/** base64 body, UTF-8. */
export const base64Utf8 = message(`From: ada@example.com
Subject: Base64 body
Message-ID: <b64-1@example.com>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

VGjDqSDDoCBsYSBjcsOobWUgLSBiYXNlNjQgcm91bmQgdHJpcC4=
`);

/** multipart/alternative: the same message as text and HTML. */
export const multipartAlternative = message(`From: ada@example.com
Subject: Both flavours
Message-ID: <alt-1@example.com>
Content-Type: multipart/alternative; boundary="alt-boundary"

--alt-boundary
Content-Type: text/plain; charset=utf-8

The plain flavour.
--alt-boundary
Content-Type: text/html; charset=utf-8

<p>The HTML flavour.</p>
--alt-boundary--
`);

/** multipart/mixed: a body plus a base64 attachment. */
export const multipartMixed = message(`From: ada@example.com
Subject: With an attachment
Message-ID: <mixed-1@example.com>
Content-Type: multipart/mixed; boundary="mixed-boundary"

--mixed-boundary
Content-Type: text/plain; charset=utf-8

See attached.
--mixed-boundary
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJSBub3QgcmVhbGx5IGEgUERG
--mixed-boundary--
`);

/** windows-1252: smart quotes and an em dash in the 0x80-0x9F range. */
export const windows1252 = message(`From: ada@example.com
Subject: =?windows-1252?Q?Smart_=93quotes=94?=
Message-ID: <cp1252-1@example.com>
Content-Type: text/plain; charset=windows-1252
Content-Transfer-Encoding: quoted-printable

He said =93hello=94 =97 and left.
`);

/**
 * ISO-8859-15, which differs from ISO-8859-1 at exactly the byte that matters
 * to anyone in the eurozone: 0xA4 is the euro sign, not a currency sign.
 */
export const iso885915 = message(`From: ada@example.com
Subject: Euro
Message-ID: <8859-15@example.com>
Content-Type: text/plain; charset=iso-8859-15
Content-Transfer-Encoding: quoted-printable

Total: 42=A4
`);

/** A raw 8-bit body: no transfer encoding, ISO-8859-1 bytes on the wire. */
export const raw8Bit = bytes(
  message(`From: ada@example.com
Subject: Raw eight bit
Message-ID: <8bit-1@example.com>
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: 8bit

Caf`),
  new Uint8Array([0xe9]),
  message(` au lait.
`),
);

/** Headers with no body at all — no blank line, no content. */
export const headersOnly = message(`From: ada@example.com
Subject: Nothing follows
Message-ID: <empty-1@example.com>`);

/** A multipart whose closing boundary never arrives. */
export const truncatedMultipart = message(`From: ada@example.com
Subject: Cut short
Message-ID: <trunc-1@example.com>
Content-Type: multipart/mixed; boundary="cut"

--cut
Content-Type: text/plain; charset=utf-8

The first part is all there is.`);

/** A base64 part whose payload is not valid base64. */
export const invalidBase64 = message(`From: ada@example.com
Subject: Broken encoding
Message-ID: <badb64-1@example.com>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

!!!! not base64 at all !!!!
`);
