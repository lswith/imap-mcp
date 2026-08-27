/**
 * How this package fails: loudly, typed, and without the password in it.
 *
 * Both properties are repo rules rather than preferences. A revoked password
 * retried at queue speed is how an Apple ID gets locked, so an authentication
 * failure is marked non-retryable. And the app-specific password grants full
 * mailbox access including SMTP send, so it must not survive anywhere a log
 * line can reach — error paths above all.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { connectMailbox } from "../../../src/imap";
import { ImapAuthError, ImapProtocolError, ImapTimeoutError } from "../../../src/imap/errors";
import { resetServers } from "../support/fake-sockets";
import { fakeMessage, plainText } from "../support/fixtures";
import { fakeServer, openMailbox, TEST_PASSWORD } from "../support/harness";

beforeEach(() => {
  resetServers();
});

function connect(overrides: Parameters<typeof connectMailbox>[0] | object = {}) {
  return connectMailbox({
    host: "imap.example.invalid",
    port: 993,
    username: "ada",
    password: TEST_PASSWORD,
    timeoutMs: 250,
    ...overrides,
  });
}

describe("authentication", () => {
  it("raises a non-retryable ImapAuthError when the server says NO", async () => {
    fakeServer({ authFailure: "AUTHENTICATIONFAILED invalid credentials" });

    const error = await connect().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImapAuthError);
    expect((error as ImapAuthError).retryable).toBe(false);
    expect((error as Error).message).toContain("invalid credentials");
  });

  it("keeps the password out of the error when the server echoes the command", async () => {
    // Servers are allowed to quote back the command they rejected, which is
    // how a credential ends up in a log line via an error path.
    fakeServer({ authFailure: `BAD Invalid command: LOGIN "ada" "${TEST_PASSWORD}"` });

    const error = (await connect().catch((cause: unknown) => cause)) as Error;

    expect(error.message).not.toContain(TEST_PASSWORD);
    expect(error.message).toContain("[redacted]");
    expect(String((error.cause as Error).message)).not.toContain(TEST_PASSWORD);
    expect(JSON.stringify(error)).not.toContain(TEST_PASSWORD);
  });
});

describe("connection failures", () => {
  it("surfaces a BYE greeting as a retryable protocol error", async () => {
    fakeServer({ greeting: "* BYE Too many simultaneous connections\r\n" });

    const error = (await connect().catch((cause: unknown) => cause)) as ImapProtocolError;

    expect(error).toBeInstanceOf(ImapProtocolError);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("BYE");
  });

  it("surfaces a greeting that is not IMAP at all", async () => {
    fakeServer({ greeting: "HTTP/1.1 400 Bad Request\r\n" });

    const error = await connect().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImapProtocolError);
  });

  it("times out rather than hanging when the server stops answering", async () => {
    fakeServer({
      messages: [fakeMessage(1, plainText)],
      // Swallow SELECT: the connection stays open and says nothing.
      onCommand: (command) => (command.name === "SELECT" ? [] : null),
    });

    const mailbox = await connect();
    const error = await mailbox.selectFolder("Archive").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImapTimeoutError);
    expect((error as ImapTimeoutError).retryable).toBe(true);
  });

  it("fails cleanly when the connection drops in the middle of a literal", async () => {
    const { mailbox } = await openMailbox({
      messages: [fakeMessage(1, plainText)],
      onCommand: (command, server) => {
        if (command.name !== "UID FETCH") return null;
        // Announce 4096 bytes of message, send twelve, hang up.
        server.send(
          `* 1 FETCH (UID 1 FLAGS () INTERNALDATE "20-Aug-2026 09:00:00 +0000" RFC822.SIZE 4096 BODY[] {4096}\r\n`,
          "truncated...",
        );
        server.disconnect();
        return [];
      },
    });
    await mailbox.selectFolder("Archive");

    const error = await mailbox.fetchMessages({ uids: 1 }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImapProtocolError);
    expect((error as Error).message).toContain("closed");
  });

  it("reports a NO on an ordinary command as a protocol error, not an auth error", async () => {
    const { mailbox } = await openMailbox({
      onCommand: (command) =>
        command.name === "SELECT" ? [`${command.tag} NO [NONEXISTENT] no such folder\r\n`] : null,
    });

    const error = await mailbox.selectFolder("Nope").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ImapProtocolError);
    expect(error).not.toBeInstanceOf(ImapAuthError);
  });
});

describe("credential containment", () => {
  it("does not expose the password on the mailbox object", async () => {
    const { mailbox } = await openMailbox();

    expect(JSON.stringify(mailbox)).not.toContain(TEST_PASSWORD);
    expect(Object.values(mailbox as object).join(" ")).not.toContain(TEST_PASSWORD);
  });
});
