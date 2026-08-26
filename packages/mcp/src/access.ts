/**
 * Cloudflare Access, verified here rather than taken on trust (#10).
 *
 * With no folder fence, this endpoint is functionally read access to fifteen
 * years of mail, so authentication is the load-bearing control in the whole
 * design rather than hygiene on top of it.
 *
 * The mechanism is Access **Managed OAuth**, and one detail of it shapes
 * everything below: the token Access issues to the *client* is opaque
 * (`oauth:CvNoo...`), not a JWT, and cannot be verified by anyone but Access.
 * What reaches this worker is different — Access exchanges that token at the
 * edge and forwards a signed JWT in the `Cf-Access-Jwt-Assertion` header, the
 * same as the browser cookie flow does. So the header this module reads is
 * deliberately not `Authorization`: the bearer token in `Authorization` is the
 * opaque one, and treating it as a credential we had checked would be trusting
 * a string we cannot read. Cloudflare's own guidance is that Managed OAuth
 * should only be turned on for servers that validate the forwarded JWT.
 *
 * Verifying it here rather than relying on the edge alone is what makes the
 * gate survive a mistake in front of it: a route added before the Access
 * application exists, a policy edited to "bypass", an origin reachable by some
 * path that did not go through Access. Any of those turns an edge-trusting
 * worker into an open mailbox, and none of them changes what this file does.
 */

import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

/**
 * The header Access forwards its signed assertion in. Lowercase because
 * `Headers.get` is case-insensitive and this is the form the docs use.
 */
const ASSERTION_HEADER = "cf-access-jwt-assertion";

/** Where a Zero Trust tenant publishes the keys it signs assertions with. */
const CERTS_PATH = "/cdn-cgi/access/certs";

type AccessConfig = {
  /** Team domain as an origin, e.g. https://team.cloudflareaccess.com. */
  readonly teamDomain: string;
  /** The application's Audience (AUD) tag. */
  readonly aud: string;
};

/**
 * Either the configuration, or the name of what is missing.
 *
 * An outcome rather than a thrown error, matching `SearchOutcome` in
 * src/search.ts: the caller has to look at `ok` to reach the value, so the
 * failure cannot be walked past by forgetting a `catch`.
 */
export type AccessConfigOutcome =
  | { readonly ok: true; readonly config: AccessConfig }
  | { readonly ok: false; readonly reason: string };

const BAD_TEAM_DOMAIN = "ACCESS_TEAM_DOMAIN must be an absolute https URL";

/**
 * Read the two `vars` this gate needs.
 *
 * Nothing here echoes a configured value into the reason. Neither is secret —
 * an AUD tag is not a credential — but naming the variable is enough to fix the
 * problem, and the rule is easier to keep than to remember to apply.
 */
export function readAccessConfig(env: Env): AccessConfigOutcome {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) return { ok: false, reason: "ACCESS_TEAM_DOMAIN is not set" };

  const aud = env.ACCESS_AUD?.trim();
  // Without an audience the check is tenant-scoped, not application-scoped:
  // every token the same Zero Trust tenant ever issued, for any application,
  // would verify here. Absent is a refusal, never a looser check.
  if (!aud) return { ok: false, reason: "ACCESS_AUD is not set" };

  let issuer: URL;
  try {
    issuer = new URL(teamDomain);
  } catch {
    return { ok: false, reason: BAD_TEAM_DOMAIN };
  }
  if (issuer.protocol !== "https:") return { ok: false, reason: BAD_TEAM_DOMAIN };

  // `iss` on an Access token is the team domain with no trailing slash, while
  // `new URL()` gives every bare origin one. Comparing the two unnormalised is
  // how a correct configuration fails to verify anything at all.
  return { ok: true, config: { teamDomain: issuer.origin, aud } };
}

/**
 * Remote key sets, cached across requests and keyed by their own URL.
 *
 * The MCP handler is built per request on purpose — it would otherwise close
 * over whichever `env` arrived first — but a key set must not be, or every
 * single request pays a JWKS fetch. This cache is safe where a handler cache
 * would not be because what it holds is derived from one string and closes over
 * no `env`: two deploys with different team domains get different entries
 * rather than one poisoning the other. `jose` then does the real work, honouring
 * its own cooldown and cache-max-age between refetches.
 */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(teamDomain: string) {
  const url = new URL(CERTS_PATH, teamDomain);
  const cached = keySets.get(url.href);
  if (cached) return cached;

  const keySet = createRemoteJWKSet(url);
  keySets.set(url.href, keySet);
  return keySet;
}

