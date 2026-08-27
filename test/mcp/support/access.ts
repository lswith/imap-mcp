/**
 * An execution context as Cloudflare Access would hand one over.
 *
 * Fabricated rather than produced by the runtime, and that is forced rather
 * than chosen: `SELF` from `cloudflare:test` is a service binding, and Access
 * deliberately does not propagate `ctx.access` across one, so no request made
 * through `SELF.fetch` can ever arrive authenticated. The tests therefore drive
 * `handleRequest` directly (see src/index.ts) with the context shape the
 * runtime documents.
 *
 * What that buys and what it costs is worth being honest about: every branch of
 * the gate is exercised, but the step where Cloudflare decides to populate
 * `ctx.access` at all is Cloudflare's, and only a deploy can prove it. The
 * post-deploy checks in docs/access.md are that proof.
 */

/** Matches the ACCESS_AUD in vitest.config.ts. */
export const AUD = "0d3ad0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";

/** Matches the MCP_API_KEY in vitest.config.ts. A fictional value, like AUD. */
export const API_KEY = "test-api-key-9Yl3u4vZs1QeXKp7RbT2wA==";

/** A context for a request Access authenticated for this application. */
export function authenticated(overrides: { aud?: string; email?: string } = {}) {
  return {
    access: {
      aud: overrides.aud ?? AUD,
      getIdentity: async () => ({ email: overrides.email ?? "luke@example.com" }),
    } as unknown as CloudflareAccessContext,
  };
}

/** A context for a request that never went through Access. */
export function unauthenticated() {
  return { access: undefined };
}
