import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The schema lives at the repo root and is shared by both workers. Reading it
// here rather than hand-writing a fixture means these tests run against the
// exact SQL `wrangler d1 migrations apply` would run.
const migrations = await readD1Migrations(new URL("../../migrations", import.meta.url).pathname);

// The Access application's audience tag, as a deploy would supply it. Matches
// test/support/access.ts. A fictional value: nothing account-specific is
// committed, and this repository is public.
const TEST_AUD = "0d3ad0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";

// Tests run inside workerd (the real Worker runtime) against this package's
// own wrangler.jsonc, so the compatibility flags and bindings
// under test are the same ones that get deployed.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only: the setup file applies these to env.DB.
          TEST_MIGRATIONS: migrations,
          // The Access `var` a deployer adds. wrangler.jsonc commits none —
          // this repository is public — so the suite supplies it the same way a
          // deploy does. src/env.d.ts is where its shape is declared.
          ACCESS_AUD: TEST_AUD,
        },
      },
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
