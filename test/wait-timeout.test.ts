import { describe, expect, it } from "vitest";
import {
  capBlockingWaitTimeout,
  configuredMaxBlockingWaitMs,
  defaultBlockingWaitTimeoutMs,
  hardMaxBlockingWaitTimeoutMs,
  minBlockingWaitTimeoutMs,
} from "../src/wait-timeout.js";

describe("blocking wait timeout caps", () => {
  it("uses a safe default below Claude Desktop's inactivity watchdog", () => {
    expect(configuredMaxBlockingWaitMs({} as NodeJS.ProcessEnv)).toBe(defaultBlockingWaitTimeoutMs);
    expect(defaultBlockingWaitTimeoutMs).toBeLessThan(1_000_000);
  });

  it("caps long requested waits to the configured max", () => {
    expect(
      capBlockingWaitTimeout(10_000, {
        CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS: "50",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      requestedMs: 10_000,
      effectiveMs: 50,
      capped: true,
    });
  });

  it("clamps configured max values to the hard safety ceiling", () => {
    expect(
      configuredMaxBlockingWaitMs({
        CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS: "9000000",
      } as NodeJS.ProcessEnv),
    ).toBe(hardMaxBlockingWaitTimeoutMs);
  });

  it("allows very small test caps without busy looping below the floor", () => {
    expect(
      configuredMaxBlockingWaitMs({
        CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(minBlockingWaitTimeoutMs);
  });
});
