import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The schema lives at the repo root and is shared by both workers. Reading it
// here rather than hand-writing a fixture means these tests run against the
// exact SQL `wrangler d1 migrations apply` would run.
const migrations = await readD1Migrations(new URL("../../migrations", import.meta.url).pathname);

// Tests run inside workerd (the real Worker runtime) against this package's
// own wrangler.jsonc, so the compatibility flags and bindings
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
      // The ratchet, set where search_messages landed (#7). The suite measures
      // 100% on every counter; these sit a few points under so an ordinary
      // defensive branch does not fail a build on the day it is written.
      // Raise them as coverage rises, and never lower them to make a red build
      // pass — the number is only worth anything as a floor that has never
      // moved down.
      thresholds: { statements: 98, branches: 95, functions: 95, lines: 98 },
    },
  },
});
