/**
 * One Worker, three entry points (#34).
 *
 *   fetch      the MCP server — a stateless reader over the index, gated by
 *              Cloudflare Access (src/mcp/handler.ts)
 *   scheduled  enumerate uids and post ~100-uid ranges to a queue
 *   queue      take one range, fetch it over one IMAP connection, upsert it
 *              (both in src/sync/handlers.ts)
 *
 * The halves used to be two Workers, with writes proxied across a service
 * binding so the internet-facing one held no mailbox credential. They are one
 * Worker now, so the credential and the endpoint share an isolate; what remains
 * of that boundary is the property that actually mattered — the protocol client
 * is imported in exactly one file (src/imap/cf-imap-mailbox.ts, enforced by
 * lint), and every write is policy-checked in src/sync/writes.ts and audited in
 * src/mcp/audit.ts. The supply-chain risk the split defended against is
 * addressed by the four-day minimum release age enforced at install
 * (pnpm-workspace.yaml).
 */

import { handleRequest } from "./mcp/handler";
import { handleQueue, handleScheduled } from "./sync/handlers";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await handleScheduled(controller, env);
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    await handleQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
