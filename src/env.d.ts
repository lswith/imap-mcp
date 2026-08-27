/**
 * The configuration a deployer supplies, declared rather than committed.
 *
 * The split between this file and the `vars` block in wrangler.jsonc is one
 * rule: a value that identifies nobody is committed there, a value that
 * identifies someone is only declared here. So the sizing knobs and LOG_LEVEL
 * ship with committed defaults, while IMAP_HOST, IMAP_USER, SYNC_SINCE, the
 * draft settings and the Access audience — one person's mailbox, one Zero
 * Trust application — are added by the deployer in their own fork or in the
 * dashboard, and this public repository never learns them. .env.example
 * documents the values; `wrangler types` can only generate Env entries for
 * what the committed config declares, so the rest of the shape is declared
 * here — the same trick test/env.d.ts uses for TEST_MIGRATIONS.
 *
 * The committed ones are declared here too, deliberately duplicating what
 * `wrangler types` generates from the config: generation types them as the
 * literal value in the file ("100"), which is true of a default deploy and
 * false of any instance that changed one. The optional `string` below is the
 * honest type, and it keeps the readers written for the case that actually
 * needs handling.
 *
 * The two secrets (IMAP_PASSWORD, MCP_API_KEY) are NOT declared here:
 * `secrets.required` in wrangler.jsonc declares them, a deploy fails until
 * they are set, and `wrangler types` generates both as non-optional — so the
 * code cannot branch on their absence.
 *
 * Every value is optional in the type because the worker genuinely cannot know
 * what was configured. readSyncConfig (src/sync/config.ts) turns an absent var
 * into a loud, named failure rather than a connection attempt with `undefined`
 * in it; readAuthConfig (src/mcp/auth.ts) turns an absent audience into
 * API-key mode rather than an unauthenticated pass; readLogLevel (src/log.ts)
 * turns an unusable one into `info` and a warning, because logging is how the
 * other two report themselves.
 */

interface DeployerEnvVars {
  /** IMAP hostname, e.g. imap.mail.me.com. */
  readonly IMAP_HOST?: string;
  /** IMAP port. Defaults to 993 (implicit TLS). */
  readonly IMAP_PORT?: string;
  /** Mailbox user. For iCloud, LOGIN wants the local part only. */
  readonly IMAP_USER?: string;
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
   * How much this Worker says about what it is doing: `debug`, `info`
   * (the default), `warn`, `error` or `silent`.
   *
   * Unlike every other var here it has a committed default in the
   * `vars` block of wrangler.jsonc, because it identifies nobody -- and
   * because being able to raise it in the dashboard, against an instance that
   * is already misbehaving, is the whole point of it being configuration.
   * An unrecognised value falls back to `info` and warns; see src/log.ts.
   */
  readonly LOG_LEVEL?: string;
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
  /**
   * The Access application's Audience (AUD) tag — a hex string, shown on the
   * application's Overview tab.
   *
   * This is the optional upgrade (#35): absent, the API key is the
   * credential; set, Access is required and the key is refused. It is also
   * what makes the gate application-scoped rather than tenant-scoped —
   * without the comparison, being authenticated for any application on the
   * same Zero Trust tenant would be enough to read the mailbox.
   *
   * Set it only after the Access application is created and verified; delete
   * it to recover from a lockout (the instance falls back to the key).
   */
  readonly ACCESS_AUD?: string;
}

// Both interfaces, deliberately. `Env` is what the worker handler is typed
// against; `Cloudflare.Env` is what `cloudflare:test` hands the test suite.
// wrangler generates the two separately, so augmenting one does not reach the
// other.
interface Env extends DeployerEnvVars {}

declare namespace Cloudflare {
  interface Env extends DeployerEnvVars {}
}
