/**
 * What the client does to a message between the wire and this project's
 * MailboxMessage.
 *
 * These are contract tests over a pinned version of a dependency, not tests of
 * our own arithmetic. That is the point: they are what turns a future
 * cf-imap upgrade, or a swap to another client entirely, into a red build
 * rather than a quiet change in what fifteen years of mail decodes to.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxMessage } from "../../../src/imap/types";
import { resetServers } from "../support/fake-sockets";
import * as fixtures from "../support/fixtures";
import { fakeMessage } from "../support/fixtures";
import { openMailbox } from "../support/harness";

beforeEach(() => {
  resetServers();
});

async function fetchOne(raw: Uint8Array): Promise<MailboxMessage> {
  const { mailbox } = await openMailbox({ messages: [fakeMessage(1, raw)] });
  await mailbox.selectFolder("Archive");
  const messages = await mailbox.fetchMessages({ uids: 1 });
  expect(messages).toHaveLength(1);
  return messages[0];
}

describe("headers", () => {
  it("decodes a base64 RFC 2047 encoded-word subject", async () => {
    const message = await fetchOne(fixtures.plainText);

    expect(message.subject).toBe("Hello, world!");
    expect(message.from).toEqual(["Ada Lovelace <ada@example.com>"]);
    expect(message.cc).toEqual(["carol@example.com", "dave@example.com"]);
    expect(message.messageId).toBe("<plain-1@example.com>");
    // Bodies arrive verbatim, trailing CRLF included. Multipart parts do get
    // their trailing CRLF stripped (see below), so the two shapes differ —
    // normalising that is the indexer's job (#5), not this layer's.
    expect(message.text).toBe("The body of a plain message.\r\n");
  });

  it("decodes adjacent Q encoded-words, dropping the whitespace between them", async () => {
    const message = await fetchOne(fixtures.qEncodedSubject);

    expect(message.subject).toBe("Järjestys ja järjestelmä");
  });

  it("carries the UID, flags, size and INTERNALDATE off the FETCH", async () => {
    const { mailbox } = await openMailbox({
      messages: [fakeMessage(77, fixtures.plainText, ["Seen"], "17-Jul-1996 02:44:25 -0700")],
    });
    await mailbox.selectFolder("Archive");

    const [message] = await mailbox.fetchMessages({ uids: 77 });

    expect(message.uid).toBe(77);
    expect(message.flags).toEqual(["Seen"]);
    expect(message.size).toBe(fixtures.plainText.length);
    expect(message.internalDate.toISOString()).toBe("1996-07-17T09:44:25.000Z");
  });
});

describe("transfer encodings", () => {
  it("decodes a quoted-printable body, soft line breaks included", async () => {
    const message = await fetchOne(fixtures.quotedPrintableLatin1);

    expect(message.subject).toBe("Café réservé");
    expect(message.text).toContain("Café au lait, réservé pour Renée.");
    expect(message.text).toContain("Soft line breaks stay invisible.");
  });

  it("decodes a base64 body", async () => {
    const message = await fetchOne(fixtures.base64Utf8);

    expect(message.text).toBe("Thé à la crème - base64 round trip.");
  });
});

describe("multipart", () => {
  it("splits multipart/alternative into text and html", async () => {
    const message = await fetchOne(fixtures.multipartAlternative);

    expect(message.text).toBe("The plain flavour.");
    expect(message.html).toBe("<p>The HTML flavour.</p>");
    expect(message.attachments).toEqual([]);
  });

  it("pulls the attachment out of multipart/mixed", async () => {
    const message = await fetchOne(fixtures.multipartMixed);

    expect(message.text).toBe("See attached.");
    expect(message.attachments).toHaveLength(1);

    const [attachment] = message.attachments;
    expect(attachment.filename).toBe("report.pdf");
    expect(attachment.mimeType).toBe("application/pdf");
    expect(attachment.encoding).toBe("base64");
    expect(attachment.isInline).toBe(false);
    expect(atob(attachment.contentBase64)).toBe("%PDF-1.4\n% not really a PDF");
    expect(attachment.size).toBe(27);
  });
});

describe("charsets", () => {
  it("decodes ISO-8859-1", async () => {
    const message = await fetchOne(fixtures.quotedPrintableLatin1);

    expect(message.text).toContain("réservé");
  });

  it("decodes windows-1252, including the 0x80-0x9F range", async () => {
    const message = await fetchOne(fixtures.windows1252);

    expect(message.subject).toBe("Smart “quotes”");
    expect(message.text).toBe("He said “hello” — and left.\r\n");
  });

  it(
    "KNOWN LIMITATION: every iso-8859-* charset is decoded as ISO-8859-1, so " +
      "ISO-8859-15's euro sign comes back as a currency sign",
    async () => {
      // cf-imap's decodeBytes matches the `iso-8859-` prefix and runs a
      // latin-1 byte loop before ever reaching its TextDecoder fallback, so
      // 0xA4 decodes as U+00A4 rather than U+20AC. workerd's TextDecoder
      // supports the whole WHATWG encoding set, so the shortcut is what loses
      // the character, not the runtime. Pinned here rather than hidden; see
      // the limitations section in README.md.
      const message = await fetchOne(fixtures.iso885915);

      expect(message.text).toBe("Total: 42¤\r\n");
      expect(message.text).not.toContain("€");
    },
  );

  it(
    "KNOWN LIMITATION: a raw 8-bit body loses its non-ASCII bytes, because " +
      "the FETCH literal is UTF-8 decoded before the part's charset is known",
    async () => {
      // The FETCH literal is decoded as UTF-8 before anything knows the part's
      // charset, so a lone 0xE9 becomes U+FFFD; the latin-1 pass then decodes
      // that replacement character's own UTF-8 bytes, and "é" arrives as
      // "ï¿½". Only bodies sent with no transfer encoding
      // (Content-Transfer-Encoding: 8bit) are affected — quoted-printable and
      // base64 are 7-bit on the wire and survive, which covers nearly all
      // modern mail. Old archives are where this shows up.
      const message = await fetchOne(fixtures.raw8Bit);

      expect(message.text).toContain("Cafï¿½ au lait.");
      expect(message.text).not.toContain("Café");
    },
  );
});

describe("malformed input", () => {
  it("handles a message with headers and no body", async () => {
    const message = await fetchOne(fixtures.headersOnly);

    expect(message.subject).toBe("Nothing follows");
    expect(message.text ?? "").toBe("");
    expect(message.attachments).toEqual([]);
  });

  it("handles a multipart whose closing boundary never arrives", async () => {
    const message = await fetchOne(fixtures.truncatedMultipart);

    expect(message.subject).toBe("Cut short");
    expect(message.text).toBe("The first part is all there is.");
  });

  it("does not throw on a base64 part that is not base64", async () => {
    const message = await fetchOne(fixtures.invalidBase64);

    expect(message.subject).toBe("Broken encoding");
    expect(typeof message.text).toBe("string");
  });
});
