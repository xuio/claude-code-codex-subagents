import { describe, expect, it } from "vitest";
import { isBrokenStdioError } from "../src/stdio.js";

describe("stdio failure detection", () => {
  it("recognizes broken pipe and destroyed stream errors", () => {
    expect(isBrokenStdioError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isBrokenStdioError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))).toBe(true);
    expect(isBrokenStdioError(Object.assign(new Error("stream has been destroyed"), { code: "ERR_STREAM_DESTROYED" }))).toBe(true);
    expect(isBrokenStdioError(new Error("Broken pipe"))).toBe(true);
    expect(isBrokenStdioError(new Error("write after end"))).toBe(true);
  });

  it("does not classify ordinary runtime errors as stdio disconnects", () => {
    expect(isBrokenStdioError(new Error("RunValidationError: bad reasoning"))).toBe(false);
    expect(isBrokenStdioError(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(false);
    expect(isBrokenStdioError("EPIPE")).toBe(false);
  });
});
