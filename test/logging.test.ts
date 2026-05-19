import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  delete process.env.CODEX_SUBAGENTS_LOG_FILE;
  delete process.env.CODEX_SUBAGENTS_LOG_FILE_MAX_BYTES;
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
        api_key: "plain-api-key-canary",
        authorization: "plain-authorization-canary",
        nested: { cookie: "plain-cookie-canary" },
        tokenUsage: { totalTokens: 15 },
      }),
    });

    expect(configuredLogLevel(process.env)).toBe("info");
    expect(rawTrafficRedacts(process.env)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("raw-production-canary");
    expect(lines[0]).not.toContain("plain-api-key-canary");
    expect(lines[0]).not.toContain("plain-authorization-canary");
    expect(lines[0]).not.toContain("plain-cookie-canary");
    expect(lines[0]).toContain("totalTokens");
    expect(JSON.parse(lines[0]!).event).toBe("mcp.tool.call");
  });

  it("writes log files with owner-only permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-logs-"));
    const logFile = path.join(dir, "server.log");
    process.env.CODEX_SUBAGENTS_LOG_FILE = logFile;

    logger.info("test.log_file_mode", { ok: true });

    expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps rotated log files owner-only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-logs-"));
    const logFile = path.join(dir, "server.log");
    process.env.CODEX_SUBAGENTS_LOG_FILE = logFile;
    process.env.CODEX_SUBAGENTS_LOG_FILE_MAX_BYTES = "10";
    await writeFile(logFile, "x".repeat(20), "utf8");
    await chmod(logFile, 0o644);

    logger.info("test.log_rotate_mode", { ok: true });

    expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    expect((await stat(`${logFile}.1`)).mode & 0o777).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a bounded debug bundle with recent diagnostic events and opt-in log tail", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-bundle-"));
    const logFile = path.join(dir, "server.log");
    process.env.CODEX_SUBAGENTS_DEBUG_BUNDLE_DIR = dir;
    process.env.CODEX_SUBAGENTS_LOG_FILE = logFile;
    await writeFile(logFile, `${"x".repeat(250_000)}tail-canary`, "utf8");
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
    expect(parsed.logTail).toBeUndefined();
    expect(parsed.recentDiagnostics.some((event: { message?: string }) => event.message === "debug bundle canary")).toBe(true);
    await rm(bundle.bundleDir, { recursive: true, force: true });

    const withTail = await createDebugBundle({ status: { ok: true }, includeLogTail: true });
    const parsedWithTail = JSON.parse(await readFile(withTail.diagnosticsPath, "utf8"));
    expect(parsedWithTail.logTail).toContain("tail-canary");
    expect(parsedWithTail.logTail.length).toBeLessThanOrEqual(200_000);
    await rm(dir, { recursive: true, force: true });
  });
});
