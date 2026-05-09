import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexBinary, type ResolvedCodexBinary } from "./binary.js";
import {
  codexSubagentConfigOverrides,
  modelForPreset,
  prepareSubagents,
  type CodexSubagentDefinition,
  type ModelPreset,
  type SubagentRuntimeOptions,
  type SubagentTask,
} from "./subagents.js";

export const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const serviceTiers = ["fast", "flex"] as const;
export const modelVerbosities = ["low", "medium", "high"] as const;
export const reasoningSummaries = ["auto", "concise", "detailed", "none"] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];
export type SandboxMode = (typeof sandboxModes)[number];
export type ServiceTier = (typeof serviceTiers)[number];
export type ModelVerbosity = (typeof modelVerbosities)[number];
export type ReasoningSummary = (typeof reasoningSummaries)[number];

export interface AgentRunOptions {
  prompt: string;
  name?: string;
  model?: string;
  modelPreset?: ModelPreset;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  serviceTier?: ServiceTier;
  modelVerbosity?: ModelVerbosity;
  reasoningSummary?: ReasoningSummary;
  cwd?: string;
  projectDir?: string;
  codexBin?: string;
  profile?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  includeEvents?: boolean;
  ephemeral?: boolean;
  skipGitRepoCheck?: boolean;
  ignoreRules?: boolean;
  env?: NodeJS.ProcessEnv;
  codexSubagents?: CodexSubagentDefinition[];
  subagentTasks?: SubagentTask[];
  subagentRuntime?: SubagentRuntimeOptions;
}

export interface CodexEventSummary {
  counts: Record<string, number>;
  threadId?: string;
  usage?: unknown;
  commands: Array<{ command?: string; status?: string }>;
  errors: string[];
  lastAgentMessage?: string;
  events?: unknown[];
}

export interface AgentRunResult {
  name?: string;
  ok: boolean;
  status: "completed" | "failed" | "timeout";
  durationMs: number;
  codexBinary: ResolvedCodexBinary;
  cwd: string;
  model?: string;
  modelPreset?: ModelPreset;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  serviceTier: ServiceTier;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalMessage: string;
  stderr: string;
  stdoutTail: string;
  truncated: {
    stdoutChars: number;
    stderrChars: number;
    finalMessageChars: number;
  };
  eventSummary: CodexEventSummary;
  commandPreview: string[];
  codexSubagents: {
    customAgents: string[];
    requestedTasks: number;
    tempCodexHomeUsed: boolean;
  };
}

export interface ParallelRunOptions
  extends Omit<AgentRunOptions, "prompt" | "name" | "model" | "reasoningEffort"> {
  agents: Array<
    Pick<AgentRunOptions, "prompt" | "name" | "model" | "modelPreset" | "reasoningEffort" | "cwd"> &
      Partial<
        Pick<
          AgentRunOptions,
          | "sandbox"
          | "serviceTier"
          | "modelVerbosity"
          | "reasoningSummary"
          | "profile"
          | "timeoutMs"
          | "maxOutputChars"
          | "includeEvents"
          | "ephemeral"
          | "skipGitRepoCheck"
          | "ignoreRules"
          | "codexBin"
          | "projectDir"
          | "codexSubagents"
          | "subagentTasks"
          | "subagentRuntime"
        >
      >
  >;
  maxParallel?: number;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
}

class LimitedText {
  private value = "";
  private truncatedCount = 0;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return;
    const remaining = this.maxChars - this.value.length;
    if (remaining > 0) {
      this.value += chunk.slice(0, remaining);
    }
    if (chunk.length > remaining) {
      this.truncatedCount += chunk.length - Math.max(remaining, 0);
    }
  }

  text(): string {
    return this.value;
  }

  truncated(): number {
    return this.truncatedCount;
  }
}

export function defaultReasoningEffort(env: NodeJS.ProcessEnv = process.env): ReasoningEffort {
  const value = env.CODEX_SUBAGENTS_DEFAULT_REASONING_EFFORT?.trim();
  return reasoningEfforts.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : "medium";
}

export function defaultModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CODEX_SUBAGENTS_DEFAULT_MODEL?.trim();
  if (!value || value.includes("${")) return undefined;
  return value;
}

