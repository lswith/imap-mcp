/**
 * The command surface: what this interface puts on the wire, and what it makes
 * of what comes back.
 *
 * Several of these assert on the exact command sent rather than only on the
 * return value, because the safety properties downstream tickets depend on
 * (#5, #8, #12) live in the command text: PEEK, UID EXPUNGE, ENABLE before
 * SELECT.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { resetServers } from "../support/fake-sockets";
import { fakeMessage, plainText } from "../support/fixtures";
import { openMailbox } from "../support/harness";

beforeEach(() => {
  resetServers();
});

const messages = [
  fakeMessage(1, plainText),
  fakeMessage(2, plainText, ["Seen"]),
  fakeMessage(5, plainText),
];

describe("folders", () => {
  it("lists folders with attributes and delimiters", async () => {
    const { mailbox } = await openMailbox();

    const folders = await mailbox.listFolders();

    expect(folders).toEqual([
      { name: "INBOX", delimiter: "/", attributes: ["HasNoChildren"] },
      { name: "Archive", delimiter: "/", attributes: ["HasNoChildren", "Archive"] },
    ]);
  });

  it("reports UIDVALIDITY and UIDNEXT from SELECT", async () => {
    const { mailbox } = await openMailbox({ messages, uidValidity: 17 });

    const state = await mailbox.selectFolder("Archive");

    expect(state.name).toBe("Archive");
    expect(state.exists).toBe(3);
    expect(state.uidValidity).toBe(17);
    expect(state.uidNext).toBe(6);
    expect(state.readOnly).toBe(false);
    expect(state.permanentFlags).toContain("Seen");
  });

  it("opens read-only with EXAMINE", async () => {
    const { server, mailbox } = await openMailbox({ messages });

    const state = await mailbox.selectFolder("Archive", { readOnly: true });

    expect(state.readOnly).toBe(true);
    expect(server.commands.some((command) => command.includes("EXAMINE"))).toBe(true);
  });

  it("answers STATUS without selecting", async () => {
    const { mailbox } = await openMailbox({ messages });

    const status = await mailbox.status("Archive");

    expect(status.messages).toBe(3);
    expect(status.unseen).toBe(2);
  });
});

describe("CONDSTORE", () => {
  it("ENABLEs before the first SELECT, and then sees HIGHESTMODSEQ", async () => {
    const { server, mailbox } = await openMailbox(
      { messages, condstore: true, highestModSeq: 4242, enableReply: [] },
      { enable: ["CONDSTORE"] },
    );

    const state = await mailbox.selectFolder("Archive");

    const enableAt = server.commands.findIndex((command) => command.includes("ENABLE CONDSTORE"));
    const selectAt = server.commands.findIndex((command) => command.includes("SELECT"));
    expect(enableAt).toBeGreaterThanOrEqual(0);
    expect(enableAt).toBeLessThan(selectAt);

    // The server confirmed an empty ENABLED list — as iCloud does — and
    // CONDSTORE is on regardless. HIGHESTMODSEQ appearing is the signal.
    expect(state.highestModSeq).toBe(4242);
    expect(state.noModSeq).toBe(false);
  });

  it("gets no HIGHESTMODSEQ at all when CONDSTORE was not enabled first", async () => {
    const { mailbox } = await openMailbox({ messages, condstore: true, highestModSeq: 4242 });

    const state = await mailbox.selectFolder("Archive");

    expect(state.highestModSeq).toBeUndefined();
  });
});

describe("fetching", () => {
  it("always fetches with PEEK, so indexing never marks mail read", async () => {
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    await mailbox.fetchMessages({ uids: { from: 1, to: 5 } });

    const fetch = server.commands.find((command) => command.includes("UID FETCH"));
    expect(fetch).toContain("BODY.PEEK[]");
    expect(fetch).not.toMatch(/BODY\[/);
  });

  it("still reports RFC822.SIZE when only headers were asked for", async () => {
    // The sync worker reads sizes for a whole uid range before it pulls any
    // bodies, so that a message too large to fetch is a decision rather than an
    // exhausted isolate (#9). That only works because cf-imap asks for
    // RFC822.SIZE on the header-only path too — a contract over the pinned
    // dependency, not something this repo controls.
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    const fetched = await mailbox.fetchMessages({ uids: { from: 1, to: 5 }, includeBody: false });

    const fetch = server.commands.find((command) => command.includes("UID FETCH"));
    expect(fetch).toContain("RFC822.SIZE");
    expect(fetch).toContain("BODY.PEEK[HEADER.FIELDS");
    for (const message of fetched) expect(message.size).toBeGreaterThan(0);
  });

  it("asks for a partial body when a byteLimit is given", async () => {
    // `<0.N>` is a partial fetch: it truncates rather than refusing, which is
    // why the worker decides on size first and treats this as a second line of
    // defence rather than the mechanism.
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    await mailbox.fetchMessages({ uids: 1, byteLimit: 4096 });

    const fetch = server.commands.find((command) => command.includes("UID FETCH"));
    expect(fetch).toContain("BODY.PEEK[]<0.4096>");
  });

  it("fetches a sparse UID set as one command per contiguous run", async () => {
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    const fetched = await mailbox.fetchMessages({ uids: [1, 2, 5] });

    expect(fetched.map((message) => message.uid)).toEqual([1, 2, 5]);
    const ranges = server.commands
      .filter((command) => command.includes("UID FETCH"))
      .map((command) => /UID FETCH (\S+)/.exec(command)?.[1]);
    expect(ranges).toEqual(["1:2", "5"]);
  });

  it("fetches to the end of the folder with an open-ended range", async () => {
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    const fetched = await mailbox.fetchMessages({ uids: { from: 2, to: "*" } });

    expect(fetched.map((message) => message.uid)).toEqual([2, 5]);
    const fetch = server.commands.find((command) => command.includes("UID FETCH"));
    // "*" is sent as the maximum 32-bit UID, which selects the same messages.
    expect(fetch).toContain("UID FETCH 2:4294967295");
  });

  it("fetches headers only when the body is not wanted", async () => {
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    const [message] = await mailbox.fetchMessages({ uids: 1, includeBody: false });

    expect(message.subject).toBe("Hello, world!");
    expect(message.text).toBeUndefined();
    expect(server.commands.at(-1)).toContain("BODY.PEEK[HEADER.FIELDS");
  });

  it("searches by UID", async () => {
    const { server, mailbox } = await openMailbox({ messages, searchResult: [2, 5] });
    await mailbox.selectFolder("Archive");

    const uids = await mailbox.search({ since: new Date("2026-08-01T00:00:00Z"), seen: true });

    expect(uids).toEqual([2, 5]);
    const search = server.commands.at(-1);
    expect(search).toContain("UID SEARCH");
    expect(search).toContain("SINCE 1-Aug-2026");
    expect(search).toContain("SEEN");
  });
});

describe("writes", () => {
  it("verifies a flag write by reading it back", async () => {
    const { server, mailbox } = await openMailbox(
      { messages, condstore: true },
      {
        enable: ["CONDSTORE"],
      },
    );
    await mailbox.selectFolder("Archive");

    const result = await mailbox.setFlags(1, ["Flagged"]);

    // Under CONDSTORE the STORE confirmation carries a MODSEQ the client
    // cannot parse, so the STORE response is worthless — this value can only
    // have come from the read-back.
    expect(result).toEqual([{ uid: 1, flags: ["Flagged"] }]);

    const store = server.commands.findIndex((command) => command.includes("UID STORE"));
    const readBack = server.commands.findIndex(
      (command, index) => index > store && command.includes("UID FETCH"),
    );
    expect(store).toBeGreaterThanOrEqual(0);
    expect(readBack).toBeGreaterThan(store);
    expect(server.commands[store]).toContain("UID STORE 1 +FLAGS (\\Flagged)");
  });

  it("removes and replaces flags", async () => {
    const { mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    expect(await mailbox.setFlags(2, ["Seen"], "remove")).toEqual([{ uid: 2, flags: [] }]);
    expect(await mailbox.setFlags(2, ["Draft"], "replace")).toEqual([{ uid: 2, flags: ["Draft"] }]);
  });

  it("copies and reports COPYUID", async () => {
    const { mailbox } = await openMailbox({ messages, uidValidity: 17 });
    await mailbox.selectFolder("Archive");

    const result = await mailbox.copy([1, 2], "Saved");

    expect(result).toEqual({ uidValidity: 17, sourceUids: "1,2", destUids: "6,7" });
  });

  it("expunges by UID and never issues a bare EXPUNGE", async () => {
    const { server, mailbox } = await openMailbox({ messages });
    await mailbox.selectFolder("Archive");

    await mailbox.setFlags(5, ["Deleted"]);
    const expunged = await mailbox.expunge(5);

    expect(expunged).toEqual([3]);
    expect(server.commands.some((command) => /^\S+ UID EXPUNGE 5$/.test(command))).toBe(true);
    expect(server.commands.some((command) => /^\S+ EXPUNGE/.test(command))).toBe(false);
  });

  it("appends a draft and reports APPENDUID", async () => {
    const { server, mailbox } = await openMailbox({ messages, uidValidity: 17 });

    const appended = await mailbox.append("Drafts", "Subject: hi\r\n\r\nbody\r\n", {
      flags: ["Draft"],
    });

    expect(appended).toEqual({ uidValidity: 17, uid: 6 });
    const append = server.commands.find((command) => command.includes("APPEND"));
    expect(append).toContain('APPEND "Drafts" (\\Draft) {21}');
  });

  it("reports the server's capabilities", async () => {
    const { mailbox } = await openMailbox();

    expect(mailbox.capabilities).toContain("UIDPLUS");
    expect(mailbox.capabilities).not.toContain("MOVE");
  });
});
