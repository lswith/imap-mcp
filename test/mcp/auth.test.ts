import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readAuthConfig, verifyAuth } from "../../src/mcp/auth";
import { handleRequest } from "../../src/mcp/handler";
import { API_KEY, AUD, authenticated, unauthenticated } from "./support/access";

const ENDPOINT = "https://imap-mcp.invalid/mcp";

function post(bearer?: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: "{}",
  });
}

/** The environment of an instance that has not configured Access. */
function keyMode(overrides: Partial<Env> = {}): Env {
  return { ...env, ACCESS_AUD: undefined, ...overrides };
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

describe("readAuthConfig", () => {
  it("selects Access mode when an audience is configured", () => {
    const mode = readAuthConfig(env);

    expect(mode).toEqual({ mode: "access", aud: AUD });
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
  ])("selects API-key mode when ACCESS_AUD is %s", (_case, value) => {
    const mode = readAuthConfig({ ...env, ACCESS_AUD: value });

    expect(mode).toEqual({ mode: "api-key" });
  });
});

describe("verifyAuth, with Access configured", () => {
  it("admits a caller Access authenticated for this application", async () => {
    const outcome = await verifyAuth(post(), env, authenticated().access);

    expect(outcome.ok).toBe(true);
    // The whole context is handed back rather than a copy of it, so #12 can ask
    // for an actor without this gate paying for an identity lookup per search.
    await expect(outcome.ok ? outcome.access?.getIdentity() : null).resolves.toEqual({
      email: "luke@example.com",
    });
  });

  it("refuses a request Access never ran on, with 401 and a discovery pointer", async () => {
    const outcome = await verifyAuth(post(), env, unauthenticated().access);

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

  it("refuses a caller authenticated for a different application", async () => {
    // The load-bearing check. One Zero Trust account holds many applications,
    // and another one's policy may be far more generous than this one's — so
    // "Access authenticated them" is not the claim that matters here.
    const outcome = await verifyAuth(
      post(),
      env,
      authenticated({ aud: "another-application" }).access,
    );

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.response.status).toBe(401);
    expect(!outcome.ok && challenge(outcome.response).scheme).toBe("Bearer");
  });

  it("does not tell the caller which audience would have worked", async () => {
    const outcome = await verifyAuth(
      post(),
      env,
      authenticated({ aud: "another-application" }).access,
    );
    const body = outcome.ok ? "" : await outcome.response.text();

    expect(body).not.toContain(AUD);
    expect(body).not.toContain("another-application");
  });

  it("refuses a valid API key once Access is configured — precedence, not fallback", async () => {
    // The upgrade story depends on this row of the table: setting the audience
    // must make a leaked key worthless, so the two credentials are never both
    // accepted. The challenge is the OAuth one, because OAuth is the flow that
    // can now succeed.
    const outcome = await verifyAuth(post(API_KEY), env, undefined);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.response.status).toBe(401);
    expect(challenge(outcome.response).resourceMetadata).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });
});

describe("verifyAuth, in API-key mode", () => {
  it("admits a caller presenting the API key", async () => {
    const outcome = await verifyAuth(post(API_KEY), keyMode(), undefined);

    expect(outcome.ok).toBe(true);
    // No Access context to hand over: the audit rows record a null actor,
    // which is truthful — a shared key does not identify anyone.
    expect(outcome.ok && outcome.access).toBeUndefined();
  });

  it("refuses a wrong key with a 401 bearer challenge", async () => {
    const outcome = await verifyAuth(post("not-the-key"), keyMode(), undefined);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.response.status).toBe(401);
    expect(challenge(outcome.response).scheme).toBe("Bearer");
  });

  it("does not advertise an OAuth flow that is not available", async () => {
    // Two challenge shapes, deliberately: in this mode there is no
    // authorization server, so a resource_metadata pointer would send a
    // client into a flow that cannot succeed.
    const outcome = await verifyAuth(post("not-the-key"), keyMode(), undefined);

    expect(!outcome.ok && challenge(outcome.response).resourceMetadata).toBeUndefined();
  });

  it("refuses a request with no Authorization header at all", async () => {
    const outcome = await verifyAuth(post(), keyMode(), undefined);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.response.status).toBe(401);
  });

  it("refuses a key of a different length rather than throwing", async () => {
    // The comparison is constant-time over digests, so a length mismatch is
    // an ordinary refusal — not an exception and not an early exit that
    // leaks where the difference was.
    const outcome = await verifyAuth(post(`${API_KEY}x`), keyMode(), undefined);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.response.status).toBe(401);
  });

  it("does not accept the key as a cookie, a query parameter, or any other shape", async () => {
    const url = new URL(ENDPOINT);
    url.searchParams.set("key", API_KEY);
    const smuggled = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `key=${API_KEY}` },
      body: "{}",
    });

    const outcome = await verifyAuth(smuggled, keyMode(), undefined);

    expect(outcome.ok).toBe(false);
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

  it("serves the tool path with the API key when Access is not configured", async () => {
    const response = await handleRequest(post(API_KEY), keyMode(), unauthenticated());

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("keeps the origin check in API-key mode — a valid key is not a way past it", async () => {
    const response = await handleRequest(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: "{}",
      }),
      keyMode(),
      unauthenticated(),
    );

    expect(response.status).toBe(403);
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
