import type { D1Migration } from "cloudflare:test";

// vitest.config.ts hands the migrations to the test worker as a binding so
// test/apply-migrations.ts can apply them against the real D1 binding. It
// exists only under test, which is why it is declared here rather than being
// generated into Env by `wrangler types`.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
