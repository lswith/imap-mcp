/**
 * Reading the sync worker's configuration off the environment.
 *
 * Nothing here ever puts a configured value into an error message. A message
 * naming the variable is enough to fix the problem, and IMAP_PASSWORD is one
 * of the variables this code path validates.
 */

const DEFAULT_PORT = 993;
const DEFAULT_FOLDERS = ["Archive"];
/** Uids per queue message. ~100 is what turns a backfill's tens of thousands
 *  of LOGINs into a few hundred (#6). */
const DEFAULT_CHUNK_UIDS = 100;
const DEFAULT_CHUNK_SIZE = 10;
const DEFAULT_ENUMERATE_WINDOW = 5_000;
const DEFAULT_MAX_CHUNKS_PER_RUN = 50;
/**
 * Byte budget for one FETCH, and the ceiling on a single message (#9).
 *
 * cf-imap materialises an attachment twice — decoded and base64 — on top of the
 * full raw message held as a UTF-16 string, so the resident cost of a fetch is
 * several times what crossed the wire. 8 MiB against a ~128 MB isolate leaves
 * room for that multiple with the rest of the slice alongside it.
 */
const DEFAULT_MAX_FETCH_BYTES = 8 * 1024 * 1024;
/** 64 MiB. Past this the multiple above stops fitting whatever else is true. */
const MAX_FETCH_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * The worker is misconfigured. Not retryable, and treated like an auth failure
 * at both entry points: re-running on the next cron tick cannot fix a missing
 * secret, it can only turn one mistake into a repeating one.
 */
export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConfigError";
  }
}

export type SyncConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** The folders this worker indexes, in the order they are enumerated. */
  folders: string[];
  /** Uids per queue message. Also the bucket size gap detection counts in. */
  chunkUids: number;
  /** Messages per FETCH. Bounds peak memory in a consumer. */
  chunkSize: number;
  /** Uids per enumeration SEARCH. Bounds the response and the run's wall clock. */
  enumerateWindow: number;
  /** How many ranges one cron tick may queue, across all folders. */
  maxChunksPerRun: number;
  /**
   * Byte budget for one FETCH, and the ceiling on a single message. A message
   * larger than this is recorded from its headers and never body-fetched.
   */
  maxFetchBytes: number;
  /** Only index mail received on or after this date, if set. */
  since?: Date;
};

export function readSyncConfig(env: Env): SyncConfig {
  const config: SyncConfig = {
    host: required(env.IMAP_HOST, "IMAP_HOST"),
    port: positiveInt(env.IMAP_PORT, "IMAP_PORT", DEFAULT_PORT, 65_535),
    username: required(env.IMAP_USER, "IMAP_USER"),
    password: required(env.IMAP_PASSWORD, "IMAP_PASSWORD"),
    folders: folderList(env.SYNC_FOLDERS),
    chunkUids: positiveInt(env.SYNC_CHUNK_UIDS, "SYNC_CHUNK_UIDS", DEFAULT_CHUNK_UIDS),
    chunkSize: positiveInt(env.SYNC_CHUNK_SIZE, "SYNC_CHUNK_SIZE", DEFAULT_CHUNK_SIZE),
    enumerateWindow: positiveInt(
      env.SYNC_ENUMERATE_WINDOW,
      "SYNC_ENUMERATE_WINDOW",
      DEFAULT_ENUMERATE_WINDOW,
    ),
    maxChunksPerRun: positiveInt(
      env.SYNC_MAX_CHUNKS_PER_RUN,
      "SYNC_MAX_CHUNKS_PER_RUN",
      DEFAULT_MAX_CHUNKS_PER_RUN,
    ),
    maxFetchBytes: positiveInt(
      env.SYNC_MAX_FETCH_BYTES,
      "SYNC_MAX_FETCH_BYTES",
      DEFAULT_MAX_FETCH_BYTES,
      MAX_FETCH_BYTES_CEILING,
    ),
  };

  const since = isoDate(env.SYNC_SINCE, "SYNC_SINCE");
  if (since) config.since = since;
  return config;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new SyncConfigError(`${name} is not set`);
  return trimmed;
}

/**
 * Comma-separated, because a folder name may contain almost anything else —
 * including the hierarchy delimiter, as in "Lists/rust-dev".
 */
function folderList(value: string | undefined): string[] {
  if (value === undefined) return [...DEFAULT_FOLDERS];

  const folders = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];
  // An empty string means the deployer set the variable and got it wrong,
  // which is worth a named failure rather than a silent fallback to Archive.
  if (folders.length === 0) throw new SyncConfigError("SYNC_FOLDERS is not set");
  return folders;
}

function positiveInt(value: string | undefined, name: string, fallback: number, max = 100_000) {
  const raw = value?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  // The value is deliberately not echoed: this function also parses nothing
  // secret today, but the rule is easier to keep than to remember to apply.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new SyncConfigError(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function isoDate(value: string | undefined, name: string): Date | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new SyncConfigError(`${name} must be an ISO date`);
  return parsed;
}
