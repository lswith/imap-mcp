/**
 * The Access configuration a deployer supplies, declared rather than committed.
 *
 * This repository is public, so `wrangler.jsonc` carries no `vars` block: the
 * audience tag identifies one application on one Zero Trust tenant. It is
 * documented in ../../.env.example and ../../docs/access.md and added at deploy
 * time. `wrangler types` can only generate Env entries for bindings the
 * committed config declares, so the shape is declared here instead — the same
 * trick packages/sync/src/env.d.ts and test/env.d.ts use.
 *
 * It is optional in the type because the worker genuinely cannot know what was
 * configured. readAccessConfig (src/access.ts) is what turns "absent" into a
 * refusal rather than an unauthenticated pass.
 */

interface AccessEnvVars {
  /**
   * The Access application's Audience (AUD) tag — a hex string, shown on the
   * application's Overview tab.
   *
   * This is the value that makes the check application-scoped rather than
   * tenant-scoped. Without it, being authenticated for any application on the
   * same Zero Trust tenant would be enough to read the mailbox.
   */
  readonly ACCESS_AUD?: string;
}

// Both interfaces, deliberately. `Env` is what the worker handler is typed
// against; `Cloudflare.Env` is what `cloudflare:test` hands the test suite.
// wrangler generates the two separately, so augmenting one does not reach the
// other.
interface Env extends AccessEnvVars {}

declare namespace Cloudflare {
  interface Env extends AccessEnvVars {}
}
