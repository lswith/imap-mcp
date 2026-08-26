import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { accessHeaders } from "./support/access";
import { clearIndex, seedMessage } from "./support/seed";

const ENDPOINT = new URL("https://imap-mcp.invalid/mcp");

/**
 * A real MCP client over a real transport, with fetch pointed at this worker.
 *
 * Driving the protocol rather than posting hand-written JSON-RPC is what makes
 * this an end-to-end test: the handshake, the tool schema and the content
 * blocks are all the ones a client would actually negotiate.
 */
async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  // Every request carries an assertion the worker really verifies, because
  // Access sits in front of this endpoint now (#10) and a client that could
  // not present one would never reach a tool at all. The signature is genuine
  // — see test/support/access.ts.
  const headers = await accessHeaders();
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (input, init) =>
        SELF.fetch(input as RequestInfo, {
          ...(init as RequestInit),
          headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
        }),
    }),
  );
  return client;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("mcp server", () => {
  beforeEach(clearIndex);

  it("lists search_messages with the filters the ticket promised", async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find((candidate) => candidate.name === "search_messages");

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "folder",
      "from",
      "limit",
      "query",
      "since",
      "until",
    ]);
    expect(tool?.inputSchema.required).toEqual(["query"]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("answers a search with framed hits from the index", async () => {
    await seedMessage({
      folder: "Archive",
      uid: 9931,
      subject: "Quarterly invoice",
      body: "the shipment arrives Tuesday",
      from: "alice@example.com",
    });

    const result = (await (
      await connect()
    ).callTool({ name: "search_messages", arguments: { query: "shipment" } })) as CallToolResult;

    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("UNTRUSTED");
    expect(text).toMatch(/<mailbox-results nonce="[0-9a-f]+">/);
    expect(text).toContain("Quarterly invoice");
    expect(text).toContain("uid 9931");
  });

  it("passes the structured filters through to the query", async () => {
    await seedMessage({ folder: "Archive", subject: "invoice one", from: "receipts@stripe.com" });
    await seedMessage({ folder: "Archive", subject: "invoice two", from: "alice@example.com" });

    const result = (await (
      await connect()
    ).callTool({
      name: "search_messages",
      arguments: { query: "invoice", folder: "Archive", from: "stripe" },
    })) as CallToolResult;

    expect(textOf(result)).toContain("invoice one");
    expect(textOf(result)).not.toContain("invoice two");
  });

  it("never puts a message body on the wire", async () => {
    await seedMessage({
      subject: "Quarterly invoice",
      body: `shipment ${"filler ".repeat(300)}pineapple-under-the-sea`,
    });

    const result = await (await connect()).callTool({
      name: "search_messages",
      arguments: { query: "shipment" },
    });

    expect(JSON.stringify(result)).not.toContain("pineapple-under-the-sea");
  });

  it("reports an unsearchable query as a tool error rather than failing the call", async () => {
    const result = (await (
      await connect()
    ).callTool({ name: "search_messages", arguments: { query: "-()" } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/keyword/i);
  });

  it("says plainly when nothing matched", async () => {
    await seedMessage({ subject: "Quarterly invoice" });

    const result = (await (
      await connect()
    ).callTool({ name: "search_messages", arguments: { query: "aardvark" } })) as CallToolResult;

    expect(textOf(result)).toMatch(/no messages matched/i);
  });

  it("serves the MCP endpoint and nothing else", async () => {
    const elsewhere = await SELF.fetch("https://imap-mcp.invalid/", { method: "POST" });

    expect(elsewhere.status).toBe(404);
  });

  it("turns away a browser on another origin, and lets a client with none through", async () => {
    const rebound = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(rebound.status).toBe(403);

    // What an MCP client looks like: no Origin at all, and an Access assertion.
    const client = await SELF.fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await accessHeaders()) },
      body: "{}",
    });
    expect(client.status).not.toBe(403);
    expect(client.status).not.toBe(401);
  });
});
