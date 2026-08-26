/**
 * Assertions from the throwaway Zero Trust tenant vitest.config.ts mints.
 *
 * The signatures are real: the key pair is generated per run in Node, handed to
 * the test worker as a binding, and the matching public JWKS is what
 * `outboundService` answers the worker's certs fetch with. So a test that gets
 * past the gate got past it by presenting a valid RS256 signature over the
 * right issuer and audience, not by stubbing the check.
 *
 * `outsiderToken` signs with a key the tenant never published, which is how
 * "well formed, signed by somebody else" is exercised without hand-editing
 * bytes of a signature.
 */

import { env } from "cloudflare:test";
import { generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

/** Matches vitest.config.ts. A domain that deliberately cannot resolve. */
export const TEAM_DOMAIN = "https://imap-mcp-test.cloudflareaccess.com";
export const AUD = "0d3ad0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";
export const ASSERTION_HEADER = "cf-access-jwt-assertion";

/** Every claim has a working default; override one to break exactly one thing. */
export type Claims = {
  aud?: string;
  issuer?: string;
  /** `null` omits the claim entirely, as a service-token identity would. */
  email?: string | null;
  subject?: string;
  /**
   * Anything `jose` accepts, including a negative age like "-5m" for expired.
   * `null` omits `exp` altogether — a token that would otherwise never age out.
   */
  expiresIn?: string | null;
  /** Sign with something other than RS256, to prove the algorithm is pinned. */
  alg?: string;
};

function mint(key: CryptoKey | Uint8Array, claims: Claims): Promise<string> {
  const email = claims.email === null ? {} : { email: claims.email ?? "luke@example.com" };
  const jwt = new SignJWT(email)
    .setProtectedHeader({ alg: claims.alg ?? "RS256", kid: "test" })
    .setIssuer(claims.issuer ?? TEAM_DOMAIN)
    .setAudience(claims.aud ?? AUD)
    .setSubject(claims.subject ?? "test-subject")
    .setIssuedAt();
  if (claims.expiresIn !== null) jwt.setExpirationTime(claims.expiresIn ?? "1h");
  return jwt.sign(key);
}

/** A token signed with a symmetric secret — the classic alg-confusion probe. */
export function hmacToken(claims: Claims = {}): Promise<string> {
  return mint(new Uint8Array(32), { ...claims, alg: "HS256" });
}

/** An assertion the tenant would have issued. */
export async function accessToken(claims: Claims = {}): Promise<string> {
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_KEY) as JWK, "RS256");
  return mint(key as CryptoKey, claims);
}

/** The same assertion, signed by a key the tenant never published. */
export async function outsiderToken(claims: Claims = {}): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return mint(privateKey, claims);
}

/** The header a request carries once Access has authenticated it. */
export async function accessHeaders(claims: Claims = {}): Promise<Record<string, string>> {
  return { [ASSERTION_HEADER]: await accessToken(claims) };
}
