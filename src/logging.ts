import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { redactJsonValue, redactSensitiveText } from "./redaction.js";

export const logLevels = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof logLevels)[number];
export type LogProfile = "debug" | "production";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const sensitiveKeyRe = /(api[_-]?key|token|secret|password|private[_-]?key|cookie|session|credential|auth)/i;

let logWriter: (line: string) => void = (line) => {
  writeDefaultLog(line);
};
let lastLogFileError: string | undefined;

export function configuredLogProfile(env: NodeJS.ProcessEnv = process.env): LogProfile {
  const raw = env.CODEX_SUBAGENTS_LOG_PROFILE?.trim().toLowerCase();
  return raw === "production" ? "production" : "debug";
}

export function configuredLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const fallback = configuredLogProfile(env) === "production" ? "info" : "debug";
  const raw = (env.CODEX_SUBAGENTS_LOG_LEVEL ?? env.CODEX_SUBAGENTS_LOG ?? fallback).trim().toLowerCase();
  if (["0", "false", "off", "none", "quiet", "silent"].includes(raw)) return "silent";
  if (logLevels.includes(raw as LogLevel)) return raw as LogLevel;
  return fallback;
}

export function makeLogId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function fingerprint(text: string): { chars: number; sha256: string } {
  return {
    chars: text.length,
    sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

function maxStringChars(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_LOG_MAX_STRING_CHARS);
  if (!Number.isInteger(parsed) || parsed < 1) return 20_000;
  return Math.min(parsed, 1_000_000);
}

function logFileMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_LOG_FILE_MAX_BYTES);
  if (!Number.isInteger(parsed) || parsed < 1) return 10_000_000;
  return Math.min(parsed, 1_000_000_000);
}

export function rawTrafficRedacts(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEX_SUBAGENTS_LOG_RAW_REDACT?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw ?? "")) return true;
  if (["0", "false", "no", "off"].includes(raw ?? "")) return false;
  return configuredLogProfile(env) === "production";
}

function shorten(text: string, max = maxStringChars()): string | { chars: number; sha256: string; preview: string } {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= max) return redacted;
  return {
    ...fingerprint(redacted),
    preview: redacted.slice(0, 160),
  };
}

function shortenRaw(text: string, max = maxStringChars()): string | { chars: number; sha256: string; preview: string } {
  if (text.length <= max) return text;
  return {
    ...fingerprint(text),
    preview: text.slice(0, max),
  };
}

export function summarizeForLog(value: unknown, key = "", depth = 0): unknown {
  if (sensitiveKeyRe.test(key)) return "[REDACTED]";

  if (typeof value === "string") {
    return shorten(value);
  }

  if (typeof value !== "object" || value === null) return value;
  if (depth >= 5) return "[MaxDepth]";

  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => summarizeForLog(item, key, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      summarizeForLog(childValue, childKey, depth + 1),
    ]),
  );
}

export function summarizeRawTrafficForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return shortenRaw(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 8) return "[MaxDepth]";

  if (Array.isArray(value)) {
    return value.map((item) => summarizeRawTrafficForLog(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      summarizeRawTrafficForLog(childValue, depth + 1),
    ]),
  );
}

export function summarizeCommandArgs(args: string[]): unknown[] {
  return args.map((arg) => shortenRaw(arg));
}

export function errorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return redactJsonValue({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }
  return redactJsonValue({ message: String(error) });
}

function writeLog(
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: Record<string, unknown> = {},
  options: { redact?: boolean } = {},
): void {
  if (levelWeight[level] < levelWeight[configuredLogLevel()]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    component: "codex-subagents",
    pid: process.pid,
    event,
    ...fields,
  };
  const payload = options.redact === false ? entry : redactJsonValue(entry);

  try {
    logWriter(JSON.stringify(payload));
  } catch {
    // Logging must never break MCP traffic or Codex execution.
  }
}

export function log(level: Exclude<LogLevel, "silent">, event: string, fields: Record<string, unknown> = {}): void {
  writeLog(level, event, fields, { redact: true });
}

export function logRaw(level: Exclude<LogLevel, "silent">, event: string, fields: Record<string, unknown> = {}): void {
  writeLog(level, event, fields, { redact: rawTrafficRedacts() });
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
  rawDebug: (event: string, fields?: Record<string, unknown>) => logRaw("debug", event, fields),
  rawInfo: (event: string, fields?: Record<string, unknown>) => logRaw("info", event, fields),
  rawWarn: (event: string, fields?: Record<string, unknown>) => logRaw("warn", event, fields),
  rawError: (event: string, fields?: Record<string, unknown>) => logRaw("error", event, fields),
};

export function setLogWriterForTest(writer: (line: string) => void): void {
  logWriter = writer;
}

export function resetLogWriterForTest(): void {
  lastLogFileError = undefined;
  logWriter = (line) => {
    writeDefaultLog(line);
  };
}

export function loggingDiagnostics(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const logFile = env.CODEX_SUBAGENTS_LOG_FILE?.trim();
  return {
    profile: configuredLogProfile(env),
    level: configuredLogLevel(env),
    rawTrafficRedacted: rawTrafficRedacts(env),
    maxStringChars: maxStringChars(env),
    logFile: logFile || undefined,
    logFileMaxBytes: logFile ? logFileMaxBytes(env) : undefined,
    logFileLastError: lastLogFileError,
  };
}

function writeDefaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
  const logFile = process.env.CODEX_SUBAGENTS_LOG_FILE?.trim();
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    try {
      if (statSync(logFile).size > logFileMaxBytes()) renameSync(logFile, `${logFile}.1`);
    } catch (error) {
      // Missing files or rotation races are harmless.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        lastLogFileError = error instanceof Error ? error.message : String(error);
      }
    }
    appendFileSync(logFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(logFile, 0o600);
    lastLogFileError = undefined;
  } catch (error) {
    lastLogFileError = error instanceof Error ? error.message : String(error);
    // Logging must never break MCP traffic or Codex execution.
  }
}
