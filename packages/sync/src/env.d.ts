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
   * The one folder this worker syncs. Defaults to Archive: on iCloud the mail
   * is in Archive, not INBOX, so a sync pointed at INBOX proves almost nothing.
   */
  readonly SYNC_FOLDER?: string;
  /** How many UIDs from the start of the folder to cover per run. */
  readonly SYNC_BATCH_SIZE?: string;
  /** How many messages to fetch in one FETCH. Bounds peak memory. */
  readonly SYNC_CHUNK_SIZE?: string;
}

// Both interfaces, deliberately. `Env` is what the worker handler is typed
// against; `Cloudflare.Env` is what `cloudflare:test` hands the test suite.
// wrangler generates the two separately, so augmenting one does not reach the
// other.
interface Env extends SyncEnvVars {}

declare namespace Cloudflare {
  interface Env extends SyncEnvVars {}
}
