import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read here rather than hand-written as a fixture, so the workerd tests run
// against the exact SQL `wrangler d1 migrations apply` would run.
const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

// The Access application's audience tag, as a deploy would supply it. Matches
// test/mcp/support/access.ts. A fictional value: nothing account-specific is
// committed, and this repository is public.
const TEST_AUD = "0d3ad0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";

// Two projects, because they answer two different questions.
//
// `workerd` runs inside the real Worker runtime against the repo's own
// wrangler.jsonc, so the cron trigger, compatibility flags and bindings under
// test are the same ones that get deployed. Everything that touches D1 lives
// here, alongside the imap module's can-it-even-import-in-workerd unit tests.
//
// `protocol` runs the real cf-imap client against a scripted in-memory server
// by aliasing `cloudflare:sockets` to a stub. That substitution is impossible
// inside workerd, where the module is a runtime built-in rather than something
// the bundler resolves — hence Node. What it covers is pure parsing over
// web-standard APIs (TextEncoder/TextDecoder, ReadableStream, atob), which
// behave the same in both runtimes.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                // A test-only binding: the setup file applies these to env.DB.
                TEST_MIGRATIONS: migrations,
                // The vars and secret a deployer supplies. They are not in
                // wrangler.jsonc — this repository is public and none of them
                // are committed — so the suite provides its own. Nothing here
                // reaches a real mailbox: every test drives a fake Mailbox, and
                // IMAP_PASSWORD exists so the tests that prove it never reaches
                // a log line have something to look for.
                IMAP_HOST: "imap.example.invalid",
                IMAP_PORT: "993",
                IMAP_USER: "ada",
                IMAP_PASSWORD: "correct-horse-battery-staple",
                SYNC_FOLDERS: "Archive",
                // Ten-uid buckets and a hundred-uid window: small enough that a
                // test can name the ranges it expects, and the arithmetic is
                // the same at the production defaults of 100 and 5000.
                SYNC_CHUNK_UIDS: "10",
                SYNC_CHUNK_SIZE: "10",
                SYNC_ENUMERATE_WINDOW: "100",
                SYNC_MAX_CHUNKS_PER_RUN: "50",
                // The Access `var` a deployer adds; src/env.d.ts declares its
                // shape. With it set, the workerd suite runs in Access mode by
                // default; API-key-mode tests spread it away per test.
                ACCESS_AUD: TEST_AUD,
                // The required secret a deploy prompts for (#35). Matches
                // test/mcp/support/access.ts.
                MCP_API_KEY: "test-api-key-9Yl3u4vZs1QeXKp7RbT2wA==",
              },
            },
          }),
        ],
        test: {
          name: "workerd",
          include: [
            "test/sync/**/*.test.ts",
            "test/mcp/**/*.test.ts",
            "test/imap/unit/**/*.test.ts",
            "test/repo/**/*.test.ts",
          ],
          setupFiles: ["./test/apply-migrations.ts"],
          // A single CI flake gets retried instead of failing the build, while
          // a genuinely broken test still fails every attempt.
          retry: 2,
        },
      },
      {
        resolve: {
          alias: {
            "cloudflare:sockets": new URL("./test/imap/support/fake-sockets.ts", import.meta.url)
              .pathname,
          },
        },
        test: {
          name: "protocol",
          environment: "node",
          include: ["test/imap/protocol/**/*.test.ts"],
          retry: 2,
          server: {
            deps: {
              // cf-imap's published ESM uses extensionless relative imports
              // ("./utils/imapStream"), which Node's ESM resolver rejects.
              // Bundlers add the extension, so it loads fine in workerd and in
              // `wrangler deploy`; here Vite has to process it rather than
              // hand it to Node. Reported upstream.
              inline: ["cf-imap"],
            },
          },
        },
      },
    ],
    coverage: {
      // workerd has no node:inspector, so the v8 provider can't instrument it
      // — istanbul instruments at transform time instead.
      // See cloudflare/workers-sdk#5266.
      provider: "istanbul",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.ts"],
      // The ratchet. The workers merge (#34) changed the denominator — one
      // suite now measures all of src/, including the imap module, which
      // previously carried no floor — so these are set a point or two below
      // what the merged suite measures. Raise them as coverage rises. Never
      // lower them to make a red build pass: the number is only worth anything
      // as a floor that has never moved down.
      thresholds: { statements: 96, branches: 89, functions: 97, lines: 98 },
    },
  },
});
