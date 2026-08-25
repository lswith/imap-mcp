/**
 * Sync worker — the only part of this system that speaks IMAP.
 *
 * It owns the connection and the app-specific password, so that credential
 * lives in exactly one place: the MCP server reads the index and proxies
 * writes here over a service binding rather than holding a credential of its
 * own.
 *
 * Nothing is implemented yet. The cron handler exists so the worker has a
 * valid entry point and a deploy dry-run passes; the real work lands with the
 * tracer (#5), which connects, selects one folder, fetches a bounded UID range
 * and writes to D1. Queue fan-out follows in #6.
 */
export default {
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    console.log("imap-mcp-sync: no sync implemented yet (#5)");
  },
} satisfies ExportedHandler<Env>;
