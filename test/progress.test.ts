import { describe, expect, it } from "vitest";
import { createProgressReporter } from "../src/progress.js";

describe("progress reporter", () => {
  it("does not let stalled progress notifications block tool completion", async () => {
    const reporter = createProgressReporter(
      {
        _meta: { progressToken: "p" },
        sendNotification: () => new Promise(() => {}),
      } as never,
      { sendTimeoutMs: 5, enabled: true },
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
      { sendTimeoutMs: 50, enabled: true },
    );

    await reporter.send("one", { total: 2 });
    await reporter.send("two", { total: 2 });
    await reporter.send("three", { total: 2 });
    await reporter.flush();

    expect(events.map((event) => event.progress)).toEqual([1, 2]);
    expect(events.every((event) => event.total === undefined || event.progress <= event.total)).toBe(true);
  });

  it("coalesces rapid progress messages and flushes the latest pending one", async () => {
    const events: Array<{ progress: number; message?: string }> = [];
    const reporter = createProgressReporter(
      {
        _meta: { progressToken: "p" },
        sendNotification: async (message: { params: { progress: number; message?: string } }) => {
          events.push(message.params);
        },
      } as never,
      { sendTimeoutMs: 50, minIntervalMs: 1_000, enabled: true },
    );

    await reporter.send("first");
    await reporter.send("second");
    await reporter.send("third");
    await reporter.flush();

    expect(events.map((event) => event.message)).toEqual(["first", "third"]);
  });

  it("suppresses MCP progress notifications by default", async () => {
    const previous = process.env.CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS;
    delete process.env.CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS;
    const events: unknown[] = [];
    try {
      const reporter = createProgressReporter(
        {
          _meta: { progressToken: "p" },
          sendNotification: async (message: unknown) => {
            events.push(message);
          },
        } as never,
        { sendTimeoutMs: 50 },
      );

      await reporter.send("hidden by default");
      await reporter.flush();

      expect(events).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS;
      else process.env.CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS = previous;
    }
  });
});
