/**
 * The parts that need no socket, run where this code actually ships.
 *
 * Importing the package at all is half the test: it pulls in cf-imap and its
 * `cloudflare:sockets` import, so a build that cannot run inside a Worker
 * fails here rather than on deploy.
 */

import { describe, expect, it } from "vitest";
import {
  connectMailbox,
  formatUidSet,
  ImapAuthError,
  ImapProtocolError,
  ImapTimeoutError,
  MAX_UID,
  MailboxError,
} from "../../../src/imap";
import { passwordForms, redactSecrets } from "../../../src/imap/errors";
import { toUidRuns } from "../../../src/imap/uids";

describe("the package under workerd", () => {
  it("loads and exports a connect function", () => {
    expect(typeof connectMailbox).toBe("function");
  });
});

describe("formatUidSet", () => {
  it("formats a single UID", () => {
    expect(formatUidSet(42)).toBe("42");
  });

  it("formats a range, and an open-ended one", () => {
    expect(formatUidSet({ from: 1, to: 10 })).toBe("1:10");
    expect(formatUidSet({ from: 10, to: 10 })).toBe("10");
    expect(formatUidSet({ from: 90, to: "*" })).toBe("90:*");
  });

  it("collapses a list into contiguous runs", () => {
    expect(formatUidSet([3, 1, 2, 9, 10, 40])).toBe("1:3,9:10,40");
  });

  it("rejects anything that is not a usable UID", () => {
    expect(() => formatUidSet(0)).toThrow(RangeError);
    expect(() => formatUidSet(-1)).toThrow(RangeError);
    expect(() => formatUidSet(1.5)).toThrow(RangeError);
    expect(() => formatUidSet(MAX_UID + 1)).toThrow(RangeError);
    expect(() => formatUidSet([])).toThrow(RangeError);
    expect(() => formatUidSet({ from: 10, to: 2 })).toThrow(RangeError);
  });
});

describe("toUidRuns", () => {
  it("expands '*' to the largest UID a server can assign", () => {
    expect(toUidRuns({ from: 5, to: "*" })).toEqual([{ from: 5, to: MAX_UID }]);
  });

  it("splits a sparse set so a gap is never fetched", () => {
    expect(toUidRuns([3, 4, 900])).toEqual([
      { from: 3, to: 4 },
      { from: 900, to: 900 },
    ]);
  });
});

describe("errors", () => {
  it("marks an auth failure as the one thing not to retry", () => {
    const error = new ImapAuthError("nope");

    expect(error).toBeInstanceOf(MailboxError);
    expect(error.retryable).toBe(false);
    expect(error.name).toBe("ImapAuthError");
  });

  it("marks protocol and timeout failures retryable", () => {
    expect(new ImapProtocolError("eh").retryable).toBe(true);
    expect(new ImapTimeoutError("slow").retryable).toBe(true);
  });
});

describe("redaction", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redactSecrets("a hunter2 b hunter2", ["hunter2"])).toBe("a [redacted] b [redacted]");
  });

  it("leaves text alone when there is nothing to redact", () => {
    expect(redactSecrets("nothing here", [""])).toBe("nothing here");
  });

  it("covers the quoted and SASL-encoded forms of the password", () => {
    const forms = passwordForms("ada", 'pa"ss\\word');

    expect(forms).toContain('pa"ss\\word');
    expect(forms).toContain('pa\\"ss\\\\word');
    const nul = "\u0000";
    expect(forms).toContain(btoa(`${nul}ada${nul}pa"ss\\word`));
  });

  it("has nothing to redact when there is no password", () => {
    expect(passwordForms("ada", "")).toEqual([]);
  });
});
