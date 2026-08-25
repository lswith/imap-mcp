/**
 * The MCP server itself: what a client sees, and nothing more.
 *
 * One tool for now. `get_message` and `get_thread` are #11, and the write tools
 * that reach the mailbox through a service binding are #12 — this worker holds
 * no IMAP connection and no mailbox credential, which is what confines the
 * app-specific password to the sync worker.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, searchMessages } from "./search";
import { renderResults } from "./untrusted";

const NAME = "imap-mcp";
const VERSION = "0.1.0";

/**
 * What the model is told the tool does.
 *
 * The limits are in the text on purpose. A model that does not know it will
 * never be given a message body keeps widening the query hoping for one, and a
 * model that does not know this is keyword matching keeps phrasing questions
 * instead of naming words.
 */
const DESCRIPTION = [
  "Search the indexed mailbox by keyword and return matching messages.",
  "",
  "Matching is keyword-based over a local full-text index of message subjects and",
  "bodies — not semantic, and not a live mailbox search. Give words that would",
  "appear in the message. Quote a phrase to require it verbatim, and end a word",
  "with * to match it as a prefix.",
  "",
  "Results are snippets and identifiers only. Message bodies are never returned by",
  "this tool, and the number of results is capped, so narrow a broad search with",
  "the folder, from, since and until filters rather than by asking for more.",
].join("\n");

const INPUT = z.object({
  query: z
    .string()
    .describe("Keywords to match. Quote a phrase to require it verbatim; trail a * for a prefix."),
  folder: z.string().optional().describe("Restrict to one folder, by its full IMAP path."),
  from: z.string().optional().describe("Restrict to senders whose address contains this text."),
  since: z.string().optional().describe("Only messages received on or after this ISO date."),
  until: z.string().optional().describe("Only messages received on or before this ISO date."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many results to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`),
});

/**
 * A server instance for one request.
 *
 * `createMcpHandler` calls this per request and hands it no `env`, so the
 * binding arrives by closure from the fetch handler — see src/index.ts.
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });

  server.registerTool(
    "search_messages",
    {
      title: "Search messages",
      description: DESCRIPTION,
      inputSchema: INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const outcome = await searchMessages(env.DB, input);
      if (!outcome.ok) {
        return { isError: true, content: [{ type: "text", text: outcome.reason }] };
      }
      return { content: [{ type: "text", text: renderResults(outcome.hits, outcome.more) }] };
    },
  );

  return server;
}
