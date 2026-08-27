/**
 * What this instance is doing, as one authenticated GET.
 *
 * The gap this closes: a deployed instance answering `/mcp` correctly and a
 * deployed instance that has never indexed a single message look exactly the
 * same from outside, and the difference between them is an hour of cron and a
 * variable nobody can see. Every question that follows from "I deployed it and
 * I don't know if it works" is answerable from D1 and Env in a few
 * milliseconds — so this answers all of them at once, in one document, rather
 * than leaving them to be reconstructed from a dashboard, a log search and a
 * `wrangler d1 execute`.
 *
 * The questions, and where each is answered below:
 *
 *   Is it configured?      `config` — the same reader the cron uses, so a
 *                          missing IMAP_HOST fails here exactly as it fails
 *                          there, by name and without the value.
 *   Is the schema there?   `schema` — a migration that never ran turns every
 *                          tool into an error about a missing table.
 *   Is it indexing?        `index.folders[].messages` against `uidNext`, plus
 *                          when the last row was written.
 *   Is it converging?      `converged` and `stalled`. A backfill that is
 *                          working climbs; one that is stuck re-queues the
 *                          same ranges hourly and looks identical in the
 *                          request count.
 *   Which credential?      `auth.mode` — the one thing a 401 will not tell a
 *                          caller, since precedence means a good API key is
 *                          refused outright once ACCESS_AUD is set.
 *   Can it reach mail?     `mailbox`, and only when asked for: see PROBE.
 *
 * IT IS NOT PUBLIC. It is served behind the same gate as `/mcp`, after the
 * same Origin check, because it names folders, counts, a hostname and a
 * mailbox user — nothing secret, and nothing to hand an unauthenticated
 * caller either. The rendered document is scrubbed before it leaves, on the
 * same principle as every log line: the credential must not escape through a
 * path nobody thought about.
 *
 * PROBE. `?probe=mailbox` opens one connection and lists folders — the only
 * check here that leaves the Worker, and the only one that can answer "is the
 * password still good?" without waiting for the next tick. It runs ONCE per
 * request and is never retried, for the reason the cron and the write tools
 * are never retried: an app-specific password re-attempted in a loop is how an
 * Apple ID gets locked. Ask it when you are debugging, not on a schedule —
 * there is deliberately nothing here for a monitor to poll.
 */

import { createScrubber, type Logger, type LogLevel, readLogLevel } from "./log";
import { readAuthConfig } from "./mcp/auth";
import { describeSyncConfig, readSyncConfig } from "./sync/config";
import { type SyncDeps, withMailbox } from "./sync/session";

/** Folder names come off the mailbox, so they are collapsed like every other
 *  mailbox-derived string this Worker renders: one line, bounded length. */
const MAX_NAME_CHARS = 200;

type FolderStatus = {
  name: string;
  uidValidity: number | null;
  /** The next uid the server will hand out — the top of the uid space. */
  uidNext: number | null;
  /** Everything at or below this uid is indexed. Enumeration owns it. */
  watermark: number;
  lastSyncedAt: string | null;
  messages: number;
  oversize: number;
  withAttachments: number;
  /** Rows under a PREVIOUS uidvalidity: indexed, unreachable, awaiting re-sync. */
  staleRows: number;
  oldest: string | null;
  newest: string | null;
  lastWrite: string | null;
  /** The watermark has reached the top of the uid space: nothing left to do. */
  converged: boolean;
  /**
   * Rows exist above the watermark while the watermark has not moved past
   * them — the folder is fetching ranges it has already fetched, hourly. It is
   * derived rather than recorded because it is a relationship between two
   * numbers that are each individually fine.
   */
  stalled: boolean;
};

export type StatusReport = {
  /** Everything this document can check without leaving the Worker passed. */
  ok: boolean;
  checkedAt: string;
  worker: { logLevel: LogLevel };
  auth: { mode: "access" | "api-key" };
  config:
    | { ok: true; mailbox: string; user: string; summary: string }
    | { ok: false; error: string };
  schema: { ok: boolean; migrations: number; detail?: string };
  index: {
    messages: number;
    attachments: { rows: number; stored: number; extracted: number };
    folders: FolderStatus[];
  };
  writes: { total: number; failed: number; lastAt: string | null };
  mailbox?: { ok: boolean; folders?: number; missing?: string[]; error?: string };
};

type Scrub = (message: string) => string;

export type StatusOptions = {
  /** Open one connection to the mailbox. Off unless the caller asked. */
  probe?: boolean;
};

