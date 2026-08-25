/**
 * What travels on the queue, and the uid arithmetic on both sides of it (#6).
 *
 * Work is chunked by uid RANGE, never per message. One queue message per email
 * would mean one TCP + TLS + LOGIN + SELECT per email — tens of thousands of
 * logins for a backfill, which Apple throttles or locks long before it
 * finishes. Ranges of ~100 turn that into a few hundred.
 *
 * Buckets are absolute — bucket n is uids n*size+1 .. (n+1)*size, counted from
 * uid 1 rather than from whatever the folder happens to start at — so the same
 * uid lands in the same bucket on every run. That is what lets enumeration ask
 * D1 which buckets are already complete and enqueue only the rest. Changing
 * SYNC_CHUNK_UIDS moves every boundary and so re-enqueues the folder once; the
 * upsert makes that wasteful rather than wrong.
 */

/** The queue carrying uid ranges from the cron to the consumers. */
export const CHUNK_QUEUE = "imap-mcp-sync-chunks";

/** Where a range goes when it has exhausted its retries. */
export const DEAD_LETTER_QUEUE = "imap-mcp-sync-dlq";

const CHUNK_VERSION = 1;

/**
 * One unit of sync work.
 *
 * `uidValidity` rides along so a consumer can tell that the folder was
 * renumbered between enumeration and delivery — every uid here would mean
 * something else, and writing them would put the wrong body against the right
 * key. `from`/`to` are what make a dead-lettered message self-describing.
 */
export type SyncChunk = {
  v: typeof CHUNK_VERSION;
  /** Full IMAP name, e.g. "Archive" or "Lists/rust-dev". */
  folder: string;
  /** folders.id, so a consumer does not have to look the folder up again. */
  folderId: number;
  uidValidity: number;
  /** Bucket start, inclusive. */
  from: number;
  /** Bucket end, inclusive. */
  to: number;
  /**
   * The uids SEARCH actually reported inside the range — the range is usually
   * sparse. Carried so the consumer fetches only what exists and can bound each
   * FETCH by a number of messages rather than a width of uid space.
   */
  uids: number[];
};

/**
 * The producer surface enumeration uses.
 *
 * Narrower than the Queue binding on purpose: the binding satisfies it
 * structurally, and a test double is then three lines rather than a stub of an
 * API this worker does not call.
 */
export type ChunkProducer = {
  sendBatch(messages: Iterable<MessageSendRequest<SyncChunk>>): Promise<unknown>;
};

/** A queue message that cannot be acted on. Acked, never retried. */
export class MalformedChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedChunkError";
  }
}

/** The bucket a uid belongs to. Absolute, so it is stable across runs. */
export function bucketOf(uid: number, size: number): number {
  return Math.floor((uid - 1) / size);
}

/** The inclusive uid range a bucket covers. */
export function bucketRange(bucket: number, size: number): { from: number; to: number } {
  return { from: bucket * size + 1, to: (bucket + 1) * size };
}

/**
 * Validates a delivered body before anything acts on it.
 *
 * A body that does not parse is a bug or a version skew, and retrying it three
 * times and dead-lettering it teaches nobody anything — so the caller acks it
 * with an error line instead.
 */
export function parseChunk(body: unknown): SyncChunk {
  if (typeof body !== "object" || body === null) {
    throw new MalformedChunkError("body is not an object");
  }

  const chunk = body as Partial<SyncChunk>;
  if (chunk.v !== CHUNK_VERSION) {
    throw new MalformedChunkError(`unsupported version ${String(chunk.v)}`);
  }
  if (typeof chunk.folder !== "string" || chunk.folder.length === 0) {
    throw new MalformedChunkError("folder is missing");
  }
  if (!Number.isInteger(chunk.folderId) || !Number.isInteger(chunk.uidValidity)) {
    throw new MalformedChunkError("folderId or uidValidity is missing");
  }
  if (!Number.isInteger(chunk.from) || !Number.isInteger(chunk.to)) {
    throw new MalformedChunkError("uid range is missing");
  }
  if (!Array.isArray(chunk.uids) || chunk.uids.some((uid) => !Number.isInteger(uid))) {
    throw new MalformedChunkError("uids is not a list of integers");
  }
  return chunk as SyncChunk;
}

/** A chunk as one line, safe to log: names and numbers, never message content. */
export function describeChunk(chunk: SyncChunk): string {
  return `${chunk.folder} uids ${chunk.from}:${chunk.to} (uidvalidity ${chunk.uidValidity}, ${chunk.uids.length} messages)`;
}
