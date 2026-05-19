import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loggingDiagnostics } from "./logging.js";
import { redactJsonValue } from "./redaction.js";

export type DiagnosticSeverity = "info" | "warn" | "error";

export interface DiagnosticEvent {
  id: string;
  ts: string;
  severity: DiagnosticSeverity;
  source: string;
  message: string;
  correlationId?: string;
  tool?: string;
  sessionId?: string;
  jobId?: string;
  codexBinary?: string;
  recovery?: unknown;
  detail?: unknown;
}

const events: DiagnosticEvent[] = [];

function maxEvents(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_DIAGNOSTIC_EVENTS);
  if (!Number.isInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 1_000);
}

function makeId(): string {
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function recordDiagnosticEvent(
  event: Omit<DiagnosticEvent, "id" | "ts">,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticEvent {
  const entry: DiagnosticEvent = {
    id: makeId(),
    ts: new Date().toISOString(),
    ...event,
    detail: event.detail === undefined ? undefined : redactJsonValue(event.detail),
  };
  events.push(entry);
  const limit = maxEvents(env);
  while (events.length > limit) events.shift();
  return entry;
}

export function recentDiagnosticEvents(limit = 50): DiagnosticEvent[] {
  return events.slice(-Math.max(0, Math.min(limit, events.length)));
}

export function diagnosticStats(): Record<string, unknown> {
  return {
    retainedEvents: events.length,
    recentErrors: events.filter((event) => event.severity === "error").length,
    newestEventAt: events.at(-1)?.ts,
  };
}

async function tailFile(file: string, maxBytes = 200_000): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
  } catch {
    return undefined;
  }
}

export async function createDebugBundle(input: {
  session?: unknown;
  job?: unknown;
  status?: unknown;
  notes?: string[];
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ bundleDir: string; diagnosticsPath: string }> {
  const env = input.env ?? process.env;
  const base = path.resolve(env.CODEX_SUBAGENTS_DEBUG_BUNDLE_DIR?.trim() || os.tmpdir());
  await mkdir(base, { recursive: true });
  const bundleDir = await mkdtemp(path.join(base, "codex-subagents-debug-"));
  const logFile = env.CODEX_SUBAGENTS_LOG_FILE?.trim();
  const payload = redactJsonValue({
    createdAt: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    platform: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    envKeys: Object.keys(env)
      .filter((key) => key.startsWith("CODEX_SUBAGENTS_") || key.startsWith("CLAUDE_"))
      .sort(),
    logging: loggingDiagnostics(env),
    recentDiagnostics: recentDiagnosticEvents(100),
    status: input.status,
    session: input.session,
    job: input.job,
    notes: input.notes,
    logTail: logFile ? await tailFile(logFile) : undefined,
  });
  const diagnosticsPath = path.join(bundleDir, "diagnostics.json");
  await writeFile(diagnosticsPath, JSON.stringify(payload, null, 2), "utf8");
  return { bundleDir, diagnosticsPath };
}