export function resolveRequestedModel(
  options: Pick<AgentRunOptions, "model" | "modelPreset">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return options.model?.trim() || modelForPreset(options.modelPreset) || defaultModel(env);
}

export async function resolveWorkingDirectory(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const requested = cwd?.trim();
  const claudeProjectDir = env.CLAUDE_PROJECT_DIR?.trim();
  const fallback =
    claudeProjectDir && !claudeProjectDir.includes("${")
      ? claudeProjectDir
      : (process.env.PWD ?? process.cwd());
  const resolved = path.resolve(requested || fallback);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Codex working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexExecArgs(
  options: Omit<AgentRunOptions, "prompt" | "env">,
  outputPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const model = resolveRequestedModel(options, env);
  const reasoningEffort = options.reasoningEffort ?? defaultReasoningEffort(env);
  const sandbox = options.sandbox ?? "read-only";
  const serviceTier = options.serviceTier ?? "fast";
  const ephemeral = options.ephemeral ?? true;

  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    sandbox,
    "-c",
    `approval_policy=${tomlString("never")}`,
    "-c",
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    "-c",
    `service_tier=${tomlString(serviceTier)}`,
    "--output-last-message",
    outputPath,
  ];

  if (model) args.push("--model", model);
  if (options.profile) args.push("--profile", options.profile);
  if (options.cwd) args.push("--cd", options.cwd);
  if (ephemeral) args.push("--ephemeral");
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (options.ignoreRules) args.push("--ignore-rules");
  if (options.modelVerbosity) {
    args.push("-c", `model_verbosity=${tomlString(options.modelVerbosity)}`);
  }
  if (options.reasoningSummary) {
    args.push("-c", `model_reasoning_summary=${tomlString(options.reasoningSummary)}`);
  }
  if (options.subagentRuntime?.maxThreads !== undefined) {
    args.push("-c", `agents.max_threads=${options.subagentRuntime.maxThreads}`);
  }
  if (options.subagentRuntime?.maxDepth !== undefined) {
    args.push("-c", `agents.max_depth=${options.subagentRuntime.maxDepth}`);
  }
  if (options.subagentRuntime?.jobMaxRuntimeSeconds !== undefined) {
    args.push("-c", `agents.job_max_runtime_seconds=${options.subagentRuntime.jobMaxRuntimeSeconds}`);
  }
  for (const override of codexSubagentConfigOverrides(options.codexSubagents)) {
    args.push("-c", override);
  }

  args.push("-");
  return args;
}

function parseJsonLine(line: string, summary: CodexEventSummary): void {
  if (!line.trim()) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    summary.errors.push(`Unparseable Codex JSONL line: ${line.slice(0, 500)}`);
    return;
  }

  const type = typeof event.type === "string" ? event.type : "unknown";
  summary.counts[type] = (summary.counts[type] ?? 0) + 1;
  if (summary.events) summary.events.push(event);

  if (type === "thread.started" && typeof event.thread_id === "string") {
    summary.threadId = event.thread_id;
  }

  if (type === "turn.completed") {
    summary.usage = event.usage;
  }

  if (type === "turn.failed" || type === "error") {
    summary.errors.push(JSON.stringify(event));
  }

  const item = event.item as Record<string, unknown> | undefined;
  if (!item) return;

  if (item.type === "agent_message" && typeof item.text === "string") {
    summary.lastAgentMessage = item.text;
  }

  if (item.type === "command_execution") {
    summary.commands.push({
      command: typeof item.command === "string" ? item.command : undefined,
      status: typeof item.status === "string" ? item.status : undefined,
    });
  }
}

