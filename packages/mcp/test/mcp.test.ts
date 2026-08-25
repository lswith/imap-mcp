import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("mcp server", () => {
  it("answers 501 until the MCP handler lands", async () => {
    const response = await SELF.fetch("https://imap-mcp.invalid/mcp", { method: "POST" });

    expect(response.status).toBe(501);
    expect(await response.text()).toContain("Not Implemented");
  });

  it("can search the index it will serve", async () => {
    // Not a placeholder: this is the wiring #7 depends on. It proves this
    // worker binds the same migrated database the sync worker writes, and that
    // the BM25 search path works from here — all while holding no IMAP
    // credential of its own.
    const folder = await env.DB.prepare(
      "INSERT INTO folders (name, uidvalidity) VALUES ('Archive', 100) RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO messages (folder_id, uidvalidity, uid, subject, internal_date, body_text)
       VALUES (?, 100, 1, 'Quarterly invoice', 1700000000000, 'the shipment arrives Tuesday')`,
    )
      .bind(folder!.id)
      .run();

    const hit = await env.DB.prepare(
      `SELECT m.subject, snippet(messages_fts, 1, '[', ']', '...', 6) AS snip
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH 'shipment'
       ORDER BY bm25(messages_fts, 10.0, 1.0)`,
    ).first<{ subject: string; snip: string }>();

    expect(hit!.subject).toBe("Quarterly invoice");
    expect(hit!.snip).toContain("[shipment]");
  });
});
