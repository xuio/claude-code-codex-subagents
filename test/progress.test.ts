import { describe, expect, it } from "vitest";
import { createProgressReporter } from "../src/progress.js";

describe("progress reporter", () => {
  it("does not let stalled progress notifications block tool completion", async () => {
    const reporter = createProgressReporter(
      {
        _meta: { progressToken: "p" },
        sendNotification: () => new Promise(() => {}),
      } as never,
      { sendTimeoutMs: 5 },
    );

    const started = Date.now();
    await reporter.send("stalled progress");
    await reporter.flush();

    expect(Date.now() - started).toBeLessThan(100);
  });

  it("clamps progress values to total and skips duplicate overflow events", async () => {
    const events: Array<{ progress: number; total?: number; message?: string }> = [];
    const reporter = createProgressReporter(
      {
        _meta: { progressToken: "p" },
        sendNotification: async (message: { params: { progress: number; total?: number; message?: string } }) => {
          events.push(message.params);
        },
      } as never,
      { sendTimeoutMs: 50 },
    );

    await reporter.send("one", { total: 2 });
    await reporter.send("two", { total: 2 });
    await reporter.send("three", { total: 2 });
    await reporter.flush();

    expect(events.map((event) => event.progress)).toEqual([1, 2]);
    expect(events.every((event) => event.total === undefined || event.progress <= event.total)).toBe(true);
  });
});
