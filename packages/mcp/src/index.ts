/**
 * MCP server — a stateless reader over the index the sync worker builds.
 *
 * It holds no IMAP connection and no mailbox credential: reads come from D1
 * and R2, and writes are proxied to the sync worker over a service binding
 * (#12). Keeping it that way is what confines the app-specific password to one
 * worker.
 *
 * Nothing is implemented yet. This handler exists so the worker has a valid
 * entry point and a deploy dry-run passes. The real server — Streamable HTTP
 * via `createMcpHandler`, with `search_messages` — lands in #7, and Cloudflare
 * Access gates it in #10.
 *
 * Until then wrangler.jsonc declares no route and disables workers_dev and
 * preview_urls, so a deploy of this worker is unreachable rather than
 * unauthenticated.
 */
export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("Not Implemented\n", {
      status: 501,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
