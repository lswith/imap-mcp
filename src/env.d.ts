/**
 * The configuration a deployer supplies that `wrangler types` cannot generate.
 *
 * Cloudflare's guidance is not to hand-write an Env interface at all, because
 * one drifts from the bindings it describes. This file is the exception that
 * proves it: `wrangler types` can only generate entries for what the committed
 * config declares, and the values that identify one person's mailbox or one
 * Zero Trust application are deliberately NOT committed — this repository is
 * public. So exactly those are declared here, and nothing else is.
 *
 * What that leaves to generation, and why it is now clean:
 *
 *   - The `vars` block (the sizing knobs, LOG_LEVEL, IMAP_PORT) is generated
 *     as `string` rather than as the literal value in the file, because
 *     `pnpm run types` passes --strict-vars=false. Literal types would assert
 *     that every instance runs the committed default, which is false of any
 *     deployer who edited the dashboard, changed their fork, or answered the
 *     deploy prompt. Declaring them here too used to be the fix, and it was
 *     the wrong one: two declarations of one name is a real TS2320 that only
 *     `skipLibCheck` was hiding.
 *   - The secrets (IMAP_HOST, IMAP_USER, IMAP_PASSWORD, MCP_API_KEY) come from
 *     `secrets.required` and .dev.vars.example. Only the last two are in
 *     `secrets.required`, so only those two are generated; the mailbox pair is
 *     declared below, since an instance may still supply them as vars.
 *
 * Every value here is optional because the worker genuinely cannot know what
 * was configured. readSyncConfig (src/sync/config.ts) turns an absent one into
 * a loud, named failure rather than a connection attempt with `undefined` in
 * it; readAuthConfig (src/mcp/auth.ts) turns an absent audience into API-key
 * mode rather than an unauthenticated pass; readLogLevel (src/log.ts) turns an
 * unusable level into `info` and a warning, because logging is how the other
 * two report themselves.
 */

interface DeployerEnvVars {
  /**
   * IMAP hostname, e.g. imap.mail.me.com.
   *
   * Prompted for at deploy time and stored as a secret (.dev.vars.example),
   * but not in `secrets.required` — an instance may supply it as a var
   * instead, which is why this is declared rather than generated, and why it
   * is optional rather than assumed.
   */
  readonly IMAP_HOST?: string;
  /** Mailbox user. For iCloud, LOGIN wants the local part only. */
  readonly IMAP_USER?: string;
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
   * Deliberately not a deploy prompt: setting it before the Access
   * application exists and works is the documented lockout. Set it after, and
   * delete it to recover.
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
