import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("mcp server", () => {
  it("answers 501 until the MCP handler lands", async () => {
    const response = await SELF.fetch("https://imap-mcp.invalid/mcp", { method: "POST" });

    expect(response.status).toBe(501);
    expect(await response.text()).toContain("Not Implemented");
  });
});
