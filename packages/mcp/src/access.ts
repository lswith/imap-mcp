/**
 * Cloudflare Access, read from the runtime rather than from a header (#10).
 *
 * With no folder fence, this endpoint is functionally read access to fifteen
 * years of mail, so authentication is the load-bearing control in the whole
 * design rather than hygiene on top of it.
 *
 * The mechanism is Access **Managed OAuth**, and one detail of it is worth
 * knowing before reading further: the token Access issues to the *client* is
 * opaque (`oauth:CvNoo...`), not a JWT, and cannot be verified by anyone but
 * Access. Access exchanges it at the edge and — since the August 2026 Workers
 * integration — hands the result to the worker as `ctx.access`, alongside the
 * `Cf-Access-Jwt-Assertion` header it has always forwarded.
 *
 * This reads `ctx.access` and never the header, which is the stronger of the
 * two rather than merely the newer. A header is request data: it arrives from
 * outside and is trustworthy only for as long as nothing can reach this worker
 * without traversing Access. `ctx.access` is set by the runtime and cannot be
 * spoofed by a caller at all — a request that did not go through Access has no
 * `ctx.access`, whatever headers it carries, so the gate closes on exactly the
 * case a header check would have to reason about.
 *
 * Two things follow that the rest of this file is built around:
 *
 *   - `ctx.access` being absent is the refusal, so the gate fails closed by
 *     construction rather than by remembering to.
 *   - `aud` still has to be checked. Access authenticating *someone* is not the
 *     same as Access authenticating them for *this* application, and one Zero
 *     Trust account can hold many.
 */

import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";

/**
 * Either the audience this deploy accepts, or the name of what is missing.
 *
 * An outcome rather than a thrown error, matching `SearchOutcome` in
 * src/search.ts: the caller has to look at `ok` to reach the value, so the
 * failure cannot be walked past by forgetting a `catch`.
 */
export type AccessConfigOutcome =
  | { readonly ok: true; readonly aud: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read the one `var` this gate needs.
 *
 * Nothing here echoes a configured value into the reason. An AUD tag is not a
 * credential, but naming the variable is enough to fix the problem, and the
 * rule is easier to keep than to remember to apply.
 */
export function readAccessConfig(env: Env): AccessConfigOutcome {
  const aud = env.ACCESS_AUD?.trim();
  if (!aud) return { ok: false, reason: "ACCESS_AUD is not set" };
  return { ok: true, aud };
}

/**
 * The caller as Access describes them, or the response to send instead.
 *
 * The success arm carries the whole `ctx.access` rather than a copy of the
 * fields: `getIdentity()` is a call, not a property, and nothing needs the
 * email yet. #12 wants an actor for the audit log and can ask for one then,
 * without this gate paying for an identity lookup on every search.
 */
export type AccessOutcome =
  | { readonly ok: true; readonly access: CloudflareAccessContext }
  | { readonly ok: false; readonly response: Response };

export function verifyAccess(
  request: Request,
  env: Env,
  access: CloudflareAccessContext | undefined,
): AccessOutcome {
  // RFC 9728: the 401 has to tell a client where to go to discover the
  // authorization server. Built from the request's own URL, which is the
  // hostname the Access application is bound to. With Access in front it is
  // Access that answers the path this points at; the worker serves its own copy
  // too (see src/index.ts), so the pointer leads somewhere either way.
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(request.url));

  const configured = readAccessConfig(env);
  if (!configured.ok) {
    // Fail closed, and say so as a server fault rather than a client one. A
    // 401 here would invite a client into an OAuth flow that cannot possibly
    // succeed; the thing that is wrong is the deployment, not the caller.
    // What must never happen is the third option — letting the request past
    // because the gate was never configured.
    const error = new OAuthError(OAuthErrorCode.ServerError, configured.reason);
    return { ok: false, response: bearerAuthChallengeResponse(error, { resourceMetadataUrl }) };
  }

  // Access did not run. Either nothing is in front of this worker, or the
  // request reached it by a path that bypassed Access — a route added before
  // the application existed, a policy edited to "bypass". Both are refusals,
  // and neither can be faked into a pass by a caller, because this is not
  // request data.
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
  if (access.aud !== configured.aud) {
    return {
      ok: false,
      response: challenge("Not authenticated for this application", resourceMetadataUrl),
    };
  }

  return { ok: true, access };
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
