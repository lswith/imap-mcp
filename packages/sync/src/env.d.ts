/**
 * The configuration a deployer supplies, declared rather than committed.
 *
 * This repository is public, so `wrangler.jsonc` carries no `vars` block: the
 * mailbox host, port, user and folder identify one person's account, and the
 * password is a secret. They are documented in ../../.env.example and added at
 * deploy time. `wrangler types` can only generate Env entries for bindings the
 * committed config declares, so the shape is declared here instead — the same
 * trick test/env.d.ts uses for TEST_MIGRATIONS.
 *
 * Every value is optional in the type because the worker genuinely cannot know
 * what was configured. readSyncConfig (src/config.ts) is what turns "absent"
 * into a loud, named failure rather than a connection attempt with `undefined`
 * in it.
 */

interface SyncEnvVars {
  /** IMAP hostname, e.g. imap.mail.me.com. */
  readonly IMAP_HOST?: string;
  /** IMAP port. Defaults to 993 (implicit TLS). */
  readonly IMAP_PORT?: string;
  /** Mailbox user. For iCloud, LOGIN wants the local part only. */
  readonly IMAP_USER?: string;
  /**
   * App-specific password, set with `wrangler secret put` — never a `vars`
   * entry. It grants full mailbox access including SMTP send.
   */
  readonly IMAP_PASSWORD?: string;
  /**
   * The folders this worker indexes, comma-separated. Defaults to Archive: on
   * iCloud the mail is in Archive, not INBOX, so a sync pointed at INBOX proves
   * almost nothing. Comma-separated because a folder name can contain almost
   * anything else, the hierarchy delimiter included ("Lists/rust-dev").
   */
  readonly SYNC_FOLDERS?: string;
  /**
   * Uids per queue message, and the bucket size gap detection counts in (#6).
   * Defaults to 100. Chunking by range rather than per message is what keeps a
   * backfill to a few hundred logins instead of tens of thousands.
   */
  readonly SYNC_CHUNK_UIDS?: string;
  /** How many messages to fetch in one FETCH. Bounds peak memory. */
  readonly SYNC_CHUNK_SIZE?: string;
  /** Uids per enumeration SEARCH. Bounds the response and the run's wall clock. */
  readonly SYNC_ENUMERATE_WINDOW?: string;
  /**
   * How many ranges one cron tick may queue, across all folders. This is the
   * throttle on a backfill: at the defaults, ~5000 messages an hour.
   */
  readonly SYNC_MAX_CHUNKS_PER_RUN?: string;
  /**
   * Byte budget for one FETCH, and the ceiling on a single message. Defaults
   * to 8 MiB.
   *
   * Both at once, deliberately: the worst case either way is one message of
   * this size in flight, so a second knob would only let the two disagree. A
   * message larger than this is never body-fetched at all -- its row is
   * written from the header-only pass with `oversize` set.
   */
  readonly SYNC_MAX_FETCH_BYTES?: string;
  /** ISO date. When set, only mail received on or after it is indexed. */
  readonly SYNC_SINCE?: string;
  /**
   * The address create_draft writes a draft From (#12). Defaults to IMAP_USER
   * when that is a full address, and is otherwise omitted — iCloud's LOGIN
   * takes the local part only, so the credential is often not an address, and a
   * draft with no From header is legal.
   */
  readonly DRAFT_FROM?: string;
  /**
   * Where create_draft appends. Only needed when the mailbox advertises no
   * `\Drafts` special-use AND has no folder called Drafts.
   */
  readonly DRAFTS_FOLDER?: string;
}

// Both interfaces, deliberately. `Env` is what the worker handler is typed
// against; `Cloudflare.Env` is what `cloudflare:test` hands the test suite.
// wrangler generates the two separately, so augmenting one does not reach the
// other.
interface Env extends SyncEnvVars {}

declare namespace Cloudflare {
  interface Env extends SyncEnvVars {}
}
