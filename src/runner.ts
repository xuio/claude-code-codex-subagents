import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexBinary, type ResolvedCodexBinary } from "./binary.js";
import {
  type OutputContract,
  outputContracts,
  parseStructuredOutput,
  schemaForOutputContract,
} from "./contracts.js";
import { killChildProcess, trackChildProcess } from "./lifecycle.js";
import {
  errorForLog,
  logger,
  makeLogId,
  summarizeCommandArgs,
  summarizeRawTrafficForLog,
} from "./logging.js";
import { redactJsonValue, redactSensitiveText, sanitizeChildEnv } from "./redaction.js";
import {
  codexSubagentConfigOverrides,
  type McpConfigPolicy,
  modelForPreset,
  mcpConfigPolicies,
  prepareSubagents,
  type CodexSubagentDefinition,
  type ModelPreset,
  type SubagentRuntimeOptions,
  type SubagentTask,
} from "./subagents.js";
import { OutputArtifactWriter, type OutputArtifacts } from "./artifacts.js";

export const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const serviceTiers = ["fast", "flex"] as const;
export const modelVerbosities = ["low", "medium", "high"] as const;
export const reasoningSummaries = ["auto", "concise", "detailed", "none"] as const;
export const sparkModel = "gpt-5.3-codex-spark";
export { mcpConfigPolicies, outputContracts };

const maxPendingJsonLineChars = 1_000_000;

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
  dangerouslyBypassApprovalsAndSandbox?: boolean;
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
  isolatedCodexHome?: boolean;
  mcpConfigPolicy?: McpConfigPolicy;
  codexMcpServers?: Record<string, unknown>;
  forwardSensitiveEnv?: boolean;
  idleTimeoutMs?: number;
  spawnTimeoutMs?: number;
  terminateGraceMs?: number;
  outputContract?: OutputContract;
  outputSchema?: Record<string, unknown>;
  resumeSessionId?: string;
  resumeLast?: boolean;
  onSnapshot?: (snapshot: AgentRunPartial) => void;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  codexSubagents?: CodexSubagentDefinition[];
  subagentTasks?: SubagentTask[];
  subagentRuntime?: SubagentRuntimeOptions;
}

export interface AgentRunPartial {
  name?: string;
  status: "starting" | "running" | "timeout" | "cancelled";
  durationMs: number;
  cwd: string;
  stdoutTail: string;
  stderrTail: string;
  lastAgentMessage?: string;
  eventSummary: CodexEventSummary;
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
  status: "completed" | "failed" | "timeout" | "cancelled";
  durationMs: number;
  codexBinary: ResolvedCodexBinary;
  cwd: string;
  model?: string;
  modelPreset?: ModelPreset;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  dangerouslyBypassApprovalsAndSandbox: boolean;
  serviceTier?: ServiceTier;
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
  structuredOutput?: unknown;
  structuredOutputError?: string;
  commandPreview: string[];
  validationError?: string;
  timeoutReason?: "timeout" | "idle_timeout" | "spawn_timeout" | "app_server_no_completion";
  outputArtifacts?: OutputArtifacts;
  queue?: {
    queuedMs: number;
  };
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
          | "dangerouslyBypassApprovalsAndSandbox"
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
          | "isolatedCodexHome"
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

function versionProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_VERSION_TIMEOUT_MS);
  if (!Number.isInteger(parsed) || parsed < 1) return 5_000;
  return Math.min(parsed, 60_000);
}

export function defaultReasoningEffort(env: NodeJS.ProcessEnv = process.env): ReasoningEffort {
  const value = env.CODEX_SUBAGENTS_DEFAULT_REASONING_EFFORT?.trim();
  return value !== "minimal" && reasoningEfforts.includes(value as ReasoningEffort)
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
  return normalizeRequestedModel(options.model) || modelForPreset(options.modelPreset) || defaultModel(env);
}

export function normalizeRequestedModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  if (value === "gpt-5.5-codex") return "gpt-5.5";
  return value;
}

export class RunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunValidationError";
  }
}

