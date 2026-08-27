import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createLogger, createScrubber, describeError, readLogLevel } from "../src/log";

/** The env a deployer left alone, and one they configured. */
function withLevel(level?: string): Env {
  return { ...env, LOG_LEVEL: level } as Env;
}

/** Captures every console channel at once, so a test can assert on silence. */
function capture() {
  const calls: string[] = [];
  const push = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  const spies = [
    vi.spyOn(console, "debug").mockImplementation(push),
    vi.spyOn(console, "log").mockImplementation(push),
    vi.spyOn(console, "warn").mockImplementation(push),
    vi.spyOn(console, "error").mockImplementation(push),
  ];
  return {
    lines: calls,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function say(level?: string, component?: string): string[] {
  const console = capture();
  const log = createLogger(withLevel(level), component);
  log.debug("a debug line");
  log.info("an info line");
  log.warn("a warn line");
  log.error("an error line");
  console.restore();
  return console.lines;
}

describe("readLogLevel", () => {
  it("defaults to info", () => {
    expect(readLogLevel(withLevel(undefined))).toBe("info");
    expect(readLogLevel(withLevel("   "))).toBe("info");
  });

  it.each(["debug", "info", "warn", "error", "silent"])("accepts %s", (level) => {
    expect(readLogLevel(withLevel(level))).toBe(level);
    expect(readLogLevel(withLevel(level.toUpperCase()))).toBe(level);
  });

  it("falls back to info, loudly, rather than throwing", () => {
    // Logging is how every other failure reports itself, so a typo here must
    // not be the failure that hides them.
    const console = capture();

    const level = readLogLevel(withLevel("verbose"));

    console.restore();
    expect(level).toBe("info");
    expect(console.lines.join("\n")).toContain("LOG_LEVEL is not one of");
  });

  it("does not echo the value it rejected", () => {
    const console = capture();

    readLogLevel(withLevel("hunter2"));

    console.restore();
    expect(console.lines.join("\n")).not.toContain("hunter2");
  });
});

describe("createLogger", () => {
  it("says everything but debug by default", () => {
    const lines = say();

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("a debug line");
    expect(lines.join("\n")).toContain("an info line");
  });

  it("says everything at debug", () => {
    expect(say("debug")).toHaveLength(4);
  });

  it.each([
    ["warn", 2],
    ["error", 1],
    ["silent", 0],
  ])("says %s and above", (level, expected) => {
    expect(say(level)).toHaveLength(expected);
  });

  it("tags every line with the entry point it came from", () => {
    // The point of the tag: "is the cron running at all?" is a filter rather
    // than a reading of every line in the timeline.
    const lines = say("debug", "cron");

    expect(lines.every((line) => line.startsWith("[cron] "))).toBe(true);
  });

  it("scrubs the password out of every level", () => {
    // The load-bearing rule of this file. The password grants full mailbox
    // access including SMTP send, and error paths are where credentials
    // usually escape — so every channel is checked, not just the happy one.
    const console = capture();
    const log = createLogger(withLevel("debug"));
    const password = env.IMAP_PASSWORD;

    log.debug(`connecting with ${password}`);
    log.info(`connected with ${password}`);
    log.warn(`retrying with ${password}`);
    log.error(`failed with ${password}`);

    console.restore();
    expect(console.lines).toHaveLength(4);
    expect(console.lines.join("\n")).not.toContain(password);
  });
});

describe("createScrubber", () => {
  it("redacts the password in text that is not a log line", () => {
    const scrub = createScrubber(env);

    expect(scrub(`the password is ${env.IMAP_PASSWORD}`)).not.toContain(env.IMAP_PASSWORD);
  });
});

describe("describeError", () => {
  it("names the cause a MailboxError carries", () => {
    const error = new Error("the write failed", { cause: new TypeError("socket closed") });

    expect(describeError(error)).toBe(
      "Error: the write failed (caused by TypeError: socket closed)",
    );
  });

  it("stringifies whatever else was thrown", () => {
    expect(describeError("just a string")).toBe("just a string");
  });
});
