import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the real Worker runtime) against this package's
// own wrangler.jsonc, so the compatibility flags and bindings
// under test are the same ones that get deployed.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
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
      // when search_messages lands (#7) and raise it from there,
      // never lower it to make a red build pass.
    },
  },
});
