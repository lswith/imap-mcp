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
      miniflare: {
        bindings: {
          // A test-only binding: the setup file applies these to env.DB.
          TEST_MIGRATIONS: migrations,
          // The vars and secret a deployer supplies. They are not in
          // wrangler.jsonc — this repository is public and none of them are
          // committed — so the suite provides its own. Nothing here reaches a
          // real mailbox: every test drives a fake Mailbox, and IMAP_PASSWORD
          // exists so the tests that prove it never reaches a log line have
          // something to look for.
          IMAP_HOST: "imap.example.invalid",
          IMAP_PORT: "993",
          IMAP_USER: "ada",
          IMAP_PASSWORD: "correct-horse-battery-staple",
          SYNC_FOLDER: "Archive",
          SYNC_BATCH_SIZE: "50",
          SYNC_CHUNK_SIZE: "10",
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
      // The ratchet, set where the tracer (#5) landed and a few points below
      // it so an ordinary defensive branch does not fail a build. Raise it as
      // coverage rises. Never lower it to make a red build pass: the number is
      // only worth anything as a floor that has never moved down.
      thresholds: { statements: 95, branches: 85, functions: 95, lines: 95 },
    },
  },
});