export async function collectStatus(
  env: Env,
  options: StatusOptions = {},
  deps: SyncDeps = {},
): Promise<StatusReport> {
  // Applied to every string in here that came from outside this file — a D1
  // error, a mailbox error — rather than only at the boundary in
  // statusResponse. Both, deliberately: the report is a value other code can
  // reach for (a test does), and a scrubber that only runs on the way out is
  // one refactor away from not running.
  const scrub = createScrubber(env);
  const report: StatusReport = {
    ok: true,
    checkedAt: new Date().toISOString(),
    worker: { logLevel: readLogLevel(env) },
    auth: { mode: readAuthConfig(env).mode },
    config: { ok: false, error: "not read" },
    schema: { ok: false, migrations: 0 },
    index: { messages: 0, attachments: { rows: 0, stored: 0, extracted: 0 }, folders: [] },
    writes: { total: 0, failed: 0, lastAt: null },
  };

  // The same reader the cron calls, deliberately. A status page with its own
  // idea of what "configured" means is a status page that says fine while the
  // cron says IMAP_HOST is not set.
  try {
    const config = readSyncConfig(env);
    report.config = {
      ok: true,
      mailbox: `${config.host}:${config.port}`,
      user: config.username,
      summary: describeSyncConfig(config),
    };
  } catch (error) {
    // The message names the variable and never its value — that is
    // SyncConfigError's own rule, and it is why this can be rendered as-is.
    report.config = { ok: false, error: error instanceof Error ? error.message : String(error) };
    report.ok = false;
  }

  await readSchema(env, report, scrub);
  await readIndex(env, report, scrub);
  await readWrites(env, report);

  if (options.probe) await probeMailbox(env, report, deps, scrub);

  return report;
}

/**
 * Whether migrations ran.
 *
 * Its own check because of how it fails otherwise: an instance whose schema
 * was never applied answers every tool with a D1 error about a missing table,
 * which reads like a broken query rather than a deploy that skipped a step.
 */
async function readSchema(env: Env, report: StatusReport, scrub: Scrub): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS applied FROM d1_migrations").first<{
      applied: number;
    }>();
    const applied = row?.applied ?? 0;
    report.schema = { ok: applied > 0, migrations: applied };
    if (applied === 0) {
      report.schema.detail = "no migrations recorded — run `pnpm run db:migrate:remote`";
      report.ok = false;
    }
  } catch (error) {
    report.schema = {
      ok: false,
      migrations: 0,
      detail: scrub(`could not read d1_migrations: ${describe(error)}`),
    };
    report.ok = false;
  }
}

const FOLDER_STATUS = `
  SELECT f.name AS name,
         f.uidvalidity AS uidValidity,
         f.uid_next AS uidNext,
         f.last_synced_uid AS watermark,
         f.last_synced_at AS lastSyncedAt,
         COUNT(m.id) AS messages,
         COALESCE(SUM(m.oversize), 0) AS oversize,
         COALESCE(SUM(m.has_attachments), 0) AS withAttachments,
         MIN(m.internal_date) AS oldest,
         MAX(m.internal_date) AS newest,
         MAX(m.synced_at) AS lastWrite,
         (SELECT COUNT(*) FROM messages s
           WHERE s.folder_id = f.id AND s.uidvalidity IS NOT f.uidvalidity) AS staleRows,
         (SELECT COALESCE(MAX(a.uid), 0) FROM messages a
           WHERE a.folder_id = f.id AND a.uidvalidity IS f.uidvalidity) AS highestUid
  FROM folders f
  LEFT JOIN messages m ON m.folder_id = f.id AND m.uidvalidity IS f.uidvalidity
  GROUP BY f.id
  ORDER BY f.name`;

type FolderRow = {
  name: string;
  uidValidity: number | null;
  uidNext: number | null;
  watermark: number;
  lastSyncedAt: number | null;
  messages: number;
  oversize: number;
  withAttachments: number;
  oldest: number | null;
  newest: number | null;
  lastWrite: number | null;
  staleRows: number;
  highestUid: number;
};

/**
 * The index, per folder, joined on the folder's CURRENT uidvalidity.
 *
 * The same join every read path makes, and for the same reason: rows written
 * under a previous generation are not part of what this folder holds now.
 * They are counted separately rather than ignored, because "45,000 messages,
 * none of them reachable" is a state worth being able to see.
 */
