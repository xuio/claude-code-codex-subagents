import { afterEach, describe, expect, it } from "vitest";
import {
  configuredLogLevel,
  logger,
  resetLogWriterForTest,
  setLogWriterForTest,
  summarizeRawTrafficForLog,
} from "../src/logging.js";

afterEach(() => {
  resetLogWriterForTest();
  delete process.env.CODEX_SUBAGENTS_LOG_LEVEL;
  delete process.env.CODEX_SUBAGENTS_LOG_MAX_STRING_CHARS;
});

describe("logging", () => {
  it("defaults to debug logging", () => {
    expect(configuredLogLevel({})).toBe("debug");
  });

  it("logs raw MCP traffic without redacting prompt-like values", () => {
    const lines: string[] = [];
    setLogWriterForTest((line) => lines.push(line));

    logger.rawDebug("mcp.tool.call", {
      arguments: summarizeRawTrafficForLog({
        prompt: "inspect with CANARY_API_KEY=raw-debug-canary visible in raw MCP traffic",
      }),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CANARY_API_KEY=raw-debug-canary");
    expect(JSON.parse(lines[0]!).event).toBe("mcp.tool.call");
  });

  it("can be disabled with CODEX_SUBAGENTS_LOG_LEVEL=silent", () => {
    process.env.CODEX_SUBAGENTS_LOG_LEVEL = "silent";
    const lines: string[] = [];
    setLogWriterForTest((line) => lines.push(line));

    logger.rawDebug("mcp.tool.call", { arguments: { prompt: "hidden" } });

    expect(lines).toHaveLength(0);
  });
});
