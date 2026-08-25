import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The schema lives at the repo root and is shared by both workers. Reading it
// here rather than hand-writing a fixture means these tests run against the
// exact SQL `wrangler d1 migrations apply` would run.
const migrations = await readD1Migrations(new URL("../../migrations", import.meta.url).pathname);

// Tests run inside workerd (the real Worker runtime) against this package's
// own wrangler.jsonc, so the cron trigger, compatibility flags and bindings
// under test are the same ones that get deployed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A test-only binding: the setup file applies these to env.DB.
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // A single CI flake gets retried instead of failing the build, while a
    // genuinely broken test still fails every attempt.
    retry: 2,
    coverage: {
      // workerd has no node:inspector, so the v8 provider can't instrument it
      // — istanbul instruments at transform time instead.
      // See cloudflare/workers-sdk#5266.
      provider: "istanbul",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      // No thresholds yet: the only code here is a placeholder handler, so any
      // number would be either trivially 100% or arbitrary. Set a real ratchet
      // when the tracer lands (#5) and raise it from there,
      // never lower it to make a red build pass.
    },
  },
});
