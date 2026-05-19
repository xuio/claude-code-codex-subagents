import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { createDebugBundle, recordDiagnosticEvent } from "../src/diagnostics.js";
import {
  configuredLogLevel,
  configuredLogProfile,
  logger,
  rawTrafficRedacts,
  resetLogWriterForTest,
  setLogWriterForTest,
  summarizeRawTrafficForLog,
} from "../src/logging.js";

afterEach(() => {
  resetLogWriterForTest();
  delete process.env.CODEX_SUBAGENTS_LOG_PROFILE;
  delete process.env.CODEX_SUBAGENTS_LOG_LEVEL;
  delete process.env.CODEX_SUBAGENTS_LOG_RAW_REDACT;
  delete process.env.CODEX_SUBAGENTS_LOG_MAX_STRING_CHARS;
  delete process.env.CODEX_SUBAGENTS_DEBUG_BUNDLE_DIR;
});

describe("logging", () => {
  it("defaults to debug logging", () => {
    expect(configuredLogProfile({})).toBe("debug");
    expect(configuredLogLevel({})).toBe("debug");
    expect(rawTrafficRedacts({})).toBe(false);
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

  it("redacts raw traffic by default in production logging profile", () => {
    process.env.CODEX_SUBAGENTS_LOG_PROFILE = "production";
    const lines: string[] = [];
    setLogWriterForTest((line) => lines.push(line));

    logger.rawInfo("mcp.tool.call", {
      arguments: summarizeRawTrafficForLog({
        prompt: "inspect with CANARY_TOKEN=raw-production-canary",
      }),
    });

    expect(configuredLogLevel(process.env)).toBe("info");
    expect(rawTrafficRedacts(process.env)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("raw-production-canary");
    expect(JSON.parse(lines[0]!).event).toBe("mcp.tool.call");
  });

  it("writes a bounded debug bundle with recent diagnostic events", async () => {
    recordDiagnosticEvent({
      severity: "error",
      source: "test",
      message: "debug bundle canary",
      correlationId: "tool-test",
      recovery: { reason: "test" },
    });

    const bundle = await createDebugBundle({ status: { ok: true } });
    const parsed = JSON.parse(await readFile(bundle.diagnosticsPath, "utf8"));
    expect(parsed.status.ok).toBe(true);
    expect(parsed.recentDiagnostics.some((event: { message?: string }) => event.message === "debug bundle canary")).toBe(true);
    await rm(bundle.bundleDir, { recursive: true, force: true });
  });
});
