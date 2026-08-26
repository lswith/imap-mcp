import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readAccessConfig, verifyAccess } from "../src/access";
import {
  ASSERTION_HEADER,
  AUD,
  accessToken,
  hmacToken,
  outsiderToken,
  TEAM_DOMAIN,
} from "./support/access";

const ENDPOINT = "https://imap-mcp.invalid/mcp";

/** A request as it reaches the worker, with whatever assertion is under test. */
function post(token?: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { [ASSERTION_HEADER]: token } : {}),
    },
    body: "{}",
  });
}

/**
 * The `WWW-Authenticate` challenge, parsed enough to assert on.
 *
 * The whole point of Managed OAuth is that this header exists and a 302 does
 * not, so the tests check the header rather than only the status code.
 */
function challenge(response: Response) {
  const header = response.headers.get("www-authenticate") ?? "";
  return {
    header,
    scheme: header.split(" ", 1)[0],
    resourceMetadata: /resource_metadata="([^"]+)"/.exec(header)?.[1],
  };
}

/** The reason, for a config the reader was always going to refuse. */
function refusal(overrides: Partial<Env>): string {
  const outcome = readAccessConfig({ ...env, ...overrides });
  expect(outcome.ok).toBe(false);
  return outcome.ok ? "" : outcome.reason;
}

describe("readAccessConfig", () => {
  it("reads the two vars a deployer supplies", () => {
    const outcome = readAccessConfig(env);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.config).toEqual({ teamDomain: TEAM_DOMAIN, aud: AUD });
  });

  it.each([
    ["ACCESS_TEAM_DOMAIN", { ACCESS_TEAM_DOMAIN: undefined }, "ACCESS_TEAM_DOMAIN is not set"],
    ["a blank ACCESS_TEAM_DOMAIN", { ACCESS_TEAM_DOMAIN: "  " }, "ACCESS_TEAM_DOMAIN is not set"],
    ["ACCESS_AUD", { ACCESS_AUD: undefined }, "ACCESS_AUD is not set"],
    ["a blank ACCESS_AUD", { ACCESS_AUD: "   " }, "ACCESS_AUD is not set"],
  ])("names what is missing when given %s", (_case, overrides, reason) => {
    expect(refusal(overrides)).toBe(reason);
  });

  it("never echoes a configured value into the reason", () => {
    // The AUD is not a secret, but the rule is that no configured value reaches
    // a message — easier to keep than to remember to apply.
    expect(refusal({ ACCESS_TEAM_DOMAIN: undefined })).not.toContain(AUD);
    expect(refusal({ ACCESS_AUD: undefined })).not.toContain(TEAM_DOMAIN);
  });

  it.each([
    ["is not absolute", "team.cloudflareaccess.com"],
    ["is not https", "http://team.cloudflareaccess.com"],
  ])("refuses a team domain that %s", (_case, value) => {
    expect(refusal({ ACCESS_TEAM_DOMAIN: value })).toContain("absolute https URL");
  });

  it("strips the trailing slash a bare origin picks up", () => {
    // `iss` on an Access token carries no trailing slash. Comparing it against
    // one that does is how a correct configuration verifies nothing at all.
    const outcome = readAccessConfig({ ...env, ACCESS_TEAM_DOMAIN: `${TEAM_DOMAIN}/` });

    expect(outcome.ok && outcome.config.teamDomain).toBe(TEAM_DOMAIN);
  });
});

