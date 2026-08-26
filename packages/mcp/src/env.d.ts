/**
 * The Access configuration a deployer supplies, declared rather than committed.
 *
 * This repository is public, so `wrangler.jsonc` carries no `vars` block: the
 * team domain and the audience tag identify one Zero Trust tenant and one
 * application. They are documented in ../../.env.example and ../../docs/access.md
 * and added at deploy time. `wrangler types` can only generate Env entries for
 * bindings the committed config declares, so the shape is declared here instead
 * — the same trick packages/sync/src/env.d.ts and test/env.d.ts use.
 *
 * Both are optional in the type because the worker genuinely cannot know what
 * was configured. readAccessConfig (src/access.ts) is what turns "absent" into
 * a refusal rather than an unauthenticated pass.
 */

interface AccessEnvVars {
  /**
   * Zero Trust team domain, as an origin: https://<team>.cloudflareaccess.com.
   * It is both the JWKS host and the `iss` every Access token carries, which
   * is why one value serves for both and they cannot drift apart.
   */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /**
   * The Access application's Audience (AUD) tag — a hex string, shown on the
   * application's Overview tab.
   *
   * This is the value that makes the check application-scoped rather than
   * tenant-scoped. Without it any token the same Zero Trust tenant ever issued,
   * for any application, verifies here.
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
