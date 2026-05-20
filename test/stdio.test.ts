import { describe, expect, it } from "vitest";
import { isBrokenStdioError, updateOrphanWatchdogState } from "../src/stdio.js";

describe("stdio failure detection", () => {
  it("recognizes broken pipe and destroyed stream errors", () => {
    expect(isBrokenStdioError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenStdioError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(true);
    expect(isBrokenStdioError(Object.assign(new Error("stream has been destroyed"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isBrokenStdioError(new Error("Broken pipe"))).toBe(true);
    expect(isBrokenStdioError(new Error("Channel closed"))).toBe(true);
    expect(isBrokenStdioError(new Error("Socket closed"))).toBe(true);
    expect(isBrokenStdioError(new Error("write after end"))).toBe(true);
  });

  it("does not classify ordinary runtime errors as stdio disconnects", () => {
    expect(isBrokenStdioError(new Error("RunValidationError: bad reasoning"))).toBe(false);
    expect(isBrokenStdioError(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(false);
    expect(isBrokenStdioError("EPIPE")).toBe(false);
  });

  it("only trips the orphan watchdog after the grace period", () => {
    expect(updateOrphanWatchdogState({
      parentPid: 123,
      nowMs: 1_000,
      graceMs: 500,
    })).toEqual({ shouldExit: false });

    const first = updateOrphanWatchdogState({
      parentPid: 1,
      nowMs: 1_000,
      graceMs: 500,
    });
    expect(first).toEqual({ orphanSinceMs: 1_000, shouldExit: false });

    expect(updateOrphanWatchdogState({
      parentPid: 1,
      nowMs: 1_499,
      previousOrphanSinceMs: first.orphanSinceMs,
      graceMs: 500,
    })).toEqual({ orphanSinceMs: 1_000, shouldExit: false });

    expect(updateOrphanWatchdogState({
      parentPid: 1,
      nowMs: 1_500,
      previousOrphanSinceMs: first.orphanSinceMs,
      graceMs: 500,
    })).toEqual({ orphanSinceMs: 1_000, shouldExit: true });
  });
});