function truncate(text: string, maxChars: number): { text: string; truncatedChars: number } {
  if (text.length <= maxChars) return { text, truncatedChars: 0 };
  return { text: text.slice(0, maxChars), truncatedChars: text.length - maxChars };
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const started = Date.now();
  const maxOutputChars = options.maxOutputChars ?? 60_000;
  const mergedEnv = {
    ...process.env,
    ...options.env,
  };
  const cwd = await resolveWorkingDirectory(options.projectDir ?? options.cwd, mergedEnv);
  const codexBinary = resolveCodexBinary({
    explicitPath: options.codexBin,
    env: mergedEnv,
  });
  const preparedSubagents = await prepareSubagents({
    definitions: options.codexSubagents,
    tasks: options.subagentTasks,
    env: options.env,
  });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-"));
  const childEnv = { ...mergedEnv, ...preparedSubagents.env };
  const outputPath = path.join(tempDir, "last-message.md");
  const args = buildCodexExecArgs({ ...options, cwd }, outputPath, childEnv);
  const stdout = new LimitedText(maxOutputChars);
  const stderr = new LimitedText(Math.min(maxOutputChars, 20_000));
  const summary: CodexEventSummary = {
    counts: {},
    commands: [],
    errors: [],
    events: options.includeEvents ? [] : undefined,
  };
  let pendingLine = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;

  try {
    const child = spawn(codexBinary.path, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const timeoutMs = options.timeoutMs ?? 600_000;
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimeout.unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.append(chunk);
      pendingLine += chunk;
      let newlineIndex = pendingLine.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingLine.slice(0, newlineIndex);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        parseJsonLine(line, summary);
        newlineIndex = pendingLine.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.append(chunk));

    child.stdin.end(`${preparedSubagents.promptPrefix}${options.prompt}`);

    const { exitCode, signal } = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signalValue) => {
        resolve({ exitCode: code, signal: signalValue });
      });
    });

    if (pendingLine.trim()) parseJsonLine(pendingLine, summary);

    if (timeout) clearTimeout(timeout);
    if (killTimeout) clearTimeout(killTimeout);

    let finalMessage = summary.lastAgentMessage ?? "";
    try {
      finalMessage = await readFile(outputPath, "utf8");
    } catch {
      // Codex may fail before creating the last-message file; use the last JSONL agent message.
    }

    const final = truncate(finalMessage, maxOutputChars);
    const status = timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed";

    return {
      name: options.name,
      ok: status === "completed",
      status,
      durationMs: Date.now() - started,
      codexBinary,
      cwd,
      model: resolveRequestedModel(options, childEnv),
      modelPreset: options.modelPreset,
      reasoningEffort: options.reasoningEffort ?? defaultReasoningEffort(childEnv),
      sandbox: options.sandbox ?? "read-only",
      serviceTier: options.serviceTier ?? "fast",
      exitCode,
      signal,
      finalMessage: final.text,
      stderr: stderr.text(),
      stdoutTail: stdout.text(),
      truncated: {
        stdoutChars: stdout.truncated(),
        stderrChars: stderr.truncated(),
        finalMessageChars: final.truncatedChars,
      },
      eventSummary: summary,
      commandPreview: [codexBinary.path, ...args.filter((arg) => arg !== options.prompt)],
      codexSubagents: {
        customAgents: preparedSubagents.names,
        requestedTasks: options.subagentTasks?.length ?? 0,
        tempCodexHomeUsed: Boolean(preparedSubagents.tempCodexHome),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (killTimeout) clearTimeout(killTimeout);
    await rm(tempDir, { recursive: true, force: true });
    await preparedSubagents.cleanup();
  }
}

export async function runAgents(options: ParallelRunOptions): Promise<AgentRunResult[]> {
  const maxParallel = Math.max(
    1,
    Math.min(options.maxParallel ?? Math.min(options.agents.length, 4), 8),
  );
  const results: AgentRunResult[] = new Array(options.agents.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < options.agents.length) {
      const index = next;
      next += 1;
      const agent = options.agents[index];
      if (!agent) continue;
      results[index] = await runAgent({
        ...options,
        ...agent,
        model: agent.model ?? options.defaultModel,
        modelPreset: agent.modelPreset ?? options.modelPreset,
        reasoningEffort: agent.reasoningEffort ?? options.defaultReasoningEffort,
        prompt: agent.prompt,
        name: agent.name ?? `agent-${index + 1}`,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxParallel, options.agents.length) }, worker));
  return results;
}

export async function probeCodexVersion(
  codexBin?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ binary: ResolvedCodexBinary; version?: string; error?: string }> {
  const binary = resolveCodexBinary({ explicitPath: codexBin, env });
  const version = await new Promise<{ version?: string; error?: string }>((resolve) => {
    const child = spawn(binary.path, ["--version"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("close", (code) => {
      if (code === 0) resolve({ version: output.trim() || errorOutput.trim() });
      else resolve({ error: errorOutput.trim() || output.trim() || `Exited with code ${code}` });
    });
  });

  return { binary, ...version };
}