/**
 * The identity Access asserted. Only what a log line or a future audit trail
 * would want; nothing here reaches a model.
 */
type AccessIdentity = {
  readonly email?: string;
  readonly sub?: string;
};

/**
 * The caller's identity, or the response to send instead.
 *
 * A union rather than `Response | undefined`, which is what the Origin check
 * above this one in src/index.ts returns: that check has nothing to hand back
 * on success, and this one does. #12 needs an actor for the audit log, and
 * retrofitting it later would mean re-plumbing `fetch`.
 */
export type AccessOutcome =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly response: Response };

export async function verifyAccess(request: Request, env: Env): Promise<AccessOutcome> {
  // RFC 9728: the 401 has to tell a client where to go and discover the
  // authorization server. Built from the request's own URL because that is the
  // hostname the Access application is bound to — and with Access in front it
  // is Access, not this worker, that answers the path this points at. The
  // worker serves its own copy anyway (see src/index.ts), so the pointer still
  // leads somewhere in the case where this 401 is the worker's own.
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
  const config = configured.config;

  const token = request.headers.get(ASSERTION_HEADER);
  if (!token) {
    return { ok: false, response: challenge("No Cloudflare Access token", resourceMetadataUrl) };
  }

  try {
    const { payload } = await jwtVerify(token, keySetFor(config.teamDomain), {
      issuer: config.teamDomain,
      // The half that does the real work. Every application in one Zero Trust
      // account is signed by the same team keys, so a signature-only check
      // admits any of them — including one with a policy that lets the whole
      // internet in. Pinning the audience is what makes this application's
      // gate this application's.
      audience: config.aud,
      // Pinned, not inferred. Taking the algorithm from a JWKS that grew an
      // entry is how alg-confusion gets in; Access signs RS256.
      algorithms: ["RS256"],
      // `jose` validates `exp` when it is present and says nothing when it is
      // not, so a token minted without one would verify for ever. Access
      // always sets it; requiring it is the reading that fails closed.
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email : undefined;
    return { ok: true, identity: { email, sub: payload.sub } };
  } catch (error) {
    // Whose fault was that? The two answers must not be conflated: reporting an
    // unreachable key set as `invalid_token` would tell a client its perfectly
    // good session had been revoked, sending it back through OAuth for another
    // token that would fail in exactly the same way.
    if (!judgesTheToken(error)) return { ok: false, response: unavailable() };

    // The reason is deliberately not passed through. A caller learns that the
    // token was not accepted; which claim disagreed is for the logs of whoever
    // runs this, not for whoever is knocking.
    return {
      ok: false,
      response: challenge("Invalid Cloudflare Access token", resourceMetadataUrl),
    };
  }
}

/**
 * The `jose` errors that are a verdict on the token rather than on us.
 *
 * Enumerated rather than inferred, because the interesting cases are not
 * subclasses at all: a JWKS endpoint answering 404 or 500 throws the *base*
 * `JOSEError`, so "is it a JOSEError" would call an outage the caller's
 * problem. `JWKSNoMatchingKey` is on this list on purpose — `jose` refetches
 * the key set before raising it, so by then the signing key genuinely is not
 * one this tenant publishes.
 */
const TOKEN_FAULTS = [
  joseErrors.JWTExpired,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTInvalid,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JWKSNoMatchingKey,
] as const;

function judgesTheToken(error: unknown): boolean {
  // Anything unrecognised falls to the other side deliberately. Being wrong in
  // that direction costs a 503 on a request that might have been fine; being
  // wrong in the other tells a legitimate client to throw away a valid session.
  return TOKEN_FAULTS.some((fault) => error instanceof fault);
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

function unavailable(): Response {
  // Not a challenge: there is nothing wrong with the caller's credentials that
  // re-authenticating would fix, so this carries no WWW-Authenticate at all.
  return new Response("Cannot reach Cloudflare Access to verify the token\n", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "30" },
  });
}