describe("verifyAccess", () => {
  it("accepts an assertion the tenant signed, and reports who it names", async () => {
    const outcome = await verifyAccess(post(await accessToken({ email: "luke@lswith.io" })), env);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.identity).toEqual({
      email: "luke@lswith.io",
      sub: "test-subject",
    });
  });

  it("reports no email when the assertion carries none it can use", async () => {
    // Access always sends one for a human login, but a service-token identity
    // has no email at all — so the claim is narrowed rather than assumed.
    const outcome = await verifyAccess(post(await accessToken({ email: null })), env);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.identity).toEqual({ email: undefined, sub: "test-subject" });
  });

  it("answers a request with no assertion with 401 and a discovery pointer", async () => {
    const outcome = await verifyAccess(post(), env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // The acceptance criterion, literally: a 401 carrying WWW-Authenticate, and
    // emphatically not the 302 default Access answers a non-browser client with.
    expect(outcome.response.status).toBe(401);
    expect(outcome.response.status).not.toBe(302);

    const { scheme, resourceMetadata } = challenge(outcome.response);
    expect(scheme).toBe("Bearer");
    expect(resourceMetadata).toContain("/.well-known/oauth-protected-resource");
    expect(resourceMetadata).toContain("imap-mcp.invalid");
  });

  it.each([
    ["signed by a key the tenant never published", () => outsiderToken()],
    ["issued for another application", () => accessToken({ aud: "a-different-audience-tag" })],
    [
      "issued by another tenant",
      () => accessToken({ issuer: "https://other.cloudflareaccess.com" }),
    ],
    ["expired", () => accessToken({ expiresIn: "-5m" })],
    ["not a JWT at all", async () => "oauth:CvNooOpaqueTokenNotAJwt"],
    // `jose` checks `exp` when it is there and says nothing when it is not, so
    // without requiredClaims this one would verify for ever.
    ["carrying no expiry at all", () => accessToken({ expiresIn: null })],
    // Signed with a symmetric secret rather than the tenant's key. Only the
    // pinned algorithm list stops this being a signature the worker accepts.
    ["signed with a symmetric algorithm", () => hmacToken()],
  ])("refuses an assertion %s", async (_case, mint) => {
    const outcome = await verifyAccess(post(await mint()), env);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.response.status).toBe(401);
    expect(!outcome.ok && challenge(outcome.response).scheme).toBe("Bearer");
  });

  it("does not tell the caller which claim disagreed", async () => {
    const outcome = await verifyAccess(post(await accessToken({ aud: "wrong" })), env);
    const body = outcome.ok ? "" : await outcome.response.text();

    expect(body).not.toContain("wrong");
    expect(body).not.toContain(AUD);
    expect(body).not.toContain("audience");
  });

  it.each([
    ["ACCESS_TEAM_DOMAIN", { ACCESS_TEAM_DOMAIN: undefined }],
    ["ACCESS_AUD", { ACCESS_AUD: undefined }],
  ])("fails closed with a server fault when %s is unset", async (name, missing) => {
    const outcome = await verifyAccess(post(await accessToken()), { ...env, ...missing });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // 500, not 401: the deployment is what is wrong, and a 401 would invite a
    // client into an OAuth flow that cannot succeed. What it must never be is
    // a pass — an unconfigured gate is a closed gate.
    expect(outcome.response.status).toBe(500);
    // And not a challenge, for the same reason: there is no credential the
    // caller could present that would change the answer.
    expect(outcome.response.headers.get("www-authenticate")).toBeNull();
    // The body names the variable to set, because whoever sees this is the
    // person who can fix it.
    await expect(outcome.response.text()).resolves.toContain(name);
  });

  it("says 503, not 401, when the tenant's keys cannot be fetched", async () => {
    // A different team domain, so this gets its own key set rather than the one
    // the passing tests have already cached.
    const unreachable = "https://offline.cloudflareaccess.com";
    const outcome = await verifyAccess(post(await accessToken({ issuer: unreachable })), {
      ...env,
      ACCESS_TEAM_DOMAIN: unreachable,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // Reporting an unreachable JWKS as `invalid_token` would tell a client its
    // perfectly good session had been revoked, sending it back through OAuth
    // for another token that would fail exactly the same way.
    expect(outcome.response.status).toBe(503);
    expect(outcome.response.headers.get("www-authenticate")).toBeNull();
  });
});

describe("discovery", () => {
  // The MCP authorization spec makes RFC 9728 metadata a MUST for a resource
  // server, and this worker's own 401 points at it. Under Access the edge
  // answers first; these cover the backstop and `wrangler dev`.
  it.each([
    ["the bare well-known path", "/.well-known/oauth-protected-resource"],
    ["the path-aware form", "/.well-known/oauth-protected-resource/mcp"],
  ])("serves protected-resource metadata at %s, unauthenticated", async (_case, path) => {
    const response = await SELF.fetch(`https://imap-mcp.invalid${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      resource: "https://imap-mcp.invalid/mcp",
      // biome-ignore lint/style/useNamingConvention: RFC 9728 field name.
      authorization_servers: ["https://imap-mcp.invalid"],
    });
  });

  it("answers a browser preflight, and refuses to be posted to", async () => {
    const url = "https://imap-mcp.invalid/.well-known/oauth-protected-resource";

    const preflight = await SELF.fetch(url, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);

    const posted = await SELF.fetch(url, { method: "POST" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("points its own 401 at a document it actually serves", async () => {
    // The two halves have to agree, or the challenge sends a client to a 404.
    const refused = await SELF.fetch(ENDPOINT, { method: "POST" });
    const pointer = challenge(refused).resourceMetadata ?? "";

    expect(pointer).not.toBe("");
    await expect(SELF.fetch(pointer).then((r) => r.status)).resolves.toBe(200);
  });
});

describe("the deployed endpoint", () => {
  it("refuses an unauthenticated MCP request with 401, not 302", async () => {
    const response = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(challenge(response).scheme).toBe("Bearer");
  });

  it("still answers an unknown path with 404, without running the gate", async () => {
    // The path check comes first on purpose: an unauthenticated probe of some
    // other path is not an authentication failure, and saying so would leak
    // that this hostname is gated by Access.
    const response = await SELF.fetch("https://imap-mcp.invalid/", { method: "POST" });

    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("turns a foreign origin away as a browser before asking about its token", async () => {
    const response = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        [ASSERTION_HEADER]: await accessToken(),
      },
      body: "{}",
    });

    // A valid assertion does not buy a cross-site page a way in.
    expect(response.status).toBe(403);
  });
});
