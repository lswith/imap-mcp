import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Mailbox } from "../../src/imap";
import { ImapAuthError } from "../../src/imap";
import { handleRequest } from "../../src/mcp/handler";
import { collectStatus, type StatusReport } from "../../src/status";
import { FakeMailbox } from "../sync/support/fake-mailbox";
import { API_KEY, authenticated, unauthenticated } from "./support/access";
import { seedMessage } from "./support/seed";

const STATUS = "https://imap-mcp.invalid/status";

/** The environment of an instance that has not configured Access. */
function keyMode(overrides: Partial<Env> = {}): Env {
  return { ...env, ACCESS_AUD: undefined, ...overrides } as Env;
}

function get(url = STATUS, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "GET", headers });
}

async function body(response: Response): Promise<StatusReport> {
  return JSON.parse(await response.text());
}

/** The watermark and uid space a folder row carries, which nothing seeds. */
async function setFolderProgress(name: string, uidNext: number, watermark: number) {
  await env.DB.prepare(
    "UPDATE folders SET uid_next = ?, last_synced_uid = ?, last_synced_at = ? WHERE name = ?",
  )
    .bind(uidNext, watermark, Date.parse("2026-08-27T20:00:37Z"), name)
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM folders"),
    env.DB.prepare("DELETE FROM write_log"),
  ]);
});

