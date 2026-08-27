import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readSyncConfig } from "../../src/sync/config";
import { mailboxConfig } from "../../src/sync/session";

// The connection this worker opens. `deps.connect` is what every other test in
// this package injects, which means the real connection options are otherwise
// unobservable from here — and the one option that matters is silently wrong
// when it is missing rather than loudly wrong.

describe("the mailbox connection", () => {
  it("enables CONDSTORE, because it can only be enabled before the first SELECT", async () => {
    // RFC 5161 requires ENABLE in the authenticated state. Issued after a
    // SELECT the server simply omits HIGHESTMODSEQ, which reads as "this
    // server has no CONDSTORE" and is not. connectMailbox issues it between
    // authentication and handing back a Mailbox, so passing it here is the
    // only place the ordering can be got right.
    expect(mailboxConfig(readSyncConfig(env as unknown as Env)).enable).toEqual(["CONDSTORE"]);
  });

  it("carries the mailbox address without inventing anything", async () => {
    const config = mailboxConfig(readSyncConfig(env as unknown as Env));
    expect(config).toMatchObject({
      host: "imap.example.invalid",
      port: 993,
      username: "ada",
    });
  });
});
