import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

// The schema lives at the repo root and is shared by both workers. Reading it
// here rather than hand-writing a fixture means these tests run against the
// exact SQL `wrangler d1 migrations apply` would run.
const migrations = await readD1Migrations(new URL("../../migrations", import.meta.url).pathname);

// A throwaway Zero Trust tenant for the suite, minted fresh on every run.
//
// The keys are generated here, in Node, rather than inside a test, because two
// places need them and only one of them is the worker: the tests sign
// assertions with the private half, and `outboundService` below answers the
// worker's JWKS fetch with the public half. Generating per run is also why no
// private key is committed to a public repository — there is no fixture to
// leak, and a suite that passes proves a real RS256 signature was verified.
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const TEST_ACCESS_JWKS = JSON.stringify({
  keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" }],
});
const TEST_ACCESS_KEY = JSON.stringify(await exportJWK(privateKey));

// Matches test/support/access.ts. A domain that cannot resolve, deliberately:
// if `outboundService` ever stops intercepting, the tests fail rather than
// quietly reaching the internet.
const TEST_TEAM_DOMAIN = "https://imap-mcp-test.cloudflareaccess.com";
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
          TEST_ACCESS_JWKS,
          TEST_ACCESS_KEY,
          // The Access `vars` a deployer adds. wrangler.jsonc commits none —
          // this repository is public — so the suite supplies them the same way
          // a deploy does. src/env.d.ts is where their shape is declared.
          ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
          ACCESS_AUD: TEST_AUD,
        },
        // Everything the worker fetches. Only the tenant's JWKS is answered;
        // anything else is a 404, so a test cannot accidentally depend on the
        // network being there.
        outboundService: (request) =>
          new URL(request.url).href === `${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`
            ? new Response(TEST_ACCESS_JWKS, { headers: { "content-type": "application/json" } })
            : new Response("not found", { status: 404 }),
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
