import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  extractAddress,
  htmlToText,
  MAX_BODY_CHARS,
  normaliseBody,
  parseSentDate,
  stripInvisible,
  toMessageRow,
} from "../src/normalise";
import { fakeAttachment, fakeMessage } from "./support/fake-mailbox";

describe("htmlToText", () => {
  it("keeps the text and drops the markup", async () => {
    const text = await htmlToText("<p>Hello, <b>world</b>.</p><p>Second paragraph.</p>");

    expect(text).toBe("Hello, world.\nSecond paragraph.");
  });

  it("drops script and style content", async () => {
    // Not a formatting nicety. HTMLRewriter's remove() suppresses an element
    // from its OUTPUT but still runs handlers over the content inside it, so a
    // one-pass text collector would index this. The two-pass rewrite is what
    // this pins.
    const text = await htmlToText(
      "<style>.a{color:red}</style><p>visible</p><script>alert('do this instead')</script>",
    );

    expect(text).toBe("visible");
    expect(text).not.toContain("do this instead");
    expect(text).not.toContain("color");
  });

  it("drops elements hidden from a human reader", async () => {
    // The email preheader trick, and the shape an injected instruction takes:
    // present in the source, invisible in a mail client, indexed unless this
    // removes it.
    const text = await htmlToText(
      `<p hidden>hidden attribute</p>
       <div style="display:none">no space</div>
       <div style="display: none">with a space</div>
       <span style="font-size:0">tiny</span>
       <span aria-hidden="true">aria</span>
       <p>visible</p>`,
    );

    expect(text).toBe("visible");
  });

  it("survives markup that would defeat a regex", async () => {
    const text = await htmlToText('<div title="<script>">kept</div><p>also kept');

    expect(text).toBe("kept\nalso kept");
  });

  it("gives table cells and line breaks their own separators", async () => {
    const text = await htmlToText("<table><tr><td>a</td><td>b</td></tr></table>x<br>y");

    expect(text).toBe("a\tb\nx\ny");
  });

  it("collapses source indentation but keeps line structure", async () => {
    const text = await htmlToText("<div>\n    one     two\n</div>\n<div>three</div>");

    expect(text).toBe("one two\nthree");
  });

  it("ignores comments", async () => {
    expect(await htmlToText("<p>a<!-- instructions in a comment -->b</p>")).toBe("ab");
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric references", async () => {
    // HTMLRewriter hands text chunks over exactly as written, so without this
    // pass every "&amp;" in fifteen years of mail is indexed as five
    // characters. Pinned through htmlToText, which is where it matters.
    expect(await htmlToText("<p>Tom &amp; Jerry &lt;3 &#8212; &#x2026; caf&eacute;</p>")).toBe(
      // &eacute; is not in the table, so it is left exactly as written rather
      // than being guessed at.
      "Tom & Jerry <3 — … caf&eacute;",
    );
  });

  it("leaves an undecodable reference alone", () => {
    expect(decodeEntities("&#xD800; &#0; &notareference; 100&amp;")).toBe(
      "&#xD800; &#0; &notareference; 100&",
    );
  });

  it("decodes an entity-encoded zero-width space before it can hide anything", async () => {
    // The reason decoding runs before stripInvisible rather than after it:
    // written this way, a hidden-character filter that ran first would walk
    // straight past it.
    const message = fakeMessage(1, { html: "<p>ig&#8203;nore prev&#x200B;ious</p>" });

    expect(await normaliseBody(message)).toBe("ignore previous");
  });
});

describe("stripInvisible", () => {
  it("removes zero-width and joining characters", () => {
    expect(stripInvisible("ig\u200Bno\u200Cre\u200D th\u2060is\uFEFF")).toBe("ignore this");
  });

  it("removes bidi overrides and the Unicode tag block", () => {
    expect(stripInvisible("safe\u202Etxet\u202C")).toBe("safetxet");
    expect(stripInvisible("plain\u{E0041}\u{E0042}")).toBe("plain");
  });

  it("removes control characters but keeps tab, newline and carriage return", () => {
    expect(stripInvisible("a\u0000b\u001Fc\u007Fd\u009Ee")).toBe("abcde");
    expect(stripInvisible("a\tb\nc")).toBe("a\tb\nc");
  });

  it("keeps emoji and their variation selectors", () => {
    expect(stripInvisible("ship it ✈️ \u{1F680}")).toBe("ship it ✈️ \u{1F680}");
  });

  it("normalises to NFC, so decomposed and precomposed text match", () => {
    // "cafe" + U+0301 COMBINING ACUTE, and the precomposed "café". The same
    // word to a reader, two different strings to FTS5 unless this runs.
    expect(stripInvisible("cafe\u0301")).toBe("caf\u00E9");
    expect(stripInvisible("cafe\u0301")).toBe(stripInvisible("caf\u00E9"));
  });

  it("turns Unicode line and paragraph separators into newlines", () => {
    expect(stripInvisible("a\u2028b\u2029c")).toBe("a\nb\nc");
  });
});