async function readIndex(env: Env, report: StatusReport, scrub: Scrub): Promise<void> {
  try {
    const [folders, attachments] = await Promise.all([
      env.DB.prepare(FOLDER_STATUS).all<FolderRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(r2_key IS NOT NULL), 0) AS stored,
                COALESCE(SUM(extracted_text IS NOT NULL), 0) AS extracted
         FROM attachments`,
      ).first<{ total: number; stored: number; extracted: number }>(),
    ]);

    report.index.folders = folders.results.map((row) => describeFolder(row));
    report.index.messages = report.index.folders.reduce((total, f) => total + f.messages, 0);
    report.index.attachments = {
      rows: attachments?.total ?? 0,
      stored: attachments?.stored ?? 0,
      extracted: attachments?.extracted ?? 0,
    };
  } catch (error) {
    // A failure here is the schema question again, already reported by
    // readSchema; recording it twice would say two things about one fault.
    report.schema.detail ??= scrub(`could not read the index: ${describe(error)}`);
    report.ok = false;
  }
}

function describeFolder(row: FolderRow): FolderStatus {
  // The top of the uid space. `uid_next - 1` is the highest uid the server can
  // have handed out; without it, the highest uid actually stored is the best
  // available floor, and a folder is then never called converged on nothing.
  const ceiling = row.uidNext ? row.uidNext - 1 : 0;
  return {
    name: oneLine(row.name),
    uidValidity: row.uidValidity,
    uidNext: row.uidNext,
    watermark: row.watermark,
    lastSyncedAt: asIso(row.lastSyncedAt),
    messages: row.messages,
    oversize: row.oversize,
    withAttachments: row.withAttachments,
    staleRows: row.staleRows,
    oldest: asIso(row.oldest),
    newest: asIso(row.newest),
    lastWrite: asIso(row.lastWrite),
    converged: ceiling > 0 && row.watermark >= ceiling,
    // Rows above the watermark mean ranges up there have been fetched; a
    // watermark that has not followed them means at least one bucket in
    // between never filled. That is the hourly-re-fetch state, and it does not
    // resolve itself: something in the gap is not being stored, and the
    // consumer's "returned no headers" warning names the uids.
    stalled: row.highestUid > row.watermark && ceiling > 0 && row.watermark < ceiling,
  };
}

async function readWrites(env: Env, report: StatusReport): Promise<void> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(outcome = 'error'), 0) AS failed,
              MAX(at) AS lastAt
       FROM write_log`,
    ).first<{ total: number; failed: number; lastAt: number | null }>();
    report.writes = {
      total: row?.total ?? 0,
      failed: row?.failed ?? 0,
      lastAt: asIso(row?.lastAt ?? null),
    };
  } catch {
    // Already covered by the schema check; the write log is the least of what
    // is wrong if this table is missing.
  }
}

/**
 * One connection, one LIST, no retry.
 *
 * It reports rather than throws for the same reason a write does: the caller's
 * question is "does this work?", and an exception is a worse answer to that
 * than a sentence saying no.
 */
async function probeMailbox(
  env: Env,
  report: StatusReport,
  deps: SyncDeps,
  scrub: Scrub,
): Promise<void> {
  let config: ReturnType<typeof readSyncConfig>;
  try {
    config = readSyncConfig(env);
  } catch {
    report.mailbox = { ok: false, error: "not configured; see config.error" };
    return;
  }

  // The probe is a diagnostic, so its own noise belongs at debug: the answer
  // travels in the response, not the log.
  const log: Logger = deps.log ?? silentLogger();
  try {
    const names = await withMailbox(config, deps, log, async (mailbox) =>
      (await mailbox.listFolders()).map((folder) => folder.name),
    );
    const present = new Set(names);
    const missing = config.folders.filter((name) => !present.has(name)).map(oneLine);
    report.mailbox = { ok: missing.length === 0, folders: names.length, missing };
    if (missing.length > 0) report.ok = false;
  } catch (error) {
    // Scrubbed here as well as at the boundary: src/imap scrubs what it
    // throws, but a failure from underneath it need not have, and this is the
    // one string in the document that came off a connection.
    report.mailbox = { ok: false, error: scrub(describe(error)) };
    report.ok = false;
  }
}

/** A logger that says nothing, for the probe's own plumbing. */
function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * The report as a response.
 *
 * 200 or 503, so a shell can branch on it — `ok` is the same answer in the
 * body for anything that reads JSON. Never cached: every value in here is a
 * claim about right now.
 */
export function statusResponse(env: Env, report: StatusReport): Response {
  const scrub = createScrubber(env);
  return new Response(scrub(`${JSON.stringify(report, null, 2)}\n`), {
    status: report.ok ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Epoch milliseconds as an ISO string.
 *
 * The schema stores integers everywhere and this document does not, on
 * purpose: the reader here is a person deciding whether an hour has passed,
 * and 1787860837024 does not answer that question at a glance.
 */
function asIso(value: number | null): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_NAME_CHARS);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
