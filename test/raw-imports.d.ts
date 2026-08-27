/**
 * `import x from "./file?raw"` — Vite's raw-text import.
 *
 * test/repo/manifest.test.ts asserts on the files Cloudflare itself reads,
 * `.dev.vars.example` and `wrangler.jsonc`, rather than on a re-encoding of
 * them. Vite implements the suffix; this only tells TypeScript what comes
 * back, since `vite/client` is not among the types this project pulls in.
 *
 * Its own file, and deliberately without imports: a wildcard `declare module`
 * has to be ambient, and test/env.d.ts is a module (it imports D1Migration),
 * where the same lines would be read as augmenting a module that does not
 * exist.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
