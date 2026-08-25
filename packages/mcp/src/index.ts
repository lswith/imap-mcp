/**
 * MCP server — a stateless reader over the index the sync worker builds.
 *
 * It holds no IMAP connection and no mailbox credential: reads come from D1,
 * and writes will be proxied to the sync worker over a service binding (#12).
 * Keeping it that way is what confines the app-specific password to one worker.
 *
 * wrangler.jsonc declares no route and disables workers_dev and preview_urls,
 * so a deploy of this worker is unreachable rather than unauthenticated. With
 * no folder fence, this endpoint is functionally read access to the whole
 * mailbox, so it stays that way until Cloudflare Access sits in front of it
 * (#10).
 */

import {
  createMcpHandler,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createServer } from "./server";

/** The one path this worker serves. Everything else is a 404, not a handler. */
const ENDPOINT = "/mcp";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
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
    // while a page on another site sends its own and is turned away. #10
    // revisits this when Access decides who may reach a deployed instance.
    const rejected = originValidationResponse(request, localhostAllowedOrigins());
    if (rejected) return rejected;

    // Built per request, deliberately. The factory `createMcpHandler` calls is
    // handed no `env`, so a handler held at module scope would close over
    // whichever `env` happened to arrive first. Constructing it here is a
    // couple of cheap objects, and it is the honest shape of a server that
    // holds nothing between requests.
    return createMcpHandler(() => createServer(env)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