describe("normaliseBody", () => {
  it("prefers the plain-text part, keeping its own whitespace", async () => {
    const message = fakeMessage(1, {
      text: "  indented line\n\n\n\nafter blank lines   \n",
      html: "<p>the html alternative</p>",
    });

    expect(await normaliseBody(message)).toBe("indented line\n\nafter blank lines");
  });

  it("falls back to the HTML when there is no usable text part", async () => {
    const message = fakeMessage(1, { text: "   \n  ", html: "<p>only in the html</p>" });

    expect(await normaliseBody(message)).toBe("only in the html");
  });

  it("is null when there is no body at all", async () => {
    expect(await normaliseBody(fakeMessage(1))).toBeNull();
    expect(await normaliseBody(fakeMessage(1, { text: "\u200B\u200B" }))).toBeNull();
  });

  it("truncates a body that would approach D1's per-value limit", async () => {
    const body = await normaliseBody(fakeMessage(1, { text: "x".repeat(MAX_BODY_CHARS + 5000) }));

    expect(body).toHaveLength(MAX_BODY_CHARS + "\n[truncated by imap-mcp]".length);
    expect(body).toContain("[truncated by imap-mcp]");
  });
});

describe("extractAddress", () => {
  it("takes the address out of a display name and lowercases it", () => {
    expect(extractAddress("Ada Lovelace <Ada@Example.COM>")).toBe("ada@example.com");
    expect(extractAddress("  bare@example.com ")).toBe("bare@example.com");
    expect(extractAddress('"Quoted Name" <q@example.com>')).toBe("q@example.com");
    expect(extractAddress("")).toBeNull();
  });
});

describe("parseSentDate", () => {
  it("parses a Date header and refuses everything else", () => {
    expect(parseSentDate("Thu, 20 Aug 2026 09:00:00 +0000")).toBe(Date.parse("2026-08-20T09:00Z"));
    // Attacker-controlled and frequently nonsense, so an unparseable one is
    // null rather than an invented timestamp.
    expect(parseSentDate("last Tuesday-ish")).toBeNull();
    expect(parseSentDate(undefined)).toBeNull();
  });
});

describe("toMessageRow", () => {
  it("maps the envelope onto the columns the schema expects", async () => {
    const message = fakeMessage(7, {
      subject: "Café \u200Brésumé",
      from: ["Ada Lovelace <Ada@Example.invalid>"],
      to: ["bob@example.invalid", "carol@example.invalid"],
      cc: ["dave@example.invalid"],
      flags: ["Seen"],
      size: 4096,
      text: "the body",
      attachments: [fakeAttachment()],
      headers: {
        date: "Thu, 20 Aug 2026 09:00:00 +0000",
        "in-reply-to": "<parent@example.invalid>",
        references: "<root@example.invalid> <parent@example.invalid>",
      },
    });

    const row = await toMessageRow(message, 3, 100);

    expect(row).toEqual({
      folderId: 3,
      uidValidity: 100,
      uid: 7,
      rfcMessageId: "<7@example.invalid>",
      inReplyTo: "<parent@example.invalid>",
      referenceIds: '["<root@example.invalid>","<parent@example.invalid>"]',
      subject: "Café résumé",
      fromAddress: "ada@example.invalid",
      fromAddresses: '["Ada Lovelace <Ada@Example.invalid>"]',
      toAddresses: '["bob@example.invalid","carol@example.invalid"]',
      ccAddresses: '["dave@example.invalid"]',
      internalDate: Date.parse("2026-08-20T09:00:00Z"),
      sentDate: Date.parse("2026-08-20T09:00:00Z"),
      sizeBytes: 4096,
      flags: '["Seen"]',
      bodyText: "the body",
      hasAttachments: 1,
    });
  });

  it("falls back to the Date header when INTERNALDATE is unusable", async () => {
    const message = fakeMessage(1, {
      internalDate: new Date("nonsense"),
      headers: { date: "Thu, 20 Aug 2026 09:00:00 +0000" },
    });

    expect((await toMessageRow(message, 1, 100)).internalDate).toBe(
      Date.parse("2026-08-20T09:00:00Z"),
    );
  });

  it("falls back to the epoch when there is no usable date at all", async () => {
    // internal_date is NOT NULL, and a run of mail dated today would be a
    // quieter lie than one dated 1970.
    const message = fakeMessage(1, { internalDate: new Date("nonsense"), headers: {} });

    expect((await toMessageRow(message, 1, 100)).internalDate).toBe(0);
  });
});
