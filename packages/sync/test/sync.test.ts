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
});
