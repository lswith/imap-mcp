/**
 * The MCP half of the Worker — a stateless reader over the index the sync half
 * builds.
 *
 * Reads come from D1; writes go through the write service (src/sync/handlers.ts),
 * which is where every refusal lives. Since #34 the Worker is reachable at its
 * workers.dev hostname by default, so this gate is what stands between the
 * mailbox index and the internet: every request is refused unless Cloudflare
 * Access authenticated it for this application. See src/mcp/access.ts and
 * docs/access.md.
 */

import {
  createMcpHandler,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createWriteService } from "../sync/handlers";
import type { WriteService } from "../writes";
import { verifyAccess } from "./access";
import { createServer } from "./server";

/** The one path this worker serves. Everything else is a 404, not a handler. */
const ENDPOINT = "/mcp";

/**
 * The fetch path, as a plain function of its inputs.
 *
 * Wired to the Worker's `fetch` in src/index.ts and exported the way
 * src/sync/handlers.ts exports `handleScheduled` and `handleQueue`, for the
 * same reason: a test cannot reach this path through the normal entry point.
 * `SELF` from `cloudflare:test` is a service binding, and Cloudflare documents
 * that Access deliberately does not propagate `ctx.access` across one — so a
 * request made through `SELF.fetch` can never carry an authenticated context,
 * however the harness is configured. Calling this directly is the only way to
 * exercise the authenticated path at all.
 *
 * `writer` is how the write tools reach the mailbox. The default is the real
 * thing; tests inject a fake, which is the same seam the removed service
 * binding used to be.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "access">,
  writer: WriteService = createWriteService(env),
): Promise<Response> {
  const url = new URL(request.url);

  // Discovery, answered before the gate and without a token — a caller that
  // had one would not be asking. The MCP authorization spec makes RFC 9728
  // metadata a MUST for a resource server, and the `resource_metadata`
  // pointer in this worker's own 401 has to lead somewhere: without this,
  // the one case where that 401 fires — Access missing or misconfigured in
  // front of the worker — is the case where its pointer hits the 404 below.
  //
  // With Access in front, the edge answers this first and the copy below is
  // never reached. Its audience is the backstop and `wrangler dev`.
  const discovery = protectedResourceMetadata(request, url);
  if (discovery) return discovery;

  if (url.pathname !== ENDPOINT) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // DNS-rebinding and CSRF protection, which matters most for `wrangler dev`:
  // a page can resolve a hostname it controls to 127.0.0.1 and post to a
  // local server that never expected the internet. The SDK documents the
  // handler itself as deliberately validation-free, so this belongs in front
  // of it.
  //
  // Origin rather than Host, and that is the whole point. On Workers
  // `request.url` is built from the Host header, so validating one against
  // the other answers a question nobody asked. Origin is what separates a
  // browser from everything else: MCP clients do not send one and pass,
  // while a page on another site sends its own and is turned away. That is a
  // question about the caller's kind rather than its identity, which is why
  // it still runs ahead of Access below.
  const rejected = originValidationResponse(request, localhostAllowedOrigins());
  if (rejected) return rejected;

  // Cloudflare Access, read from the runtime rather than from a header (#10).
  //
  // Third of three, and one step of that order is load-bearing rather than
  // tidy: Origin has to come first, because a DNS-rebound request carries the
  // victim's Access *cookie*, so Access authenticates it and the check below
  // **passes**. Access authenticating a request does not make it one the user
  // meant to send. The Origin check is the only thing that stops it, so it
  // must not be reachable past by being genuinely signed in.
  //
  // The 404 above comes first for a duller reason: an unauthenticated probe
  // of some other path is not an authentication failure, and answering it
  // with a challenge would advertise that this hostname is gated by Access.
  // The cost is that a cross-origin probe gets 403 rather than 401, which
  // tells an attacker nothing they did not already supply.
  const access = verifyAccess(request, env, ctx.access);
  if (!access.ok) return access.response;

  // Built per request, deliberately. The factory `createMcpHandler` calls is
  // handed no `env`, so a handler held at module scope would close over
  // whichever `env` happened to arrive first. Constructing it here is a
  // couple of cheap objects, and it is the honest shape of a server that
  // holds nothing between requests.
  // The Access context rides through to the write tools (#12), which need an
  // actor for the audit row. Handed over whole rather than resolved here:
  // `getIdentity()` is a call, and a search has no business paying for one.
  return createMcpHandler(() => createServer(env, writer, access.access)).fetch(request);
}

/**
 * RFC 9728 Protected Resource Metadata, or `undefined` for any other path.
 *
 * Clients probe both the bare well-known path and the path-aware form the spec
 * derives from the resource URL, so both are matched.
 *
 * The document names the origin from `request.url` — which on Workers means the
 * Host header, the one input this package otherwise refuses to trust ("Origin
 * is validated, Host is not"). That is deliberate and confined to here: the
 * document holds nothing secret and asserts nothing but the host the caller
 * itself asked for, which is what RFC 9728 specifies. Under Managed OAuth the
 * authorization server *is* that origin, because Access serves its metadata on
 * the same hostname — so there is no second value to keep in step.
 */
function protectedResourceMetadata(request: Request, url: URL): Response | undefined {
  const WellKnown = "/.well-known/oauth-protected-resource";
  if (url.pathname !== WellKnown && url.pathname !== `${WellKnown}${ENDPOINT}`) return undefined;

  // Browsers fetch this: claude.ai runs discovery from a page, not a server.
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { ...headers, allow: "GET, HEAD, OPTIONS" },
    });
  }

  const origin = new URL(url.origin);
  origin.protocol = "https:";
  return new Response(
    JSON.stringify({
      resource: new URL(ENDPOINT, origin).href,
      // Elsewhere this repo aliases snake_case away at the boundary it enters
      // (see `AS hasAttachments` in src/search.ts). A wire format published by
      // a spec has no such boundary — renaming it makes the document wrong.
      // biome-ignore lint/style/useNamingConvention: RFC 9728 names this field.
      authorization_servers: [origin.origin],
    }),
    { headers },
  );
}
