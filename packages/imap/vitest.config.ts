import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects, because they answer two different questions.
//
// `workerd` is the repo convention: this code ships inside a Worker, so the
// package must at least import and run there — including cf-imap's
// `cloudflare:sockets` import, which only resolves in that runtime.
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
            // No wrangler.jsonc: this package is a library, not a deployable
            // worker. The compatibility date matches both workers — it is
            // capped by the workerd that @cloudflare/vitest-pool-workers
            // bundles, so move it forward only together with that dependency.
            miniflare: {
              compatibilityDate: "2026-08-15",
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ],
        test: {
          name: "workerd",
          include: ["test/unit/**/*.test.ts"],
          retry: 2,
        },
      },
      {
        resolve: {
          alias: {
            "cloudflare:sockets": new URL("./test/support/fake-sockets.ts", import.meta.url)
              .pathname,
          },
        },
        test: {
          name: "protocol",
          environment: "node",
          include: ["test/protocol/**/*.test.ts"],
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
    },
  },
});
