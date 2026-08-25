/**
 * Reading the sync worker's configuration off the environment.
 *
 * Nothing here ever puts a configured value into an error message. A message
 * naming the variable is enough to fix the problem, and IMAP_PASSWORD is one
 * of the variables this code path validates.
 */

const DEFAULT_PORT = 993;
const DEFAULT_FOLDER = "Archive";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CHUNK_SIZE = 10;

/**
 * The worker is misconfigured. Not retryable, and treated like an auth failure
 * at the entry point: re-running on the next cron tick cannot fix a missing
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
  /** The single folder this run syncs. */
  folder: string;
  /** UIDs 1..batchSize are the window this run covers. */
  batchSize: number;
  /** Messages per FETCH. */
  chunkSize: number;
};

export function readSyncConfig(env: Env): SyncConfig {
  return {
    host: required(env.IMAP_HOST, "IMAP_HOST"),
    port: positiveInt(env.IMAP_PORT, "IMAP_PORT", DEFAULT_PORT, 65_535),
    username: required(env.IMAP_USER, "IMAP_USER"),
    password: required(env.IMAP_PASSWORD, "IMAP_PASSWORD"),
    folder: env.SYNC_FOLDER?.trim() || DEFAULT_FOLDER,
    batchSize: positiveInt(env.SYNC_BATCH_SIZE, "SYNC_BATCH_SIZE", DEFAULT_BATCH_SIZE),
    chunkSize: positiveInt(env.SYNC_CHUNK_SIZE, "SYNC_CHUNK_SIZE", DEFAULT_CHUNK_SIZE),
  };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new SyncConfigError(`${name} is not set`);
  return trimmed;
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
