import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunOptions } from "./runner.js";

export interface DurableSessionState {
  id: string;
  name?: string;
  status: "active" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  projectDir?: string;
  cwd?: string;
  codexThreadId?: string;
  protocol: "app-server" | "exec";
  turns: number;
  baseOptions: Partial<AgentRunOptions>;
  error?: string;
}

interface SessionStateFile {
  version: 1;
  updatedAt: string;
  sessions: DurableSessionState[];
}

interface SessionStateFilterOptions {
  maxAgeMs?: number;
  dropUnresumable?: boolean;
}

export function defaultSessionStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CODEX_SUBAGENTS_SESSION_STATE_FILE?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".codex-subagents", "sessions.json");
}

export class SessionStateStore {
  readonly file: string;

  constructor(file = defaultSessionStateFile()) {
    this.file = file;
  }

  load(options: SessionStateFilterOptions = {}): DurableSessionState[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SessionStateFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return [];
      return parsed.sessions
        .filter(isDurableSessionState)
        .filter((session) => keepDurableSessionState(session, options));
    } catch {
      return [];
    }
  }

  save(sessions: DurableSessionState[], options: { replaceIds?: Iterable<string> } & SessionStateFilterOptions = {}): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const replaceIds = new Set(options.replaceIds ?? sessions.map((session) => session.id));
    const merged = [
      ...this.load(options).filter((session) => !replaceIds.has(session.id)),
      ...sessions,
    ];
    const payload: SessionStateFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: merged,
    };
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}

function isDurableSessionState(value: unknown): value is DurableSessionState {
  if (!value || typeof value !== "object") return false;
  const session = value as DurableSessionState;
  return (
    typeof session.id === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    (session.protocol === "app-server" || session.protocol === "exec") &&
    Number.isInteger(session.turns) &&
    typeof session.baseOptions === "object" &&
    session.baseOptions !== null
  );
}

function keepDurableSessionState(
  session: DurableSessionState,
  options: SessionStateFilterOptions,
): boolean {
  if (options.dropUnresumable && session.status === "active" && !session.codexThreadId) return false;
  if (options.maxAgeMs !== undefined) {
    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    if (Date.now() - updatedAt > options.maxAgeMs) return false;
  }
  return true;
}

export function durableRunOptions(options: AgentRunOptions): Partial<AgentRunOptions> {
  return {
    name: options.name,
    model: options.model,
    modelPreset: options.modelPreset,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.dangerouslyBypassApprovalsAndSandbox ? "read-only" : options.sandbox,
    dangerouslyBypassApprovalsAndSandbox: false,
    serviceTier: options.serviceTier,
    modelVerbosity: options.modelVerbosity,
    reasoningSummary: options.reasoningSummary,
    cwd: options.cwd,
    projectDir: options.projectDir,
    codexBin: options.codexBin,
    profile: options.profile,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
    includeEvents: options.includeEvents,
    ephemeral: false,
    skipGitRepoCheck: options.skipGitRepoCheck,
    ignoreRules: options.ignoreRules,
    isolatedCodexHome: options.isolatedCodexHome,
    mcpConfigPolicy: options.mcpConfigPolicy === "explicit" ? "inherit_codex" : options.mcpConfigPolicy,
    forwardSensitiveEnv: false,
    idleTimeoutMs: options.idleTimeoutMs,
    spawnTimeoutMs: options.spawnTimeoutMs,
    terminateGraceMs: options.terminateGraceMs,
  };
}
