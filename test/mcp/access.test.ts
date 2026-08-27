import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readAccessConfig, verifyAccess } from "../../src/mcp/access";
import { handleRequest } from "../../src/mcp/handler";
import { AUD, authenticated, unauthenticated } from "./support/access";

const ENDPOINT = "https://imap-mcp.invalid/mcp";

function post(): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

describe("readAccessConfig", () => {
  it("reads the audience a deployer supplies", () => {
    const outcome = readAccessConfig(env);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.aud).toBe(AUD);
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
  ])("names the variable when ACCESS_AUD is %s", (_case, value) => {
    const outcome = readAccessConfig({ ...env, ACCESS_AUD: value });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.reason).toBe("ACCESS_AUD is not set");
  });
});

describe("verifyAccess", () => {
  it("admits a caller Access authenticated for this application", async () => {
    const outcome = verifyAccess(post(), env, authenticated().access);

    expect(outcome.ok).toBe(true);
    // The whole context is handed back rather than a copy of it, so #12 can ask
    // for an actor without this gate paying for an identity lookup per search.
    await expect(outcome.ok ? outcome.access.getIdentity() : null).resolves.toEqual({
      email: "luke@example.com",
    });
  });

  it("refuses a request Access never ran on, with 401 and a discovery pointer", () => {
    const outcome = verifyAccess(post(), env, unauthenticated().access);

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

  it("refuses a caller authenticated for a different application", () => {
    // The load-bearing check. One Zero Trust account holds many applications,
    // and another one's policy may be far more generous than this one's — so
    // "Access authenticated them" is not the claim that matters here.
    const outcome = verifyAccess(post(), env, authenticated({ aud: "another-application" }).access);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.response.status).toBe(401);
    expect(!outcome.ok && challenge(outcome.response).scheme).toBe("Bearer");
  });

  it("does not tell the caller which audience would have worked", async () => {
    const outcome = verifyAccess(post(), env, authenticated({ aud: "another-application" }).access);
    const body = outcome.ok ? "" : await outcome.response.text();

    expect(body).not.toContain(AUD);
    expect(body).not.toContain("another-application");
  });

  it("fails closed with a server fault when ACCESS_AUD is unset", async () => {
    const outcome = verifyAccess(post(), { ...env, ACCESS_AUD: undefined }, authenticated().access);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // 500, not 401: the deployment is what is wrong, and a 401 would invite a
    // client into an OAuth flow that cannot succeed. What it must never be is
    // a pass — an unconfigured gate is a closed gate, even for a caller Access
    // did authenticate.
    expect(outcome.response.status).toBe(500);
    // And not a challenge, for the same reason: there is no credential the
    // caller could present that would change the answer.
    expect(outcome.response.headers.get("www-authenticate")).toBeNull();
    // The body names the variable to set, because whoever sees this is the
    // person who can fix it.
    await expect(outcome.response.text()).resolves.toContain("ACCESS_AUD");
  });
});

describe("the endpoint", () => {
  it("serves the tool path once Access has authenticated the caller", async () => {
    const response = await handleRequest(post(), env, authenticated());

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("refuses an unauthenticated MCP request with 401, not 302", async () => {
    const response = await handleRequest(post(), env, unauthenticated());

    expect(response.status).toBe(401);
    expect(challenge(response).scheme).toBe("Bearer");
  });

  it("still answers an unknown path with 404, without running the gate", async () => {
    // The path check comes first on purpose: an unauthenticated probe of some
    // other path is not an authentication failure, and saying so would leak
    // that this hostname is gated by Access.
    const response = await handleRequest(
      new Request("https://imap-mcp.invalid/", { method: "POST" }),
      env,
      unauthenticated(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("turns a foreign origin away as a browser before asking who it is", async () => {
    const response = await handleRequest(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { origin: "https://attacker.example", "content-type": "application/json" },
        body: "{}",
      }),
      env,
      // Authenticated, and still refused. A DNS-rebound page carries the
      // victim's Access cookie, so Access genuinely authenticates it — being
      // signed in must not be a way past the Origin check.
      authenticated(),
    );

    expect(response.status).toBe(403);
  });

  it("is reachable through the deployed entry point, and closed there", async () => {
    // `SELF` is a service binding, so `ctx.access` is never populated across
    // it — which makes this exactly the unauthenticated case, and the one
    // thing worth asserting through the real entry point.
    const response = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(challenge(response).scheme).toBe("Bearer");
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
    const refused = await handleRequest(post(), env, unauthenticated());
    const pointer = challenge(refused).resourceMetadata ?? "";

    expect(pointer).not.toBe("");
    await expect(SELF.fetch(pointer).then((r) => r.status)).resolves.toBe(200);
  });
});
