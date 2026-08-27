/**
 * Authentication: a mandatory API key, upgraded to Cloudflare Access (#35).
 *
 * With no folder fence, this endpoint is functionally read access to fifteen
 * years of mail, so authentication is the load-bearing control in the whole
 * design rather than hygiene on top of it — and since #34 made the Worker
 * reachable at its workers.dev hostname by default, it is the only layer
 * between the mailbox index and the internet.
 *
 * Two modes, selected by whether ACCESS_AUD is configured, and it is
 * **precedence, not fallback**: with the audience set, Access is required and
 * a valid API key is refused, so a key leaked before the upgrade is not a
 * permanent bypass of the stronger control. The two are never both accepted.
 *
 *   - **API-key mode** (no audience): the caller presents the MCP_API_KEY
 *     secret as a bearer token. The key is a *required* secret — a deploy
 *     fails, naming it, until it is set (`secrets.required` in wrangler.jsonc)
 *     — which is what lets a one-click deploy end with a working,
 *     authenticated endpoint instead of a Zero Trust prerequisite. The 401 in
 *     this mode carries a bare bearer challenge with no OAuth pointer, because
 *     there is no authorization server to point at.
 *
 *   - **Access mode** (audience set): Access Managed OAuth. The token Access
 *     issues to the *client* is opaque (`oauth:CvNoo...`), not a JWT, and
 *     cannot be verified by anyone but Access; Access exchanges it at the edge
 *     and hands the result to the worker as `ctx.access`. This reads
 *     `ctx.access` and never the `Cf-Access-Jwt-Assertion` header, which is
 *     the stronger of the two rather than merely the newer: a header is
 *     request data, trustworthy only while nothing can reach this worker
 *     without traversing Access, while `ctx.access` is set by the runtime and
 *     cannot be spoofed by a caller at all. `aud` still has to match — Access
 *     authenticating *someone* is not the same as Access authenticating them
 *     for *this* application, and one Zero Trust account can hold many.
 *
 * The unconfigured case is not handled here, because it is not reachable
 * through a supported path: `wrangler deploy` refuses to deploy without the
 * key, and `wrangler types` generates it as non-optional so the code cannot
 * branch on its absence. (A secret deleted through the dashboard leaves
 * `env.MCP_API_KEY` undefined at runtime; the digest of its string form
 * matches no presentable token, so the gate still refuses — closed by
 * accident rather than by design, which the authentication docs say plainly.)
 *
 * Upgrading and recovering, for the documentation: create the Access
 * application with the Worker as its destination, verify it works, *then* set
 * ACCESS_AUD — during that window the Access context is present but unchecked,
 * so the key still carries the caller and there is no gap. Locked out by an
 * audience set before the application worked? Delete ACCESS_AUD, which falls
 * straight back to key authentication.
 */

import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";

/**
 * Which credential this deploy requires.
 *
 * A mode rather than an outcome: there is no failure arm, because an absent
 * audience now *selects* API-key mode instead of failing the request, and the
 * key's presence is guaranteed at deploy time rather than checked here.
 */
export type AuthMode =
  | { readonly mode: "access"; readonly aud: string }
  | { readonly mode: "api-key" };

export function readAuthConfig(env: Env): AuthMode {
  const aud = env.ACCESS_AUD?.trim();
  if (!aud) return { mode: "api-key" };
  return { mode: "access", aud };
}

/**
 * The caller as authentication describes them, or the response to send instead.
 *
 * `access` is present exactly when Access authenticated the caller: the write
 * tools ask it for an actor to audit. In API-key mode it is absent and the
 * audit rows record a null actor — truthful, since a shared key identifies
 * nobody.
 */
export type AuthOutcome =
  | { readonly ok: true; readonly access?: CloudflareAccessContext }
  | { readonly ok: false; readonly response: Response };

export async function verifyAuth(
  request: Request,
  env: Env,
  access: CloudflareAccessContext | undefined,
): Promise<AuthOutcome> {
  const config = readAuthConfig(env);

  if (config.mode === "api-key") {
    if (await presentsApiKey(request, env)) return { ok: true };
    // A bare bearer challenge, deliberately without a resource_metadata
    // pointer: advertising an OAuth flow that does not exist in this mode
    // would send a client into a discovery that cannot succeed.
    return {
      ok: false,
      response: bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or missing API key"),
      ),
    };
  }

  // Access mode. RFC 9728: the 401 has to tell a client where to go to
  // discover the authorization server. Built from the request's own URL, which
  // is the hostname the Access application is bound to. With Access in front
  // it is Access that answers the path this points at; the worker serves its
  // own copy too (see src/mcp/handler.ts), so the pointer leads somewhere
  // either way.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(request.url));

  // Access did not run. Either nothing is in front of this worker, or the
  // request reached it by a path that bypassed Access — most likely an
  // audience set before the application covered the Worker. A valid API key
  // does not help here: precedence, not fallback, or a leaked key would be a
  // permanent bypass of the stronger control.
  if (!access) {
    return {
      ok: false,
      response: challenge(
        "Cloudflare Access did not authenticate this request",
        resourceMetadataUrl,
      ),
    };
  }

  // Access ran, but for something else. Every application in one Zero Trust
  // account shares a tenant, so "Access authenticated them" is not the same
  // claim as "Access authenticated them for this application" — and the second
  // is the one that matters when the other application's policy might be far
  // more generous than this one's.
  if (access.aud !== config.aud) {
    return {
      ok: false,
      response: challenge("Not authenticated for this application", resourceMetadataUrl),
    };
  }

  return { ok: true, access };
}

/**
 * Whether the request carries the API key as a bearer token — and only as a
 * bearer token. No cookie, no query parameter, no custom header: one shape
 * means one thing to strip from logs and one thing rotation invalidates.
 *
 * Compared in constant time, over SHA-256 digests rather than the strings
 * themselves: `timingSafeEqual` requires equal lengths and throws otherwise,
 * so digesting first turns "how long is the secret" into something a timing
 * side channel cannot ask either.
 */
async function presentsApiKey(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (!header) return false;
  const [scheme, ...rest] = header.split(" ");
  const token = rest.join(" ").trim();
  if (scheme?.toLowerCase() !== "bearer" || token === "") return false;

  const encoder = new TextEncoder();
  const [presented, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.MCP_API_KEY)),
  ]);
  return crypto.subtle.timingSafeEqual(presented, expected);
}

function challenge(message: string, resourceMetadataUrl: string): Response {
  // The SDK builds the 401 and its `WWW-Authenticate: Bearer ...
  // resource_metadata="..."` challenge, so the header is the spec's rather than
  // this file's guess at it. A 302 — what default Access answers a non-browser
  // client with, and the reason Managed OAuth exists — is what it must not be.
  return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, message), {
    resourceMetadataUrl,
  });
}
