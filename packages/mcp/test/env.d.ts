import type { D1Migration } from "cloudflare:test";

// vitest.config.ts hands these to the test worker as bindings: the migrations
// so test/apply-migrations.ts can apply them against the real D1 binding, and
// the throwaway Zero Trust tenant's keys so test/support/access.ts can sign
// assertions the worker will actually verify. They exist only under test, which
// is why they are declared here rather than being generated into Env by
// `wrangler types`.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** The tenant's public JWKS, as JSON. Also what `outboundService` serves. */
      TEST_ACCESS_JWKS: string;
      /** The matching private key, as a JWK. Generated per run, never committed. */
      TEST_ACCESS_KEY: string;
    }
  }
}
