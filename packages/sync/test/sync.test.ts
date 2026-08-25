import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("sync worker", () => {
  it("runs its scheduled handler and does nothing but log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createExecutionContext();

    await worker.scheduled(
      { cron: "0 * * * *", scheduledTime: Date.now(), noRetry: () => {} },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("can load the IMAP interface it will sync with", async () => {
    // Not a placeholder: this is the wiring #5 depends on. It proves the
    // workspace dependency resolves from this worker, inside workerd, with
    // @imap-mcp/imap consumed as TypeScript source rather than a built bundle.
    const { connectMailbox } = await import("@imap-mcp/imap");

    expect(typeof connectMailbox).toBe("function");
  });
});