export function validateRunConfiguration(
  options: Pick<
    AgentRunOptions,
    | "model"
    | "modelPreset"
    | "reasoningEffort"
    | "reasoningSummary"
    | "sandbox"
    | "dangerouslyBypassApprovalsAndSandbox"
    | "mcpConfigPolicy"
    | "codexMcpServers"
    | "codexSubagents"
  >,
  env: NodeJS.ProcessEnv = process.env,
): {
  model?: string;
  reasoningEffort: ReasoningEffort;
  reasoningSummary?: ReasoningSummary;
} {
  const model = resolveRequestedModel(options, env);
  const reasoningEffort = options.reasoningEffort ?? defaultReasoningEffort(env);
  let reasoningSummary = options.reasoningSummary;

  if (reasoningEffort === "minimal") {
    throw new RunValidationError(
      "reasoning_effort='minimal' is not supported by this plugin because Codex currently auto-attaches web_search, which the API rejects with reasoning.effort 'minimal'. Use reasoning_effort='low' or higher.",
    );
  }

  if (model === sparkModel && reasoningSummary) {
    if (reasoningSummary === "none") {
      reasoningSummary = undefined;
    } else {
      throw new RunValidationError(
        `reasoning_summary='${reasoningSummary}' is not supported with model_preset='spark' (${sparkModel}). Omit reasoning_summary or use reasoning_summary='none'.`,
      );
    }
  }

  if (options.mcpConfigPolicy === "explicit" && Object.keys(options.codexMcpServers ?? {}).length === 0) {
    throw new RunValidationError(
      "mcp_config_policy='explicit' requires codex_mcp_servers with at least one server. Omit mcp_config_policy to inherit Codex config, or provide codex_mcp_servers.",
    );
  }

  if (options.sandbox === "danger-full-access" && !options.dangerouslyBypassApprovalsAndSandbox) {
    throw new RunValidationError(
      "sandbox='danger-full-access' requires dangerously_bypass_approvals_and_sandbox=true. Use sandbox='read-only' by default, or set the explicit bypass flag for full non-sandbox access.",
    );
  }

  const unsafeSubagent = options.codexSubagents?.find((agent) => agent.sandbox === "danger-full-access");
  if (unsafeSubagent && !options.dangerouslyBypassApprovalsAndSandbox) {
    throw new RunValidationError(
      `codex_subagents entry '${unsafeSubagent.name}' uses sandbox='danger-full-access'; set dangerously_bypass_approvals_and_sandbox=true on the parent run to allow full non-sandbox subagents.`,
    );
  }

  return { model, reasoningEffort, reasoningSummary };
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
  options: Omit<AgentRunOptions, "prompt" | "env" | "onSnapshot"> & { outputSchemaPath?: string },
  outputPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const { model, reasoningEffort, reasoningSummary } = validateRunConfiguration(options, env);
  const sandbox = options.sandbox ?? "read-only";
  const bypassSandbox = options.dangerouslyBypassApprovalsAndSandbox ?? false;
  const ephemeral = options.ephemeral ?? true;

  const resume = Boolean(options.resumeSessionId || options.resumeLast);
  const args = resume
    ? [
        "exec",
        "resume",
        "--json",
        "-c",
        `approval_policy=${tomlString("never")}`,
        "-c",
        `model_reasoning_effort=${tomlString(reasoningEffort)}`,
        "--output-last-message",
        outputPath,
      ]
    : [
        "exec",
        "--json",
        "--color",
        "never",
        "-c",
        `approval_policy=${tomlString("never")}`,
        "-c",
        `model_reasoning_effort=${tomlString(reasoningEffort)}`,
        "--output-last-message",
        outputPath,
      ];

  if (bypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (resume) {
    args.push("-c", `sandbox_mode=${tomlString(sandbox)}`);
  } else {
    args.push("--sandbox", sandbox);
  }

  if (model) args.push("--model", model);
  if (!resume && options.profile) args.push("--profile", options.profile);
  if (!resume && options.cwd) args.push("--cd", options.cwd);
  if (ephemeral) args.push("--ephemeral");
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (options.ignoreRules) args.push("--ignore-rules");
  if (!resume && options.outputSchemaPath) args.push("--output-schema", options.outputSchemaPath);
  if (options.modelVerbosity) {
    args.push("-c", `model_verbosity=${tomlString(options.modelVerbosity)}`);
  }
  if (reasoningSummary) {
    args.push("-c", `model_reasoning_summary=${tomlString(reasoningSummary)}`);
  }
  if (options.serviceTier) {
    args.push("-c", `service_tier=${tomlString(options.serviceTier)}`);
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

  if (resume) {
    if (options.resumeLast) args.push("--last");
    else if (options.resumeSessionId) args.push(options.resumeSessionId);
  }
  args.push("-");
  return args;
}

function validationFailureResult(options: {
  started: number;
  error: RunValidationError;
  codexBinary: ResolvedCodexBinary;
  cwd: string;
  runOptions: AgentRunOptions;
  env: NodeJS.ProcessEnv;
}): AgentRunResult {
  const reasoningEffort = options.runOptions.reasoningEffort ?? defaultReasoningEffort(options.env);
  const message = options.error.message;

  return {
    name: options.runOptions.name,
    ok: false,
    status: "failed",
    durationMs: Date.now() - options.started,
    codexBinary: options.codexBinary,
    cwd: options.cwd,
    model: resolveRequestedModel(options.runOptions, options.env),
    modelPreset: options.runOptions.modelPreset,
    reasoningEffort,
    sandbox: options.runOptions.sandbox ?? "read-only",
    dangerouslyBypassApprovalsAndSandbox: Boolean(
      options.runOptions.dangerouslyBypassApprovalsAndSandbox,
    ),
    serviceTier: options.runOptions.serviceTier,
    exitCode: null,
    signal: null,
    finalMessage: "",
    stderr: redactSensitiveText(message),
    stdoutTail: "",
    truncated: {
      stdoutChars: 0,
      stderrChars: 0,
      finalMessageChars: 0,
    },
    eventSummary: {
      counts: {},
      commands: [],
      errors: [redactSensitiveText(message)],
    },
    commandPreview: [],
    validationError: redactSensitiveText(message),
    codexSubagents: {
      customAgents: options.runOptions.codexSubagents?.map((agent) => agent.name) ?? [],
      requestedTasks: options.runOptions.subagentTasks?.length ?? 0,
      tempCodexHomeUsed: false,
    },
  };
}

function baseFailureResult(options: {
  started: number;
  codexBinary: ResolvedCodexBinary;
  cwd: string;
  runOptions: AgentRunOptions;
  env: NodeJS.ProcessEnv;
  message: string;
  status?: "failed" | "timeout" | "cancelled";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}): AgentRunResult {
  const message = options.message;

  return {
    name: options.runOptions.name,
    ok: false,
    status: options.status ?? "failed",
    durationMs: Date.now() - options.started,
    codexBinary: options.codexBinary,
    cwd: options.cwd,
    model: resolveRequestedModel(options.runOptions, options.env),
    modelPreset: options.runOptions.modelPreset,
    reasoningEffort: options.runOptions.reasoningEffort ?? defaultReasoningEffort(options.env),
    sandbox: options.runOptions.sandbox ?? "read-only",
    dangerouslyBypassApprovalsAndSandbox: Boolean(
      options.runOptions.dangerouslyBypassApprovalsAndSandbox,
    ),
    serviceTier: options.runOptions.serviceTier,
    exitCode: options.exitCode ?? null,
    signal: options.signal ?? null,
    finalMessage: "",
    stderr: redactSensitiveText(message),
    stdoutTail: "",
    truncated: {
      stdoutChars: 0,
      stderrChars: 0,
      finalMessageChars: 0,
    },
    eventSummary: {
      counts: {},
      commands: [],
      errors: [redactSensitiveText(message)],
    },
    commandPreview: [],
    codexSubagents: {
      customAgents: options.runOptions.codexSubagents?.map((agent) => agent.name) ?? [],
      requestedTasks: options.runOptions.subagentTasks?.length ?? 0,
      tempCodexHomeUsed: false,
    },
  };
}

export function agentFailureResultForError(
  options: AgentRunOptions,
  error: unknown,
  started = Date.now(),
): AgentRunResult {
  const mergedEnv = { ...process.env, ...options.env };
  let cwd = options.projectDir ?? options.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  try {
    cwd = path.resolve(cwd);
  } catch {
    cwd = process.cwd();
  }
  let codexBinary: ResolvedCodexBinary;
  try {
    codexBinary = resolveCodexBinary({ explicitPath: options.codexBin, env: mergedEnv });
  } catch {
    codexBinary = {
      path: options.codexBin ?? "codex",
      source: options.codexBin ? "explicit" : "PATH",
    };
  }
  return baseFailureResult({
    started,
    codexBinary,
    cwd,
    runOptions: options,
    env: mergedEnv,
    message: error instanceof Error ? error.message : String(error),
    status: "failed",
  });
}

function cloneEventSummary(summary: CodexEventSummary): CodexEventSummary {
  return redactJsonValue({
    counts: { ...summary.counts },
    threadId: summary.threadId,
    usage: summary.usage,
    commands: summary.commands.map((command) => ({ ...command })),
    errors: [...summary.errors],
    lastAgentMessage: summary.lastAgentMessage,
    events: summary.events ? [...summary.events] : undefined,
  });
}

function parseJsonLine(line: string, summary: CodexEventSummary): void {
  if (!line.trim()) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    if (line.length >= maxPendingJsonLineChars) {
      summary.errors.push(
        `Codex stdout JSONL line exceeded ${maxPendingJsonLineChars} chars; dropped or ignored data from an unterminated line.`,
      );
    }
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
  const runId = makeLogId("run");
  const started = Date.now();
  const maxOutputChars = options.maxOutputChars ?? 60_000;
  logger.rawDebug("agent.run.start", {
    runId,
    options: summarizeRawTrafficForLog({
      prompt: options.prompt,
      name: options.name,
      model: options.model,
      modelPreset: options.modelPreset,
      reasoningEffort: options.reasoningEffort,
      sandbox: options.sandbox,
      dangerouslyBypassApprovalsAndSandbox: options.dangerouslyBypassApprovalsAndSandbox,
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
      ephemeral: options.ephemeral,
      skipGitRepoCheck: options.skipGitRepoCheck,
      ignoreRules: options.ignoreRules,
      isolatedCodexHome: options.isolatedCodexHome,
      mcpConfigPolicy: options.mcpConfigPolicy,
      codexMcpServers: options.codexMcpServers,
      forwardSensitiveEnv: options.forwardSensitiveEnv,
      idleTimeoutMs: options.idleTimeoutMs,
      spawnTimeoutMs: options.spawnTimeoutMs,
      terminateGraceMs: options.terminateGraceMs,
      outputContract: options.outputContract,
      outputSchema: options.outputSchema,
      resumeSessionId: options.resumeSessionId,
      resumeLast: options.resumeLast,
      codexSubagents: options.codexSubagents,
      subagentTasks: options.subagentTasks,
      subagentRuntime: options.subagentRuntime,
    }),
  });
  const mergedEnv = {
    ...process.env,
    ...options.env,
  };
  const cwd = await resolveWorkingDirectory(options.projectDir ?? options.cwd, mergedEnv);
  const codexBinary = resolveCodexBinary({
    explicitPath: options.codexBin,
    env: mergedEnv,
  });
  logger.debug("agent.run.resolved", { runId, cwd, codexBinary });
  if (options.abortSignal?.aborted) {
    logger.warn("agent.run.cancelled_before_start", { runId });
    return baseFailureResult({
      started,
      codexBinary,
      cwd,
      runOptions: options,
      env: mergedEnv,
      message: "Codex run was cancelled before it started.",
      status: "cancelled",
    });
  }
  try {
    validateRunConfiguration(options, mergedEnv);
  } catch (error) {
    if (error instanceof RunValidationError) {
      logger.error("agent.run.validation_failed", { runId, error: errorForLog(error) });
      return validationFailureResult({
        started,
        error,
        codexBinary,
        cwd,
        runOptions: options,
        env: mergedEnv,
      });
    }
    throw error;
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-"));
  const artifactWriter = new OutputArtifactWriter(runId, mergedEnv);
  const preparedSubagents = await prepareSubagents({
    definitions: options.codexSubagents,
    tasks: options.subagentTasks,
    env: options.env,
    isolatedCodexHome: options.isolatedCodexHome,
    mcpConfigPolicy: options.mcpConfigPolicy,
    codexMcpServers: options.codexMcpServers,
    projectDir: cwd,
    allowDangerFullAccess: Boolean(options.dangerouslyBypassApprovalsAndSandbox),
  });
  logger.debug("agent.run.subagents_prepared", {
    runId,
    customAgents: preparedSubagents.names,
    tempCodexHomeUsed: Boolean(preparedSubagents.tempCodexHome),
  });
  const childEnv = sanitizeChildEnv({ ...mergedEnv, ...preparedSubagents.env }, options.forwardSensitiveEnv);
  const outputPath = path.join(tempDir, "last-message.md");
  const outputSchema = schemaForOutputContract(options.outputContract, options.outputSchema);
  const outputSchemaPath =
    outputSchema && !options.resumeSessionId && !options.resumeLast
      ? path.join(tempDir, "output-schema.json")
      : undefined;
  if (outputSchemaPath) await writeFile(outputSchemaPath, JSON.stringify(outputSchema), "utf8");
  const args = buildCodexExecArgs({ ...options, cwd, outputSchemaPath }, outputPath, childEnv);
  logger.rawDebug("codex.spawn", {
    runId,
    binary: codexBinary,
    cwd,
    args: summarizeCommandArgs(args),
  });
  const stdout = new LimitedText(maxOutputChars);
  const stderr = new LimitedText(Math.min(maxOutputChars, 20_000));
  const summary: CodexEventSummary = {
    counts: {},
    commands: [],
    errors: [],
    events: options.includeEvents ? [] : undefined,
  };
  let pendingLine = "";
  let pendingLineOverflowReported = false;
  let timedOut = false;
  let timeoutReason: "timeout" | "idle_timeout" | "spawn_timeout" | undefined;
  let cancelled = false;
  let timeout: NodeJS.Timeout | undefined;
  let idleTimeout: NodeJS.Timeout | undefined;
  let spawnTimeout: NodeJS.Timeout | undefined;
  let killTimeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  let lastSnapshotAt = 0;

  try {
    const child = spawn(codexBinary.path, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    trackChildProcess(child, { label: "codex-exec", id: runId });
    logger.debug("codex.process.created", { runId, childPid: child.pid });

    const makeSnapshot = (status: AgentRunPartial["status"]): AgentRunPartial => ({
      name: options.name,
      status,
      durationMs: Date.now() - started,
      cwd,
      stdoutTail: redactSensitiveText(stdout.text()),
      stderrTail: redactSensitiveText(stderr.text()),
      lastAgentMessage: summary.lastAgentMessage
        ? redactSensitiveText(summary.lastAgentMessage)
        : undefined,
      eventSummary: cloneEventSummary(summary),
    });

    const publishSnapshot = (force = false) => {
      if (!options.onSnapshot) return;
      const now = Date.now();
      if (!force && now - lastSnapshotAt < 500) return;
      lastSnapshotAt = now;
      options.onSnapshot(makeSnapshot(cancelled ? "cancelled" : timedOut ? "timeout" : "running"));
    };

    const requestKill = (reason: "timeout" | "idle_timeout" | "spawn_timeout" | "cancelled") => {
      logger.warn("codex.process.kill_requested", { runId, reason });
      if (reason === "timeout" || reason === "idle_timeout" || reason === "spawn_timeout") {
        timedOut = true;
        timeoutReason = reason;
      } else {
        cancelled = true;
      }

      killChildProcess(child, "SIGTERM");
      if (!killTimeout) {
        killTimeout = setTimeout(() => killChildProcess(child, "SIGKILL"), options.terminateGraceMs ?? 2_000);
        killTimeout.unref();
      }
      publishSnapshot(true);
    };

    abortHandler = () => requestKill("cancelled");
    options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    if (options.abortSignal?.aborted) requestKill("cancelled");

    const timeoutMs = options.timeoutMs ?? 600_000;
    const resetIdleTimeout = () => {
      if (!options.idleTimeoutMs) return;
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => requestKill("idle_timeout"), options.idleTimeoutMs);
      idleTimeout.unref();
    };
    resetIdleTimeout();
    spawnTimeout = setTimeout(() => requestKill("spawn_timeout"), options.spawnTimeoutMs ?? 10_000);
    spawnTimeout.unref();
    child.once("spawn", () => {
      logger.debug("codex.process.spawned", { runId, childPid: child.pid });
      if (spawnTimeout) clearTimeout(spawnTimeout);
      publishSnapshot(true);
    });
    timeout = setTimeout(() => {
      requestKill("timeout");
    }, timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      logger.rawDebug("codex.stdout", {
        runId,
        chunk: summarizeRawTrafficForLog(chunk),
      });
      artifactWriter.appendStdout(chunk);
      resetIdleTimeout();
      stdout.append(chunk);
      publishSnapshot(true);
      pendingLine += chunk;
      if (pendingLine.length > maxPendingJsonLineChars) {
        const dropped = pendingLine.length - maxPendingJsonLineChars;
        pendingLine = pendingLine.slice(-maxPendingJsonLineChars);
        if (!pendingLineOverflowReported) {
          pendingLineOverflowReported = true;
          const message = `Codex stdout JSONL line exceeded ${maxPendingJsonLineChars} chars; dropped leading data from an unterminated line.`;
          summary.errors.push(message);
          logger.warn("codex.stdout_line_oversized", { runId, droppedChars: dropped, maxPendingJsonLineChars });
        }
      }
      let newlineIndex = pendingLine.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingLine.slice(0, newlineIndex);
        pendingLine = pendingLine.slice(newlineIndex + 1);
        parseJsonLine(line, summary);
        publishSnapshot();
        newlineIndex = pendingLine.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      logger.rawDebug("codex.stderr", {
        runId,
        chunk: summarizeRawTrafficForLog(chunk),
      });
      artifactWriter.appendStderr(chunk);
      resetIdleTimeout();
      stderr.append(chunk);
      publishSnapshot(true);
    });

    child.stdin.on("error", (error: Error) => {
      logger.error("codex.stdin.error", { runId, error: errorForLog(error) });
      summary.errors.push(`Codex stdin error: ${error.message}`);
    });

    try {
      const prompt = `${preparedSubagents.promptPrefix}${options.prompt}`;
      logger.rawDebug("codex.stdin", {
        runId,
        prompt: summarizeRawTrafficForLog(prompt),
      });
      child.stdin.end(prompt);
    } catch (error) {
      logger.error("codex.stdin.write_failed", { runId, error: errorForLog(error) });
      summary.errors.push(
        `Codex stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { exitCode, signal, spawnError } = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      spawnError?: Error;
    }>((resolve) => {
      child.once("error", (error) => {
        logger.error("codex.process.error", { runId, error: errorForLog(error) });
        resolve({ exitCode: null, signal: null, spawnError: error });
      });
      child.once("close", (code, signalValue) => {
        logger.debug("codex.process.closed", { runId, exitCode: code, signal: signalValue });
        resolve({ exitCode: code, signal: signalValue });
      });
    });

    if (pendingLine.trim()) parseJsonLine(pendingLine, summary);
    publishSnapshot(true);

    if (timeout) clearTimeout(timeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    if (spawnTimeout) clearTimeout(spawnTimeout);
    if (killTimeout) clearTimeout(killTimeout);
    if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);

    if (spawnError) {
      logger.error("agent.run.spawn_failed", { runId, error: errorForLog(spawnError) });
      return baseFailureResult({
        started,
        codexBinary,
        cwd,
        runOptions: options,
        env: childEnv,
        message: redactSensitiveText(`Failed to start Codex: ${spawnError.message}`),
        status: "failed",
      });
    }

    let finalMessage = summary.lastAgentMessage ?? "";
    try {
      finalMessage = await readFile(outputPath, "utf8");
    } catch {
      // Codex may fail before creating the last-message file; use the last JSONL agent message.
    }

    const wantsStructuredOutput = Boolean(
      outputSchema || (options.outputContract && options.outputContract !== "freeform"),
    );
    const structured =
      wantsStructuredOutput
        ? parseStructuredOutput(finalMessage)
        : { value: undefined, error: undefined };
    const final = truncate(redactSensitiveText(finalMessage), maxOutputChars);
    const outputArtifacts = artifactWriter.finish({
      finalMessage,
      keep: final.truncatedChars > 0 || stdout.truncated() > 0 || stderr.truncated() > 0,
    });
    const redactedSummary = cloneEventSummary(summary);
    const redactedStructuredOutput = structured.value === undefined ? undefined : redactJsonValue(structured.value);
    const status = cancelled
      ? "cancelled"
      : timedOut
        ? "timeout"
        : exitCode === 0 && !(wantsStructuredOutput && structured.error)
          ? "completed"
          : "failed";
    logger[status === "completed" ? "rawInfo" : "rawError"]("agent.run.finish", {
      runId,
      status,
      durationMs: Date.now() - started,
      exitCode,
      signal,
      timeoutReason,
      finalMessage: summarizeRawTrafficForLog(finalMessage),
      stderr: summarizeRawTrafficForLog(stderr.text()),
      stdoutTail: summarizeRawTrafficForLog(stdout.text()),
      eventSummary: summarizeRawTrafficForLog(summary),
      structuredOutput: summarizeRawTrafficForLog(structured.value),
      structuredOutputError: structured.error,
      truncated: {
        stdoutChars: stdout.truncated(),
        stderrChars: stderr.truncated(),
        finalMessageChars: final.truncatedChars,
      },
      outputArtifacts,
    });

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
      dangerouslyBypassApprovalsAndSandbox: Boolean(
        options.dangerouslyBypassApprovalsAndSandbox,
      ),
      serviceTier: options.serviceTier,
      exitCode,
      signal,
      finalMessage: final.text,
      stderr: redactSensitiveText(stderr.text()),
      stdoutTail: redactSensitiveText(stdout.text()),
      truncated: {
        stdoutChars: stdout.truncated(),
        stderrChars: stderr.truncated(),
        finalMessageChars: final.truncatedChars,
      },
      eventSummary: redactedSummary,
      structuredOutput: redactedStructuredOutput,
      structuredOutputError: structured.error,
      commandPreview: [codexBinary.path, ...args.filter((arg) => arg !== options.prompt)],
      timeoutReason,
      outputArtifacts,
      codexSubagents: {
        customAgents: preparedSubagents.names,
        requestedTasks: options.subagentTasks?.length ?? 0,
        tempCodexHomeUsed: Boolean(preparedSubagents.tempCodexHome),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    if (spawnTimeout) clearTimeout(spawnTimeout);
    if (killTimeout) clearTimeout(killTimeout);
    if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    artifactWriter.discard();
    await preparedSubagents.cleanup().catch(() => {});
  }
}

export async function probeCodexVersion(
  codexBin?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { timeoutMs?: number } = {},
): Promise<{ binary: ResolvedCodexBinary; version?: string; error?: string }> {
  const binary = resolveCodexBinary({ explicitPath: codexBin, env });
  const version = await new Promise<{ version?: string; error?: string }>((resolve) => {
    let settled = false;
    const finish = (result: { version?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const output = new LimitedText(20_000);
    const errorOutput = new LimitedText(20_000);
    const timeoutMs = options.timeoutMs ?? versionProbeTimeoutMs(env);
    const child = spawn(binary.path, ["--version"], {
      env: sanitizeChildEnv({ ...process.env, ...env }, false),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    trackChildProcess(child, { label: "codex-version", id: binary.path });
    const timeout = setTimeout(() => {
      killChildProcess(child, "SIGTERM");
      finish({ error: `Codex version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output.append(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput.append(chunk);
    });
    child.once("error", (error) => finish({ error: error.message }));
    child.once("close", (code) => {
      const stdoutText = output.text().trim();
      const stderrText = errorOutput.text().trim();
      const truncated =
        output.truncated() || errorOutput.truncated()
          ? ` [truncated stdout=${output.truncated()} stderr=${errorOutput.truncated()} chars]`
          : "";
      if (code === 0) finish({ version: `${stdoutText || stderrText}${truncated}`.trim() });
      else finish({ error: `${stderrText || stdoutText || `Exited with code ${code}`}${truncated}`.trim() });
    });
  });

  return { binary, ...version };
}