describe("the status endpoint's gate", () => {
  it("refuses an unauthenticated caller in Access mode", async () => {
    // Same gate as /mcp, deliberately: this document names folders, a
    // hostname and a mailbox user, which is nothing to hand a stranger.
    const response = await handleRequest(get(), env, unauthenticated());

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("folders");
  });

  it("refuses a caller without the key in API-key mode", async () => {
    const response = await handleRequest(get(), keyMode(), unauthenticated());

    expect(response.status).toBe(401);
  });

  it("refuses the API key once Access is configured", async () => {
    // Precedence, not fallback — the same rule /mcp enforces.
    const request = get(STATUS, { authorization: `Bearer ${API_KEY}` });

    const response = await handleRequest(request, env, unauthenticated());

    expect(response.status).toBe(401);
  });

  it("turns away a cross-origin browser request before authenticating it", async () => {
    // Order matters here as it does for /mcp: an authenticated DNS-rebound
    // page is exactly the case the Origin check exists for.
    const request = get(STATUS, { origin: "https://evil.example" });

    const response = await handleRequest(request, env, authenticated());

    expect(response.status).toBe(403);
  });

  it("admits a caller Access authenticated for this application", async () => {
    const response = await handleRequest(get(), env, authenticated());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("admits a caller presenting the key in API-key mode", async () => {
    const request = get(STATUS, { authorization: `Bearer ${API_KEY}` });

    const response = await handleRequest(request, keyMode(), unauthenticated());

    expect(response.status).toBe(200);
    expect((await body(response)).auth.mode).toBe("api-key");
  });

  it("answers a write with 405 rather than a document", async () => {
    const request = new Request(STATUS, { method: "POST", body: "{}" });

    const response = await handleRequest(request, env, authenticated());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("does not connect to the mailbox unless asked to", async () => {
    // A connection is not something a URL should cause by accident: an
    // app-specific password re-attempted in a loop is how an Apple ID gets
    // locked. No `probe` parameter, no `mailbox` key.
    const response = await handleRequest(get(), env, authenticated());

    expect((await body(response)).mailbox).toBeUndefined();
  });
});

describe("the status document", () => {
  it("reports what has been indexed, per folder", async () => {
    await seedMessage({ folder: "Archive", uid: 1, date: "2026-01-02T00:00:00Z" });
    await seedMessage({ folder: "Archive", uid: 2, date: "2026-03-04T00:00:00Z" });
    await seedMessage({ folder: "Archive", uid: 3, oversize: true });
    await setFolderProgress("Archive", 10, 3);

    const report = await collectStatus(env);

    expect(report.ok).toBe(true);
    expect(report.index.messages).toBe(3);
    expect(report.index.folders).toHaveLength(1);
    const [folder] = report.index.folders;
    expect(folder.name).toBe("Archive");
    expect(folder.messages).toBe(3);
    expect(folder.oversize).toBe(1);
    expect(folder.watermark).toBe(3);
    expect(folder.oldest).toBe("2026-01-02T00:00:00.000Z");
    expect(folder.lastSyncedAt).toBe("2026-08-27T20:00:37.000Z");
  });

  it("counts rows under a previous uidvalidity apart from the reachable ones", async () => {
    // "Indexed but unreachable" is a real state — a renumbered folder — and
    // an index that reads as empty while holding thousands of rows is exactly
    // the confusion this document exists to end.
    await seedMessage({ folder: "Archive", folderUidValidity: 200, uidValidity: 200, uid: 1 });
    await seedMessage({ folder: "Archive", folderUidValidity: 200, uidValidity: 100, uid: 2 });

    const [folder] = (await collectStatus(env)).index.folders;

    expect(folder.messages).toBe(1);
    expect(folder.staleRows).toBe(1);
  });

  it("calls a folder converged once the watermark reaches the top of its uid space", async () => {
    await seedMessage({ folder: "Archive", uid: 9 });
    await setFolderProgress("Archive", 10, 9);

    const [folder] = (await collectStatus(env)).index.folders;

    expect(folder.converged).toBe(true);
    expect(folder.highestUid).toBe(9);
  });

  it("reports the watermark and the highest stored uid without judging between them", async () => {
    // A watermark far below the rows above it is the shape of a stall — and
    // ALSO the shape of every healthy tick, because enumeration records the
    // watermark from what was complete when it walked and the consumers it
    // queued store the ranges above it afterwards. One snapshot cannot tell
    // those apart, so this document reports both numbers and claims nothing
    // about the distance between them (#54). The claim that needs two
    // observations is made where two observations exist: the `[cron]` warning.
    await seedMessage({ folder: "Archive", uid: 50 });
    await seedMessage({ folder: "Archive", uid: 900 });
    await setFolderProgress("Archive", 1000, 47);

    const [folder] = (await collectStatus(env)).index.folders;

    expect(folder.watermark).toBe(47);
    expect(folder.highestUid).toBe(900);
    expect(folder.converged).toBe(false);
    expect(folder).not.toHaveProperty("stalled");
  });

  it("reports the schema as applied, with the migration count", async () => {
    const report = await collectStatus(env);

    expect(report.schema.ok).toBe(true);
    expect(report.schema.migrations).toBeGreaterThan(0);
  });

  it("names a missing variable without quoting its value", async () => {
    // The same reader the cron uses, so this cannot drift from what the cron
    // will do at the top of the hour.
    const report = await collectStatus({ ...env, IMAP_HOST: undefined } as Env);

    expect(report.ok).toBe(false);
    expect(report.config).toEqual({ ok: false, error: "IMAP_HOST is not set" });
  });

  it("answers 503 when something it can check itself is wrong", async () => {
    const request = get(STATUS, { authorization: `Bearer ${API_KEY}` });

    const response = await handleRequest(
      request,
      keyMode({ IMAP_HOST: undefined }),
      unauthenticated(),
    );

    expect(response.status).toBe(503);
    expect((await body(response)).ok).toBe(false);
  });

  it("reports a database it cannot read instead of throwing", async () => {
    // The unmigrated instance, and the one whose binding points at nothing.
    // Both are states where every tool fails with a missing-table error, so
    // the document that exists to explain that must not fail the same way.
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("no such table: d1_migrations");
        },
      },
    } as unknown as Env;

    const report = await collectStatus(broken);

    expect(report.ok).toBe(false);
    expect(report.schema.ok).toBe(false);
    expect(report.schema.detail).toContain("no such table");
    expect(report.index.folders).toEqual([]);
    expect(report.writes).toEqual({ total: 0, failed: 0, lastAt: null });
  });

  it("never carries the password, whatever it is asked", async () => {
    const connect = async (): Promise<Mailbox> => {
      throw new Error(`login failed for ${env.IMAP_PASSWORD}`);
    };

    const report = await collectStatus(env, { probe: true }, { connect });
    const rendered = JSON.stringify(report);

    expect(report.mailbox?.ok).toBe(false);
    // The document is scrubbed on its way out as well; this asserts the
    // report itself, because the boundary is the second line of defence.
    expect(rendered.includes(env.IMAP_PASSWORD)).toBe(false);
  });
});

describe("the mailbox probe", () => {
  it("confirms the configured folders are on the server", async () => {
    const mailbox = new FakeMailbox({ folders: [{ name: "Archive" }, { name: "Sent" }] });

    const report = await collectStatus(env, { probe: true }, { connect: async () => mailbox });

    expect(report.mailbox).toEqual({ ok: true, folders: 2, missing: [] });
    expect(report.ok).toBe(true);
    expect(mailbox.closed).toBe(true);
  });

  it("names a configured folder the server does not have", async () => {
    const mailbox = new FakeMailbox({ folders: [{ name: "Sent" }] });

    const report = await collectStatus(env, { probe: true }, { connect: async () => mailbox });

    expect(report.mailbox).toEqual({ ok: false, folders: 1, missing: ["Archive"] });
    expect(report.ok).toBe(false);
  });

  it("reports a rejected credential rather than throwing it", async () => {
    // The question the probe exists for, and the one the next cron tick would
    // otherwise answer an hour later, into a log nobody is reading.
    const connect = async (): Promise<Mailbox> => {
      throw new ImapAuthError("IMAP authentication failed: NO [AUTHENTICATIONFAILED]");
    };

    const report = await collectStatus(env, { probe: true }, { connect });

    expect(report.ok).toBe(false);
    expect(report.mailbox?.error).toContain("AUTHENTICATIONFAILED");
  });

  it("says it is not configured rather than connecting to nothing", async () => {
    const report = await collectStatus({ ...env, IMAP_HOST: undefined } as Env, { probe: true });

    expect(report.mailbox).toEqual({ ok: false, error: "not configured; see config.error" });
  });
});
