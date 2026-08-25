import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test file, after this file's storage has been reset — the same
// migrations `wrangler d1 migrations apply` runs, split by the same wrangler
// splitter, so a migration that would fail against a real database fails here.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
