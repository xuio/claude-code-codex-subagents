import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  mcpConfigPolicies,
  modelVerbosities,
  outputContracts,
  reasoningEfforts,
  reasoningSummaries,
  sandboxModes,
  serviceTiers,
} from "./runner.js";
import { aggregateAgentResults } from "./aggregate.js";
import {
  createDebugBundle,
  diagnosticStats,
  recentDiagnosticEvents,
  recordDiagnosticEvent,
} from "./diagnostics.js";
import { jobManager, runQueuedAgent, runQueuedAgents } from "./jobs.js";
import { cleanupRuntime, lifecycleStats, registerCleanupHandler } from "./lifecycle.js";
import {
  disableStderrLogMirrorForShutdown,
  errorForLog,
  logger,
  loggingDiagnostics,
  makeLogId,
  summarizeRawTrafficForLog,
} from "./logging.js";
import { outputArtifactDiagnostics } from "./artifacts.js";
import {
  agentFallbackErrorText,
  agentResultResponse,
  errorResult,
  firstUsefulLine,
  jsonResult,
  nativeAgentPayload,
  nativeAgentResponse,
  nativeErrorResult,
  nativeTaskGroupResponse,
  nativeTextResult,
  sessionPartialMessage,
  sessionProgressPayload,
  suggestedActionForAgent,
  stringifyResultValue,
  summarizeResultValue,
  visibleAgentAnswer,
} from "./mcp-responses.js";
import { recoveryForAgentResult, recoveryForError, recoveryForWait } from "./recovery.js";
import {
  codexDoctorPayload,
  codexStatusPayload,
  registerResources,
  sessionResourceStatus,
  sessionResourceUri,
} from "./resources.js";
import {
  advancedInputSchema,
  advertisedCodexRoleSchema,
  codexRoleDefaults,
  codexRoleSchema,
  commonInputSchema,
  followupModeSchema,
  frontDoorInputSchema,
  frontDoorParallelTaskSchema,
  jobIdSchema,
  looseRecordSchema,
  modelPresetSchema,
  nativeBaseInputSchema,
  nativeTaskGroupTaskSchema,
  parallelAgentSchema,
  publicReasoningSchema,
  reasoningEffortSchema,
  sessionIdSchema,
  type AdvancedInput,
  type CodexRole,
  type NativeBaseInput,
  type NativeFollowupInput,
  type NativeFollowupMode,
  type NativeTaskGroupItemV3Input,
  type NativeTaskGroupV3Input,
  type NativeTaskV3Input,
  type NativeWaitAnyInput,
  type PublicReasoning,
} from "./schemas.js";
import {
  createProgressReporter,
  progressNotificationsAvailable,
  type ProgressOptions,
  type ProgressReporter,
  type ToolExtra,
} from "./progress.js";
import { isBrokenStdioError, updateOrphanWatchdogState } from "./stdio.js";
import {
  capBlockingWaitTimeout,
  configuredMaxBlockingWaitMs,
  defaultBlockingWaitTimeoutMs,
  hardMaxBlockingWaitTimeoutMs,
  type BlockingWaitTimeout,
} from "./wait-timeout.js";
import {
  compactAgentResultForMcp,
  compactAgentResultsForMcp,
  compactJobSnapshotForMcp,
  compactSessionSnapshotForMcp,
} from "./response.js";
import { sessionManager, type CodexSessionSnapshot, type SessionMilestone } from "./sessions.js";
import { modelPresets } from "./subagents.js";
import { packageVersion } from "./version.js";

const usageGuide = [
  "Claude Code integration guide for codex-subagents:",
  "",
  "Use Codex subagents like Claude's native Task tool when the user needs an independent OpenAI Codex worker. Codex is a frontier model, like Claude, and is especially useful as a more technical, reliability-focused subagent for deep codebase work, server/deployment tasks, complex debugging, and adversarial review. Use this MCP server whenever the user asks Claude to use Codex, OpenAI Codex, Codex subagents, Codex Spark, a Codex second opinion, parallel Codex review, independent Codex codebase analysis, deep technical review, or adversarial validation. You do not need the user to name an MCP tool.",
  "",
  "Tool choice:",
  "- Use codex_task when you want one independent Codex subagent: a frontier-model second opinion, deep technical implementation/review, complex codebase exploration, server/deployment work, or adversarial analysis. It is the Codex equivalent of native Task: description plus prompt, read-only by default, and answer-first result.",
  "- Use multiple codex_task calls in parallel when investigations are independent and Claude can synthesize the answers itself.",
  "- Use codex_task_group when the work can be split into independent concurrent Codex tasks and Claude wants one combined response with rolled-up per-task findings.",
  "- Use codex_followup when Claude already has a session_id from codex_task or codex_task_group and wants to continue, steer, wait on, or cancel that same Codex context. This is a Codex-specific multi-turn extension; wait/cancel correspond to native TaskOutput/TaskStop-style operations.",
  "- Set codex_task background true for long-running work so Claude gets a session_id immediately, then use codex_wait_any for several sessions or codex_followup mode wait, steer, or cancel for one session.",
  "- Prefer codex_followup mode wait and codex_wait_any for completion. Subscribe to or read codex://sessions/{session_id} only when resource access is available and Claude needs progress milestones or completion state.",
  "- Diagnostics are resources by default: read codex://status, codex://doctor, or codex://usage when a prior call failed or availability is uncertain. If Claude asks for a resource server id, use plugin:codex-subagents:codex-subagents, not the mcp__... tool prefix or a stale plain codex-subagents server.",
  "- Debug tools such as codex_status, codex_doctor, codex_usage_guide, codex_choose_tool, and codex_export_debug_bundle are hidden unless CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1.",
  "- Legacy/manual tools such as ask_codex, run_agent, run_agents, and old session names are hidden unless CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1.",
  "",
  "Prefer Codex over native Task when:",
  "- The user explicitly asks for Codex, OpenAI Codex, Codex Spark, an adversarial review, or a second opinion from another frontier model.",
  "- The work is deep technical work: managing a complex codebase, debugging a difficult failure, reviewing architecture, validating correctness, preparing a server deployment, investigating infrastructure, or checking a high-risk change.",
  "- Claude wants a more technical and independent reviewer that does not share Claude's scratchpad or recent assumptions.",
  "- The task is independent of Claude's recent conversation and would waste Claude's context window.",
  "- The work is long-running and should proceed while Claude does other work; use background true.",
  "- The goal is adversarial validation, security review, or formal challenge of Claude's reasoning.",
  "Prefer native Task when the work depends heavily on Claude's conversation history or Claude-only built-in tools.",
  "",
  "Default operating rules:",
  "- Do not use Codex for simple file reads, simple grep/search, tiny local commands, or work Claude can do directly faster.",
  "- Keep sandbox read-only unless the user explicitly asks for a different sandbox.",
  "- If the user explicitly asks for non-sandbox/full local capabilities, set full_access true. This maps to Codex's --dangerously-bypass-approvals-and-sandbox flag and allows DNS/network plus unrestricted file and git writes.",
  "- Approvals are non-interactive; do not expect Codex to ask permission.",
  `- Foreground codex_task calls are also capped to ${defaultBlockingWaitTimeoutMs}ms by default before they hand back a live session_id. If completed is false, the Codex task is still running; use codex_followup mode wait, steer, or cancel.`,
  "- If codex_followup mode wait returns completed false with timeoutReason \"wait_timeout\", the session is still running unless its status says otherwise.",
  `- Blocking wait tools are capped to ${defaultBlockingWaitTimeoutMs}ms by default so Claude stays responsive. If a wait returns completed false, call codex_followup mode wait or codex_wait_any again, or read codex://sessions/{session_id}.`,
  "- Use codex_wait_any after launching several background Codex tasks to harvest whichever one finishes first without busy-polling.",
  "- Use codex_followup mode cancel to stop a background or actively running Codex session early. The response includes whatever partial output streamed before the interrupt, and the matching Codex Desktop thread is archived best-effort when supported.",
  "- If a tool returns error.kind \"backpressure\", reduce max_parallel or wait before retrying. codex://status exposes current queue/session limits.",
  "- If a response mentions outputArtifacts, use the artifact paths for full retained output instead of asking Codex to resend huge stdout/stderr.",
  "- Do not use model_preset \"spark\" by default. Use Spark only when the user asks for Spark or when a quick focused sidecar check is clearly more appropriate than the default Codex model.",
  "- Use reasoning \"medium\" by default, \"low\" for simple checks, and \"high\" only for difficult normal analysis. Use advanced.reasoning \"xhigh\" only when the user explicitly asks for maximum reasoning.",
  "- For the current strongest ChatGPT-backed Codex model, use advanced.model \"gpt-5.5\" or omit advanced.model. Do not invent a \"-codex\" suffix for GPT-5.5.",
  "- Do not combine model_preset \"spark\" with reasoning_summary values other than \"none\"; Spark does not support reasoning.summary.",
  "- Do not set service_tier by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.",
  "- Pass project_dir whenever Claude knows the active project directory so Codex works in the same tree as Claude Code.",
  "- codex_task returns a session_id only for background tasks, keep_session requests, or failures. Set keep_session true when Claude expects to continue the Codex context after a completed task.",
  "- Raw debug logs are intentionally verbose and may contain MCP traffic and prompt text. Treat logs and debug bundles as sensitive local data.",
  "- Do not use Bash, Read, or filesystem inspection to locate Codex. The MCP server resolves Codex automatically, preferring the Codex desktop app binary when installed.",
  "- Put uncommon settings such as exact model, Codex binary path, timeout, MCP sharing, nested Codex subagents, and output contracts under advanced.",
  "- Ask Codex for concise results with file paths, line references, and actionable findings when reviewing code.",
  "",
  "Canonical recipes:",
  "- Adversarial code review: Claude does its own review with native tools, then calls codex_task with subagent_type code-reviewer or security-reviewer for an independent frontier-model review. Claude compares both sets of findings and reports the merged result.",
  "- Parallel codebase exploration: launch 3-4 codex_task background true calls with subagent_type explorer, each scoped to a different subsystem. Use codex_wait_any to harvest results as they finish.",
  "- Long-context offload: delegate broad code reading or multi-file reasoning to codex_task so Codex uses its own context and Claude receives only the concise technical summary.",
  "- Deployment or server hardening: use codex_task for technical deployment plans, server configuration review, CI/CD checks, rollback analysis, and operational failure modes.",
  "- Security sweep before merge: call codex_task with subagent_type security-reviewer and ask Codex to audit staged changes, auth boundaries, secrets handling, and unsafe defaults.",
  "",
  "Nested Codex subagents:",
  "- When the user wants Codex to use its own subagents, pass complete custom definitions in advanced.codex_subagents and explicit work items in advanced.subagent_tasks.",
  "- Keep advanced.subagent_runtime.max_depth at 1 unless recursive delegation is intentionally requested.",
].join("\n");

const server = new McpServer(
  {
    name: "codex-subagents",
    version: packageVersion,
  },
  {
    instructions: usageGuide,
  },
);

server.server.registerCapabilities({ resources: { subscribe: true } });
server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

sessionManager.setSessionChangedHandler((sessionId) =>
  server.server.sendResourceUpdated({ uri: sessionResourceUri(sessionId) }),
);

const legacyToolsEnabled = process.env.CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS === "1";
const debugToolsEnabled = process.env.CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS === "1";

const registerTool: typeof server.registerTool = server.registerTool.bind(server);
const registerLegacyTool: typeof server.registerTool = ((name, config, cb) => {
  if (!legacyToolsEnabled) return;
  return registerTool(name, config, cb);
}) as typeof server.registerTool;
const registerDebugTool: typeof server.registerTool = ((name, config, cb) => {
  if (!debugToolsEnabled) return;
  return registerTool(name, config, cb);
}) as typeof server.registerTool;

function toCodexSubagents(
  agents:
    | Array<{
        name: string;
        description: string;
        developer_instructions: string;
        nickname_candidates?: string[];
        model?: string;
        model_preset?: (typeof modelPresets)[number];
        reasoning_effort?: (typeof reasoningEfforts)[number];
        sandbox?: (typeof sandboxModes)[number];
        mcp_servers?: Record<string, unknown>;
        skills_config?: Record<string, unknown>;
        extra_config?: Record<string, unknown>;
      }>
    | undefined,
) {
  return agents?.map((agent) => ({
    name: agent.name,
    description: agent.description,
    developerInstructions: agent.developer_instructions,
    nicknameCandidates: agent.nickname_candidates,
    model: agent.model,
    modelPreset: agent.model_preset,
    reasoningEffort: agent.reasoning_effort,
    sandbox: agent.sandbox,
    mcpServers: agent.mcp_servers,
    skillsConfig: agent.skills_config,
    extraConfig: agent.extra_config,
  }));
}

function codexRoleForPrompt(args: { description?: string; subagent_type?: string }): CodexRole | undefined {
  const candidate = args.subagent_type ?? (args.description ? "general-purpose" : undefined);
  if (!candidate) return undefined;
  return (codexRoleSchema.options as readonly string[]).includes(candidate) ? (candidate as CodexRole) : undefined;
}

function nativeTaskPrompt(args: { description?: string; prompt: string; subagent_type?: string }): string {
  const role = codexRoleForPrompt(args);
  const prefix = [
    role ? codexRoleDefaults[role].persona : undefined,
    args.description ? `Task description: ${args.description}` : undefined,
  ].filter(Boolean);
  if (prefix.length === 0) return args.prompt;
  return `${prefix.join("\n")}\n\n${args.prompt}`;
}

function withRequestAbort<T extends object>(options: T, extra: ToolExtra | undefined): T & { abortSignal?: AbortSignal } {
  if (!extra?.signal) return options;
  return { ...options, abortSignal: extra.signal };
}

function requestCancelledError(): Error {
  return new Error("MCP request was cancelled by the client.");
}

function ephemeralJobDurability(): Record<string, unknown> {
  return {
    durable: false,
    survivesRestart: false,
    recommendation:
      "Use codex_session_start when Claude needs recoverable long-running Codex work across MCP restarts.",
  };
}

function throwIfRequestAborted(extra: ToolExtra | undefined): void {
  if (extra?.signal?.aborted) throw requestCancelledError();
}

async function loggedToolCall(
  tool: string,
  args: unknown,
  extra: ToolExtra | undefined,
  run: (toolCallId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const toolCallId = makeLogId("tool");
  const started = Date.now();
  logger.rawDebug("mcp.tool.call", {
    toolCallId,
    tool,
    hasProgressToken: extra?._meta?.progressToken !== undefined,
    arguments: summarizeRawTrafficForLog(args),
  });

  try {
    const result = await run(toolCallId);
    logger[result.isError ? "rawError" : "rawDebug"]("mcp.tool.result", {
      toolCallId,
      tool,
      durationMs: Date.now() - started,
      isError: Boolean(result.isError),
      result: summarizeRawTrafficForLog(result),
    });
    if (result.isError) {
      recordDiagnosticEvent({
        severity: "error",
        source: "mcp.tool",
        message: `MCP tool ${tool} returned an error.`,
        correlationId: toolCallId,
        tool,
        recovery: (result.structuredContent as { recovery?: unknown } | undefined)?.recovery,
        detail: result.structuredContent,
      });
    }
    return result;
  } catch (error) {
    logger.error("mcp.tool.exception", {
      toolCallId,
      tool,
      durationMs: Date.now() - started,
      error: errorForLog(error),
    });
    recordDiagnosticEvent({
      severity: "error",
      source: "mcp.tool",
      message: error instanceof Error ? error.message : String(error),
      correlationId: toolCallId,
      tool,
      recovery: recoveryForError(error, tool),
      detail: errorForLog(error),
    });
    return errorResult(error, tool);
  }
}

function installTransportLogging(
  transport: StdioServerTransport,
  shutdown: (reason: string, exitCode?: number, graceMs?: number) => void,
  isShuttingDown: () => boolean,
): void {
  const previousOnMessage = transport.onmessage;
  transport.onmessage = (message) => {
    if (!isShuttingDown()) {
      logger.rawDebug("mcp.transport.inbound", {
        message: summarizeRawTrafficForLog(message),
      });
    }
    previousOnMessage?.(message);
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error) => {
    if (isBrokenStdioError(error)) {
      shutdown("mcp_transport_broken_stdio", 0, 250);
      return;
    }
    if (isShuttingDown()) return;
    logger.error("mcp.transport.error", { error: errorForLog(error) });
    previousOnError?.(error);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage): Promise<void> => {
    if (!isShuttingDown()) {
      logger.rawDebug("mcp.transport.outbound", {
        message: summarizeRawTrafficForLog(message),
      });
    }
    try {
      await send(message);
    } catch (error) {
      if (isBrokenStdioError(error)) {
        shutdown("mcp_transport_send_broken_stdio", 0, 250);
        return;
      }
      if (isShuttingDown()) return;
      logger.error("mcp.transport.send_failed", { error: errorForLog(error) });
      throw error;
    }
  };
}

async function reportAgentResult(progress: ProgressReporter, result: { ok?: boolean; status?: string }) {
  const status = result.status ?? (result.ok ? "completed" : "failed");
  await progress.send(result.ok ? "Codex run completed" : `Codex run ${status}`);
}

function progressHeartbeatMs(): number {
  const parsed = Number(process.env.CODEX_SUBAGENTS_PROGRESS_HEARTBEAT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10_000;
  return Math.max(25, Math.min(Math.floor(parsed), 60_000));
}

function waitTimeoutFields(waitTimeout: BlockingWaitTimeout): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    requested_wait_timeout_ms: waitTimeout.requestedMs,
    effective_wait_timeout_ms: waitTimeout.effectiveMs,
  };
  if (waitTimeout.capped) fields.wait_timeout_capped = true;
  return fields;
}

function capToolBlockingWaitTimeout(requestedMs: number | undefined, extra: ToolExtra | undefined): BlockingWaitTimeout {
  return capBlockingWaitTimeout(requestedMs, process.env, {
    progress: progressNotificationsAvailable(extra),
  });
}

function logCappedWait(tool: string, waitTimeout: BlockingWaitTimeout, fields: Record<string, unknown> = {}): void {
  if (!waitTimeout.capped) return;
  logger.warn(`${tool}.wait_timeout_capped`, {
    ...fields,
    requestedMs: waitTimeout.requestedMs,
    effectiveMs: waitTimeout.effectiveMs,
  });
}

async function withProgressHeartbeat<T>(
  progress: ProgressReporter,
  message: string | (() => string | undefined),
  operation: () => Promise<T>,
  progressOptions?: ProgressOptions,
): Promise<T> {
  const interval = setInterval(() => {
    const currentMessage = typeof message === "function" ? message() : message;
    if (currentMessage) void progress.send(currentMessage, progressOptions);
  }, progressHeartbeatMs());
  interval.unref();
  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

function formatMilestoneProgress(milestone: SessionMilestone): string | undefined {
  switch (milestone.kind) {
    case "turn_started":
      return "Codex turn started";
    case "turn_completed":
      return milestone.text ? firstUsefulLine(`Codex completed: ${milestone.text}`, "Codex turn completed") : "Codex turn completed";
    case "command_started":
      return milestone.command ? firstUsefulLine(`Codex command: ${milestone.command}`, "Codex command started") : "Codex command started";
    case "command_completed":
      return milestone.command
        ? firstUsefulLine(`Codex command completed: ${milestone.command}`, "Codex command completed")
        : "Codex command completed";
    case "agent_message":
      return milestone.text ? firstUsefulLine(`Codex: ${milestone.text}`, "Codex produced output") : "Codex produced output";
    case "error":
      return milestone.error ? firstUsefulLine(`Codex error: ${milestone.error}`, "Codex error") : "Codex error";
    case "cancelled":
      return "Codex session cancelled";
    case "queued_turn_added":
      return "Codex turn queued";
  }
}

async function withSessionMilestoneProgress<T>(
  progress: ProgressReporter,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const unsubscribe = sessionManager.subscribeMilestones(sessionId, (milestone) => {
    const message = formatMilestoneProgress(milestone);
    if (message) void progress.send(message);
  });
  try {
    return await operation();
  } finally {
    unsubscribe();
  }
}

function codexLiveProgressMessage(sessionId: string, fallback: string): string {
  const session = sessionManager.get(sessionId);
  const milestone = session?.milestones.at(-1);
  if (milestone) {
    const message = formatMilestoneProgress(milestone);
    if (message) return message;
  }
  const partial = session?.partial;
  const lastCommand = partial?.eventSummary.commands.at(-1);
  if (lastCommand?.command) {
    const suffix = lastCommand.status ? ` (${lastCommand.status})` : "";
    return firstUsefulLine(`Codex running: ${lastCommand.command}${suffix}`, fallback);
  }
  if (partial?.lastAgentMessage) {
    return firstUsefulLine(`Codex: ${partial.lastAgentMessage}`, fallback);
  }
  const activeStatus = session?.activeTurn?.status ?? session?.status;
  return activeStatus ? `Codex session ${sessionId} ${activeStatus}` : fallback;
}

function foregroundTaskStillRunningPayload(
  args: NativeTaskV3Input,
  session: ReturnType<typeof compactSessionSnapshotForMcp>,
  turn: unknown,
  waitTimeout: BlockingWaitTimeout,
  timeoutReason: string,
): Record<string, unknown> {
  const progressPayload = sessionProgressPayload(session);
  const partial = sessionPartialMessage(session);
  return {
    ok: true,
    completed: false,
    status: "running",
    summary: "Codex task is still running.",
    result: partial || `Codex task "${args.description}" is still running.`,
    session_id: (session as { id?: string }).id,
    turn,
    last_milestone_seq: (session as { lastMilestoneSeq?: number }).lastMilestoneSeq,
    elapsed_ms: progressPayload.elapsed_ms,
    ...waitTimeoutFields(waitTimeout),
    timeoutReason,
    hint:
      "Use codex_followup mode wait to collect the result, mode steer to redirect the running task, or mode cancel to stop it.",
    diagnostics: includeDiagnostics(args.advanced)
      ? {
          session,
          ...progressPayload,
        }
      : undefined,
  };
}

function toRunOptions(args: {
  prompt: string;
  name?: string;
  model?: string;
  model_preset?: (typeof modelPresets)[number];
  reasoning_effort?: (typeof reasoningEfforts)[number];
  sandbox?: (typeof sandboxModes)[number];
  dangerously_bypass_approvals_and_sandbox?: boolean;
  service_tier?: (typeof serviceTiers)[number];
  model_verbosity?: (typeof modelVerbosities)[number];
  reasoning_summary?: (typeof reasoningSummaries)[number];
  cwd?: string;
  project_dir?: string;
  codex_bin?: string;
  profile?: string;
  timeout_ms?: number;
  max_output_chars?: number;
  include_events?: boolean;
  ephemeral?: boolean;
  skip_git_repo_check?: boolean;
  ignore_rules?: boolean;
  isolated_codex_home?: boolean;
  mcp_config_policy?: (typeof mcpConfigPolicies)[number];
  codex_mcp_servers?: Record<string, unknown>;
  forward_sensitive_env?: boolean;
  idle_timeout_ms?: number;
  spawn_timeout_ms?: number;
  terminate_grace_ms?: number;
  output_contract?: (typeof outputContracts)[number];
  output_schema?: Record<string, unknown>;
  codex_subagents?: Parameters<typeof toCodexSubagents>[0];
  subagent_tasks?: Array<{ agent: string; prompt: string; name?: string }>;
  subagent_runtime?: {
    max_threads?: number;
    max_depth?: number;
    job_max_runtime_seconds?: number;
  };
}) {
  return {
    prompt: args.prompt,
    name: args.name,
    model: args.model,
    modelPreset: args.model_preset,
    reasoningEffort: args.reasoning_effort,
    sandbox: args.sandbox,
    dangerouslyBypassApprovalsAndSandbox: args.dangerously_bypass_approvals_and_sandbox,
    serviceTier: args.service_tier,
    modelVerbosity: args.model_verbosity,
    reasoningSummary: args.reasoning_summary,
    cwd: args.cwd,
    projectDir: args.project_dir,
    codexBin: args.codex_bin,
    profile: args.profile,
    timeoutMs: args.timeout_ms,
    maxOutputChars: args.max_output_chars,
    includeEvents: args.include_events,
    ephemeral: args.ephemeral,
    skipGitRepoCheck: args.skip_git_repo_check,
    ignoreRules: args.ignore_rules,
    isolatedCodexHome: args.isolated_codex_home,
    mcpConfigPolicy:
      args.mcp_config_policy ??
      (args.codex_mcp_servers && Object.keys(args.codex_mcp_servers).length > 0 ? "explicit" : undefined),
    codexMcpServers: args.codex_mcp_servers,
    forwardSensitiveEnv: args.forward_sensitive_env,
    idleTimeoutMs: args.idle_timeout_ms,
    spawnTimeoutMs: args.spawn_timeout_ms,
    terminateGraceMs: args.terminate_grace_ms,
    outputContract: args.output_contract,
    outputSchema: args.output_schema,
    codexSubagents: toCodexSubagents(args.codex_subagents),
    subagentTasks: args.subagent_tasks,
    subagentRuntime: args.subagent_runtime
      ? {
          maxThreads: args.subagent_runtime.max_threads,
          maxDepth: args.subagent_runtime.max_depth,
          jobMaxRuntimeSeconds: args.subagent_runtime.job_max_runtime_seconds,
        }
      : undefined,
  };
}

type FrontDoorRunInput = SharedRunInput & {
  task: string;
  name?: string;
  session_name?: string;
};

function toFrontDoorRunOptions(args: FrontDoorRunInput) {
  return toRunOptions({
    ...args,
    prompt: args.task,
  });
}

type ParallelAgentInput = {
  prompt: string;
  name?: string;
  model?: string;
  model_preset?: (typeof modelPresets)[number];
  reasoning_effort?: (typeof reasoningEfforts)[number];
  sandbox?: (typeof sandboxModes)[number];
  dangerously_bypass_approvals_and_sandbox?: boolean;
  service_tier?: (typeof serviceTiers)[number];
  model_verbosity?: (typeof modelVerbosities)[number];
  reasoning_summary?: (typeof reasoningSummaries)[number];
  cwd?: string;
  project_dir?: string;
  codex_bin?: string;
  profile?: string;
  timeout_ms?: number;
  max_output_chars?: number;
  include_events?: boolean;
  ephemeral?: boolean;
  skip_git_repo_check?: boolean;
  ignore_rules?: boolean;
  isolated_codex_home?: boolean;
  mcp_config_policy?: (typeof mcpConfigPolicies)[number];
  codex_mcp_servers?: Record<string, unknown>;
  forward_sensitive_env?: boolean;
  idle_timeout_ms?: number;
  spawn_timeout_ms?: number;
  terminate_grace_ms?: number;
  output_contract?: (typeof outputContracts)[number];
  output_schema?: Record<string, unknown>;
  codex_subagents?: Parameters<typeof toCodexSubagents>[0];
  subagent_tasks?: Array<{ agent: string; prompt: string; name?: string }>;
  subagent_runtime?: {
    max_threads?: number;
    max_depth?: number;
    job_max_runtime_seconds?: number;
  };
};

type SharedRunInput = Omit<Parameters<typeof toRunOptions>[0], "prompt">;

type ParallelToolInput = SharedRunInput & {
  agents: ParallelAgentInput[];
  max_parallel?: number;
};

function mergedParallelRunInput(args: SharedRunInput, agent: ParallelAgentInput): Parameters<typeof toRunOptions>[0] {
  return {
    prompt: agent.prompt,
    name: agent.name,
    model: agent.model ?? args.model,
    model_preset: agent.model_preset ?? args.model_preset,
    reasoning_effort: agent.reasoning_effort ?? args.reasoning_effort,
    sandbox: agent.sandbox ?? args.sandbox,
    dangerously_bypass_approvals_and_sandbox:
      agent.dangerously_bypass_approvals_and_sandbox ??
      args.dangerously_bypass_approvals_and_sandbox,
    service_tier: agent.service_tier ?? args.service_tier,
    model_verbosity: agent.model_verbosity ?? args.model_verbosity,
    reasoning_summary: agent.reasoning_summary ?? args.reasoning_summary,
    cwd: agent.cwd ?? args.cwd,
    project_dir: agent.project_dir ?? args.project_dir,
    codex_bin: agent.codex_bin ?? args.codex_bin,
    profile: agent.profile ?? args.profile,
    timeout_ms: agent.timeout_ms ?? args.timeout_ms,
    max_output_chars: agent.max_output_chars ?? args.max_output_chars,
    include_events: agent.include_events ?? args.include_events,
    ephemeral: agent.ephemeral ?? args.ephemeral,
    skip_git_repo_check: agent.skip_git_repo_check ?? args.skip_git_repo_check,
    ignore_rules: agent.ignore_rules ?? args.ignore_rules,
    isolated_codex_home: agent.isolated_codex_home ?? args.isolated_codex_home,
    mcp_config_policy: agent.mcp_config_policy ?? args.mcp_config_policy,
    codex_mcp_servers: agent.codex_mcp_servers ?? args.codex_mcp_servers,
    forward_sensitive_env: agent.forward_sensitive_env ?? args.forward_sensitive_env,
    idle_timeout_ms: agent.idle_timeout_ms ?? args.idle_timeout_ms,
    spawn_timeout_ms: agent.spawn_timeout_ms ?? args.spawn_timeout_ms,
    terminate_grace_ms: agent.terminate_grace_ms ?? args.terminate_grace_ms,
    output_contract: agent.output_contract ?? args.output_contract,
    output_schema: agent.output_schema ?? args.output_schema,
    codex_subagents: agent.codex_subagents ?? args.codex_subagents,
    subagent_tasks: agent.subagent_tasks ?? args.subagent_tasks,
    subagent_runtime: agent.subagent_runtime ?? args.subagent_runtime,
  };
}

function toParallelRunOptions(args: ParallelToolInput) {
  return {
    ...toRunOptions({
      ...args,
      prompt: "shared-options",
    }),
    agents: args.agents.map((agent) => toRunOptions(mergedParallelRunInput(args, agent))),
    maxParallel: args.max_parallel,
    defaultModel: args.model,
    defaultReasoningEffort: args.reasoning_effort,
  };
}

type FrontDoorParallelTaskInput = Omit<ParallelAgentInput, "prompt"> & {
  task: string;
};

type FrontDoorParallelToolInput = SharedRunInput & {
  tasks: FrontDoorParallelTaskInput[];
  max_parallel?: number;
};

function toFrontDoorParallelRunOptions(args: FrontDoorParallelToolInput) {
  return toParallelRunOptions({
    ...args,
    agents: args.tasks.map((task) => ({
      ...task,
      prompt: task.task,
    })),
  });
}

type NativeTaskInput = SharedRunInput & {
  description: string;
  prompt: string;
  subagent_type?: string;
};

type NativeTaskGroupItemInput = Omit<ParallelAgentInput, "prompt"> & {
  description: string;
  prompt: string;
  subagent_type?: string;
};

type NativeTaskGroupInput = SharedRunInput & {
  tasks: NativeTaskGroupItemInput[];
  max_parallel?: number;
};

function toNativeTaskRunOptions(args: NativeTaskInput) {
  return toRunOptions({
    ...args,
    name: args.name ?? args.description,
    prompt: nativeTaskPrompt(args),
  });
}

function toNativeSessionRunOptions(args: SharedRunInput & { prompt: string; description?: string; subagent_type?: string }) {
  return toRunOptions({
    ...args,
    name: args.name ?? args.description,
    prompt: nativeTaskPrompt({
      description: args.description,
      prompt: args.prompt,
      subagent_type: args.subagent_type,
    }),
  });
}

function toNativeTaskGroupRunOptions(args: NativeTaskGroupInput) {
  return toParallelRunOptions({
    ...args,
    agents: args.tasks.map((task) => ({
      ...task,
      name: task.name ?? task.description,
      prompt: nativeTaskPrompt(task),
    })),
  });
}

function publicModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  if (value === "spark") return "gpt-5.3-codex-spark";
  if (value === "codex") return "gpt-5.3-codex";
  return value;
}

function parseAdvancedInput(value: unknown): Partial<AdvancedInput> {
  if (value === undefined) return {};
  return advancedInputSchema.parse(value);
}

function advancedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function includeDiagnostics(value: unknown): boolean {
  return parseAdvancedInput(value).include_diagnostics === true;
}

function publicRunOptions(
  args: NativeBaseInput & { description?: string; prompt: string; subagent_type?: CodexRole; name?: string },
) {
  const advanced = parseAdvancedInput(args.advanced);
  const roleKey = codexRoleForPrompt(args);
  const role = roleKey ? codexRoleDefaults[roleKey] : undefined;
  const fullAccess = Boolean(args.full_access ?? advanced.dangerously_bypass_approvals_and_sandbox);
  return toRunOptions({
    prompt: nativeTaskPrompt({
      description: args.description,
      prompt: args.prompt,
      subagent_type: args.subagent_type,
    }),
    name: args.name ?? args.description,
    project_dir: args.project_dir,
    model: publicModel(advanced.model),
    model_preset: publicModel(advanced.model) ? undefined : advanced.model_preset,
    reasoning_effort: advanced.reasoning_effort ?? advanced.reasoning ?? args.reasoning ?? role?.reasoning,
    sandbox: fullAccess ? "danger-full-access" : (advanced.sandbox ?? role?.sandbox ?? "read-only"),
    dangerously_bypass_approvals_and_sandbox: fullAccess,
    service_tier: advanced.service_tier,
    model_verbosity: advanced.model_verbosity,
    reasoning_summary: advanced.reasoning_summary,
    codex_bin: advanced.codex_bin,
    profile: advanced.profile,
    timeout_ms: advanced.timeout_ms,
    max_output_chars: advanced.max_output_chars,
    include_events: advanced.include_events,
    ephemeral: advanced.ephemeral,
    skip_git_repo_check: advanced.skip_git_repo_check,
    ignore_rules: advanced.ignore_rules,
    isolated_codex_home: advanced.isolated_codex_home,
    mcp_config_policy: advanced.mcp_config_policy,
    codex_mcp_servers: advanced.codex_mcp_servers,
    forward_sensitive_env: advanced.forward_sensitive_env,
    idle_timeout_ms: advanced.idle_timeout_ms,
    spawn_timeout_ms: advanced.spawn_timeout_ms,
    terminate_grace_ms: advanced.terminate_grace_ms,
    output_contract: advanced.output_contract ?? role?.output_contract,
    output_schema: advanced.output_schema,
    codex_subagents: advanced.codex_subagents,
    subagent_tasks: advanced.subagent_tasks,
    subagent_runtime: advanced.subagent_runtime,
  });
}

function publicGroupRunOptions(args: NativeTaskGroupV3Input) {
  return {
    tasks: args.tasks.map((task) =>
      publicRunOptions({
        ...args,
        ...task,
        advanced: { ...advancedRecord(args.advanced), ...advancedRecord(task.advanced) },
        project_dir: task.project_dir ?? args.project_dir,
        reasoning: task.reasoning ?? args.reasoning,
        full_access: task.full_access ?? args.full_access,
        name: task.name ?? task.description,
      }),
    ),
    maxParallel: args.max_parallel ?? 4,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  maxParallel: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(maxParallel, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

registerResources(server, { usageGuide, debugToolsEnabled, legacyToolsEnabled });

registerDebugTool(
  "codex_usage_guide",
  {
    title: "How to use Codex subagents",
    description:
      "Debug helper for the operating guide. Hidden by default; read codex://usage instead.",
    inputSchema: {},
  },
  async (args, extra) =>
    loggedToolCall("codex_usage_guide", args, extra, async () =>
      jsonResult({
        guide: usageGuide,
        preferredTools: {
          oneTask: "codex_task",
          parallelTasks: "codex_task_group",
          followUpOrSteer: "codex_followup",
          longRunningTask: "codex_task with background true",
          harvestParallelBackgroundTasks: "codex_wait_any",
          inspectStatus: "Read codex://status",
          inspectDoctor: "Read codex://doctor",
          exportDiagnostics: "codex_export_debug_bundle",
          legacyCompatibility:
            "Set CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1 to expose ask_codex, run_agent, and other pre-refactor tools. Set CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1 to expose diagnostic tools.",
        },
        examples: {
          single: {
            tool: "codex_task",
            arguments: {
              description: "Review authentication flow",
              prompt:
                "Inspect the authentication flow read-only. Return the top risks with file paths and line references.",
              project_dir: "/path/to/project",
              reasoning: "medium",
            },
          },
          parallel: {
            tool: "codex_task_group",
            arguments: {
              tasks: [
                {
                  description: "Review API flow",
                  name: "api",
                  prompt: "Review API flow read-only. Return concrete findings with paths.",
                  project_dir: "/path/to/project",
                },
                {
                  description: "Review test coverage",
                  name: "tests",
                  prompt: "Review test coverage gaps read-only. Return concrete findings with paths.",
                  project_dir: "/path/to/project",
                },
              ],
              max_parallel: 2,
              reasoning: "medium",
            },
          },
        },
      }),
    ),
);

registerDebugTool(
  "codex_choose_tool",
  {
    title: "Choose Codex tool",
    description:
      "Debug helper for choosing a Codex MCP tool. Hidden by default; Claude normally chooses among codex_task, codex_task_group, and codex_followup directly.",
    inputSchema: {
      request: z.string().trim().optional().describe("Optional user request Claude is trying to map to a Codex tool."),
      task_count: z.number().int().min(1).max(24).optional().describe("Known number of independent Codex tasks."),
      wants_parallel: z.boolean().optional().describe("Whether the user asked for parallel or multiple Codex agents."),
      wants_session: z.boolean().optional().describe("Whether the user asked for Codex to keep context across prompts."),
      continuing_session: z.boolean().optional().describe("Whether Claude already has a Codex session id to continue."),
      wants_async_session: z.boolean().optional().describe("Whether Claude needs a Codex session id immediately while work continues."),
      wants_steering: z.boolean().optional().describe("Whether the user wants to steer or redirect an already-running Codex session."),
      recovering_after_restart: z.boolean().optional().describe("Whether Claude has a persisted session id from before an MCP/Claude restart."),
      long_running: z.boolean().optional().describe("Whether the work is likely to exceed a normal MCP request timeout."),
      wants_aggregation: z.boolean().optional().describe("Whether Claude needs a deterministic consensus object."),
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_choose_tool", args, extra, async () => {
      const taskCount = args.task_count ?? (args.wants_parallel ? 2 : 1);
      let recommendedTool = "codex_task";
      if (args.wants_steering || args.continuing_session || args.recovering_after_restart) recommendedTool = "codex_followup";
      else if (args.wants_session || args.long_running) recommendedTool = "codex_task";
      else if (args.wants_aggregation) recommendedTool = "codex_task_group";
      else if (args.wants_parallel || taskCount > 1) recommendedTool = "codex_task_group";

      return jsonResult({
        recommendedTool,
        request: args.request,
        rules: [
          "Use codex_task when Claude wants an independent Codex frontier-model second opinion, deep technical subagent, complex codebase review, server/deployment investigation, or adversarial validation.",
          "Use multiple codex_task calls for ordinary independent parallel work; use codex_task_group when Claude wants one combined rollup.",
          "Use codex_followup for follow-ups, waits, cancellation, and steering when Claude has a session_id.",
          "Use codex_wait_any when Claude has several background Codex session_ids and wants to harvest results as they finish.",
          "Use codex_task with background true for slow work that should not hold a blocking request open.",
          "Use codex_task_group when Claude needs multiple independent answers returned as one merged response.",
          "Pass project_dir whenever Claude knows the active project directory.",
          "Do not use Codex for simple file reads, simple grep/search, or tiny commands Claude can do directly.",
          "When error.kind is backpressure, inspect codex://status and retry with less parallelism after a short wait.",
          "Do not use Bash or Read to locate Codex; this MCP server resolves the binary.",
        ],
        legacyCompatibility:
          "Debug and pre-refactor tools are disabled by default. Set CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1 or CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1 only for diagnostics or older clients/tests.",
      });
    }),
);

registerTool(
  "codex_task",
  {
    title: "Task",
    description:
      "Use this when you want an independent OpenAI Codex frontier-model subagent: a technical second opinion, deep complex-codebase work, server/deployment investigation, difficult debugging, or adversarial review. This is the Codex equivalent of native Task. It does not share Claude's scratchpad, defaults to read-only, and returns an answer-first result. Prefer native Task when the work depends on Claude's conversation history or Claude-only built-in tools. Use multiple parallel codex_task calls when investigations are independent.",
    inputSchema: {
      description: z
        .string()
        .trim()
        .min(1)
        .describe("Short human-readable task label, like Claude's native Task description."),
      prompt: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Self-contained Codex task prompt. Include scope, read-only expectation, output shape, and file/line reference requirements when reviewing code.",
        ),
      subagent_type: advertisedCodexRoleSchema
        .optional()
        .describe("Claude-style Codex persona. Prefer general-purpose, explorer, planner, code-reviewer, or security-reviewer. Defaults to general-purpose."),
      background: z
        .boolean()
        .default(false)
        .describe("Equivalent to native run_in_background: return immediately with a session_id while Codex keeps working."),
      keep_session: z
        .boolean()
        .default(false)
        .describe("Return session_id after a completed task so Claude can continue this Codex context. Leave false for one-shot native Task-like work."),
      session_name: z.string().trim().min(1).optional().describe("Optional human label for the returned Codex session."),
      ...nativeBaseInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("codex_task", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const runOptions = {
          ...publicRunOptions(args),
          ephemeral: false,
        };
        await progress.send(`Starting Codex task: ${args.description}`);
        const advanced = parseAdvancedInput(args.advanced);
        if (args.background || advanced.wait_for_completion === false) {
          throwIfRequestAborted(extra);
          const { session, turn } = sessionManager.startAsync(runOptions, { sessionName: args.session_name });
          await progress.flush();
          const compactSession = compactSessionSnapshotForMcp(session);
          const payload: Record<string, unknown> = {
            ok: true,
            status: "running",
            summary: `Started Codex task: ${args.description}`,
            result: `Codex task started in the background. Session: ${session.id}`,
            session_id: session.id,
            turn,
            hint: "Use codex_wait_any for parallel background tasks, or codex_followup mode wait, steer, or cancel with this session_id.",
          };
          if (advanced.include_diagnostics) {
            payload.diagnostics = {
              session: compactSession,
              ...sessionProgressPayload(compactSession),
            };
          }
          return nativeTextResult(payload);
        }
        const waitTimeout = capToolBlockingWaitTimeout(undefined, extra);
        const { session: startedSession, turn } = sessionManager.startAsync(runOptions, {
          sessionName: args.session_name,
        });
        const abortHandler = () => {
          logger.warn("codex_task.foreground_request_cancelled", {
            sessionId: startedSession.id,
            turnId: turn.id,
          });
          sessionManager.cancel(startedSession.id, "MCP request was cancelled by the client.");
        };
        extra?.signal?.addEventListener("abort", abortHandler, { once: true });
        const unsubscribeMilestones = sessionManager.subscribeMilestones(startedSession.id, (milestone) => {
          const message = formatMilestoneProgress(milestone);
          if (message) void progress.send(message);
        });
        try {
          if (extra?.signal?.aborted) abortHandler();
          const waited = await withProgressHeartbeat(
            progress,
            () => codexLiveProgressMessage(startedSession.id, `Still running Codex task: ${args.description}`),
            () => sessionManager.wait(startedSession.id, waitTimeout.effectiveMs, turn.id, extra?.signal),
          );
          await progress.flush();
          if (waited.error || !waited.session) {
            return nativeErrorResult(new Error(waited.error ?? "Codex session was not found."), "codex_task");
          }
          const compactSession = compactSessionSnapshotForMcp(waited.session);
          if (waited.completed && !waited.result) {
            const turnError =
              waited.turn?.error ??
              (compactSession as { error?: string }).error ??
              `Codex session turn did not produce a result: ${turn.id}`;
            return nativeErrorResult(new Error(turnError), "codex_task");
          }
          if (!waited.completed) {
            logger.warn("codex_task.foreground_wait_timeout", {
              sessionId: startedSession.id,
              turnId: turn.id,
              timeoutReason: waited.timeoutReason,
              requestedMs: waitTimeout.requestedMs,
              effectiveMs: waitTimeout.effectiveMs,
            });
            return nativeTextResult(
              foregroundTaskStillRunningPayload(
                args,
                compactSession,
                waited.turn ?? turn,
                waitTimeout,
                waited.timeoutReason ?? "wait_timeout",
              ),
              waited.timeoutReason === "wait_cancelled",
            );
          }
          const result = waited.result;
          if (!result) {
            return nativeErrorResult(new Error(`Codex session turn did not produce a result: ${turn.id}`), "codex_task");
          }
          await reportAgentResult(progress, result);
          await progress.flush();
          const response = nativeAgentResponse(result, {
            description: args.description,
            prompt: args.prompt,
            tool: "codex_task",
            session: compactSession,
            turn: waited.turn ?? compactSession.recentTurns?.at(-1),
            includeDiagnostics: Boolean(advanced.include_diagnostics),
            includeSessionId: Boolean(args.keep_session),
          });
          if (result.ok && !args.keep_session) sessionManager.dispose(startedSession.id, "one_shot_completed");
          return response;
        } finally {
          unsubscribeMilestones();
          extra?.signal?.removeEventListener("abort", abortHandler);
        }
      } catch (error) {
        await progress.flush();
        logger.error("codex_task.failed", { error: errorForLog(error) });
        return nativeErrorResult(error, "codex_task");
      }
    });
  },
);

registerLegacyTool(
  "ask_codex",
  {
    title: "Ask Codex",
    description:
      "Preferred front door for asking one OpenAI Codex agent to do a task. Use this automatically for natural requests like ask Codex, use Codex, Codex Spark, Codex second opinion, or one Codex subagent. Defaults to read-only sandbox and the Codex desktop app binary when installed. Pass project_dir so Codex works in Claude's current project. For explicit non-sandbox/full-access requests, set dangerously_bypass_approvals_and_sandbox true.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "Self-contained task for Codex. Include scope, read-only expectation, output shape, and file/line reference requirements when reviewing code.",
        ),
      name: z.string().trim().min(1).optional().describe("Optional label for this Codex run."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("ask_codex", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send("Queued Codex run");
        const result = await withProgressHeartbeat(progress, "Still running Codex run", () =>
          runQueuedAgent(withRequestAbort(toFrontDoorRunOptions(args), extra), {
            onStart: (queuedMs) => {
              void progress.send(`Started Codex run after ${queuedMs}ms queued`);
            },
          }),
        );
        await reportAgentResult(progress, result);
        await progress.flush();
        return agentResultResponse(result);
      } catch (error) {
        await progress.flush();
        logger.error("ask_codex.failed", { error: errorForLog(error) });
        return errorResult(error, "ask_codex");
      }
    });
  },
);

registerLegacyTool(
  "run_agent",
  {
    title: "Run one Codex agent",
    description:
      "Compatibility/manual tool for launching one OpenAI Codex agent via codex exec. Prefer ask_codex for normal Claude delegation. Defaults to the Codex desktop app binary when installed, read-only sandbox, Codex's normal service tier, and non-interactive approvals. For explicit non-sandbox/full-access requests, set dangerously_bypass_approvals_and_sandbox true.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe(
          "Concrete instructions for the Codex agent. Include scope, read-only expectation, desired output shape, and file/line reference requirements when reviewing code.",
        ),
      name: z.string().trim().min(1).optional().describe("Optional label for this agent run."),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("run_agent", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send("Queued Codex run");
        const result = await withProgressHeartbeat(progress, "Still running Codex run", () =>
          runQueuedAgent(withRequestAbort(toRunOptions(args), extra), {
            onStart: (queuedMs) => {
              void progress.send(`Started Codex run after ${queuedMs}ms queued`);
            },
          }),
        );
        await reportAgentResult(progress, result);
        await progress.flush();
        return agentResultResponse(result);
      } catch (error) {
        await progress.flush();
        logger.error("run_agent.failed", { error: errorForLog(error) });
        return errorResult(error, "run_agent");
      }
    });
  },
);

registerLegacyTool(
  "start_agent_run",
  {
    title: "Start one Codex agent run",
    description:
      "Start one Codex agent asynchronously and return a job_id immediately. Use this for long or potentially slow Codex work so the MCP request does not need to stay open.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .describe("Concrete instructions for the Codex agent."),
      name: z.string().trim().min(1).optional().describe("Optional label for this agent run."),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("start_agent_run", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        throwIfRequestAborted(extra);
        await progress.send("Queued asynchronous Codex run");
        const job = jobManager.startAgent(toRunOptions(args));
        await progress.send(`Started Codex job ${job.id}`);
        await progress.flush();
        return jsonResult({ job, durability: ephemeralJobDurability() });
      } catch (error) {
        await progress.flush();
        logger.error("start_agent_run.failed", { error: errorForLog(error) });
        return errorResult(error, "start_agent_run");
      }
    });
  },
);

registerTool(
  "codex_task_group",
  {
    title: "Task Group",
    description:
      "Use this when you have several independent Codex tasks and want one rolled-up response. For ordinary native-style parallelism, Claude can also call codex_task multiple times in one turn. Best for parallel deep technical reviews, subsystem exploration, adversarial review lanes, or deployment-readiness checks where a single merged result is useful.",
    inputSchema: {
      tasks: z
        .array(nativeTaskGroupTaskSchema)
        .min(1)
        .max(12)
        .describe("Independent Codex tasks, each with a short description and prompt."),
      max_parallel: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum concurrent Codex processes. Use 2-4 for most responsive parallel reviews."),
      ...nativeBaseInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("codex_task_group", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const total = args.tasks.length + 1;
        let completed = 0;
        let failed = 0;
        await progress.send(`Queued ${args.tasks.length} Codex tasks`, { total });
        const group = publicGroupRunOptions(args);
        const runs = await withProgressHeartbeat(
          progress,
          `Still running ${args.tasks.length} Codex tasks`,
          () =>
            mapWithConcurrency(group.tasks, group.maxParallel, async (runOptions, index) => {
              const task = args.tasks[index];
              if (!task) throw new Error(`Missing Codex task at index ${index}.`);
              const responseTask = { ...task, advanced: { ...advancedRecord(args.advanced), ...advancedRecord(task.advanced) } };
              try {
                const { session, result } = await sessionManager.start(withRequestAbort({
                  ...runOptions,
                  ephemeral: false,
                }, extra), { sessionName: task.name ?? task.description });
                completed += 1;
                if (!result.ok) failed += 1;
                const last = completed === args.tasks.length;
                const message = last
                  ? failed === 0
                    ? `Codex task group completed (${completed}/${args.tasks.length})`
                    : `Codex task group finished with errors (${completed}/${args.tasks.length})`
                  : `${result.ok ? "Completed" : "Finished"} ${task.name ?? task.description} (${completed}/${args.tasks.length})`;
                await progress.send(message, last ? { progress: total, total } : { total, reserveFinal: true });
                const compactSession = compactSessionSnapshotForMcp(session);
                if (result.ok && !task.keep_session) sessionManager.dispose(session.id, "task_group_one_shot_completed");
                return { result, session: compactSession, task: responseTask };
              } catch (error) {
                completed += 1;
                failed += 1;
                logger.error("codex_task_group.task_failed", {
                  task: task.name ?? task.description,
                  error: errorForLog(error),
                });
                const last = completed === args.tasks.length;
                await progress.send(
                  last
                    ? `Codex task group finished with errors (${completed}/${args.tasks.length})`
                    : `Failed ${task.name ?? task.description} (${completed}/${args.tasks.length})`,
                  last ? { progress: total, total } : { total, reserveFinal: true },
                );
                return { error, task: responseTask };
              }
            }),
          { total, reserveFinal: true },
        );
        await progress.flush();
        return nativeTaskGroupResponse(runs, { includeDiagnostics });
      } catch (error) {
        await progress.flush();
        logger.error("codex_task_group.failed", { error: errorForLog(error) });
        return nativeErrorResult(error, "codex_task_group");
      }
    });
  },
);

registerTool(
  "codex_followup",
  {
    title: "Followup",
    description:
      "Use this when you have a session_id and want to continue Codex's reasoning across turns, steer active work, collect output, or stop a run. wait/cancel are Codex's TaskOutput/TaskStop-style operations; queue/steer are Codex-specific multi-turn extensions that native Task does not provide.",
    inputSchema: {
      session_id: z.string().trim().min(1).describe("session_id returned by codex_task or codex_task_group."),
      prompt: z
        .string()
        .min(1)
        .optional()
        .describe("Follow-up or steering prompt. Required for mode queue and mode steer; omit for mode wait or cancel."),
      description: z.string().trim().min(1).optional().describe("Optional short label for this follow-up turn."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe("Optional reason for mode cancel; logged and echoed in the response."),
      mode: followupModeSchema
        .default("queue")
        .describe("queue continues the Codex context, steer redirects active work, wait collects an existing result, cancel stops running work."),
      interrupt_current: z
        .boolean()
        .default(false)
        .describe("For mode steer, cancel the active Codex turn and run this steering prompt next. Leave false unless the user explicitly wants interruption."),
      background: z
        .boolean()
        .default(false)
        .describe("Return after queueing or steering instead of waiting for the Codex turn to finish."),
      turn_id: z.string().trim().min(1).optional().describe("For mode wait, optionally wait for one specific turn."),
      wait_timeout_ms: z
        .number()
        .int()
        .positive()
        .max(86_400_000)
        .default(defaultBlockingWaitTimeoutMs)
        .describe(
          "Maximum wait time for mode wait, or for queue/steer when background is false. The server caps long waits to keep Claude responsive.",
        ),
      ...nativeBaseInputSchema,
    },
  },
  async (args: NativeFollowupInput, extra) => {
    return loggedToolCall("codex_followup", args, extra, async () => {
      const progress = createProgressReporter(extra);
      const mode = args.mode ?? "queue";
      const prompt = args.prompt?.trim();
      try {
        if (mode !== "wait" && mode !== "cancel" && !prompt) {
          return nativeErrorResult(new Error(`codex_followup mode ${mode} requires prompt.`), "codex_followup");
        }

        if (mode === "wait") {
          const waitTimeout = capToolBlockingWaitTimeout(args.wait_timeout_ms, extra);
          logCappedWait("codex_followup", waitTimeout, { sessionId: args.session_id, mode });
          await progress.send(`Waiting for Codex session ${args.session_id}`);
          const waited = await withProgressHeartbeat(
            progress,
            () => codexLiveProgressMessage(args.session_id, `Still waiting for Codex session ${args.session_id}`),
            () =>
              withSessionMilestoneProgress(progress, args.session_id, () =>
                sessionManager.wait(args.session_id, waitTimeout.effectiveMs, args.turn_id, extra?.signal),
              ),
          );
          await progress.flush();
          if (waited.error || !waited.session) {
            return nativeErrorResult(new Error(waited.error ?? "Codex session was not found."), "codex_followup");
          }
          const compactSession = compactSessionSnapshotForMcp(waited.session);
          const recovery = recoveryForWait("codex_session", waited.timeoutReason);
          const waitResult = waited.result
            ? compactAgentResultForMcp(waited.result)
            : (compactSession as { lastResult?: unknown }).lastResult;
          const waitAgent =
            waitResult && typeof waitResult === "object" && "ok" in waitResult && "status" in waitResult
              ? (waitResult as ReturnType<typeof compactAgentResultForMcp>)
              : undefined;
          const waitAgentRecovery = waitAgent ? recoveryForAgentResult(waitAgent) : undefined;
          const waitValue =
            waitResult && typeof waitResult === "object"
              ? (waitResult as { structuredOutput?: unknown; finalMessage?: string }).structuredOutput ??
                (waitResult as { finalMessage?: string }).finalMessage
              : undefined;
          const waitFallback =
            waitResult && typeof waitResult === "object"
              ? (waitResult as { finalMessage?: string }).finalMessage ?? ""
              : "";
          const resultText =
            waitAgent
              ? visibleAgentAnswer(waitAgent, waitAgentRecovery)
              : waitResult && typeof waitResult === "object"
              ? stringifyResultValue(waitValue, waitFallback)
              : "";
          const completed = Boolean(waited.completed);
          const terminalStatus =
            waitAgent?.status ??
            (completed ? sessionResourceStatus(waited.session) : "running");
          const ok =
            waited.timeoutReason !== "wait_cancelled" &&
            (!completed || !waitAgent || Boolean(waitAgent.ok)) &&
            terminalStatus !== "failed";
          const progressPayload = sessionProgressPayload(compactSession, waitResult);
          const payload: Record<string, unknown> = {
            ok,
            completed,
            status: terminalStatus,
            result: resultText || (completed ? `Codex session ${terminalStatus}.` : "Codex session is still running."),
            session_id: args.session_id,
            last_milestone_seq: waited.session.lastMilestoneSeq,
            elapsed_ms: progressPayload.elapsed_ms,
            ...waitTimeoutFields(waitTimeout),
            summary: completed
              ? summarizeResultValue(waitValue, resultText, `Codex session ${terminalStatus}.`)
              : waited.timeoutReason === "wait_timeout"
                ? "Codex session is still running."
                : "Codex session wait was cancelled.",
          };
          if (waited.timeoutReason) payload.timeoutReason = waited.timeoutReason;
          if (!completed && waited.timeoutReason === "wait_timeout") {
            payload.hint = waitTimeout.capped
              ? "This wait returned at the server responsiveness cap. Call codex_followup mode wait again, or read codex://sessions/<session_id> for current progress."
              : "Call codex_followup mode wait again, or read codex://sessions/<session_id> for current progress.";
          }
          const payloadRecovery =
            waited.timeoutReason === "wait_cancelled"
              ? recovery
              : completed && waitAgent && !waitAgent.ok
                ? waitAgentRecovery
                : undefined;
          if (payloadRecovery) {
            payload.error = {
              message:
                waitAgent && !waitAgent.ok
                  ? agentFallbackErrorText(waitAgent, waitAgentRecovery) ?? `Codex task ${waitAgent.status}`
                  : waited.timeoutReason === "wait_cancelled"
                    ? "Codex wait was cancelled by the MCP client."
                    : undefined,
              recoverable: payloadRecovery.recoverable,
              kind: payloadRecovery.reason,
              retry_after_ms: payloadRecovery.retryAfterMs,
            };
          }
          if (includeDiagnostics(args.advanced)) {
            payload.turn = waited.turn;
            payload.diagnostics = {
              session: compactSession,
              ...progressPayload,
            };
          }
          return nativeTextResult(payload, waited.timeoutReason === "wait_cancelled" || (completed && !ok));
        }

        if (mode === "cancel") {
          await progress.send(`Cancelling Codex session ${args.session_id}`);
          const sessionBefore = sessionManager.get(args.session_id);
          if (!sessionBefore) {
            await progress.flush();
            return nativeErrorResult(new Error(`Unknown session_id: ${args.session_id}`), "codex_followup");
          }
          const wasActive = sessionBefore.active;
          const activeTurn = sessionBefore.activeTurn;
          const lastResult = sessionBefore.lastResult;
          if (!wasActive && sessionBefore.queuedTurns.length === 0 && lastResult?.status === "completed") {
            const cancelled = sessionManager.cancel(args.session_id, args.reason ?? "closed after completion");
            await progress.flush();
            const compactSession = compactSessionSnapshotForMcp(cancelled ?? sessionBefore);
            const compactResult = compactAgentResultForMcp(lastResult);
            const resultValue = compactResult.structuredOutput ?? compactResult.finalMessage;
            const resultText = stringifyResultValue(resultValue, compactResult.finalMessage);
            return nativeTextResult({
              ok: true,
              status: "already_completed",
              cancelled: false,
              was_active: false,
              summary: "Codex session had already completed.",
              result: resultText || "Codex session had already completed.",
              session_id: args.session_id,
              elapsed_ms: sessionProgressPayload(compactSession, compactResult).elapsed_ms,
              diagnostics: includeDiagnostics(args.advanced)
                ? { session: compactSession, result: compactResult }
                : undefined,
              hint: "The session had already completed. Start a new codex_task if more work is needed.",
            });
          }
          const cancelled = sessionManager.cancel(args.session_id, args.reason);
          await progress.flush();
          if (!cancelled) {
            return nativeErrorResult(new Error(`Unknown session_id: ${args.session_id}`), "codex_followup");
          }
          const compactSession = compactSessionSnapshotForMcp(cancelled);
          const partialMessage = sessionPartialMessage(compactSession);
          const activeTurnStartedMs = activeTurn?.createdAt ? Date.parse(activeTurn.createdAt) : NaN;
          const elapsedMs = Number.isFinite(activeTurnStartedMs)
            ? Math.max(0, Date.now() - activeTurnStartedMs)
            : sessionProgressPayload(compactSession).elapsed_ms;
          return nativeTextResult({
            ok: true,
            status: "cancelled",
            cancelled: true,
            was_active: wasActive,
            reason: args.reason,
            summary: wasActive
              ? `Codex session cancelled${typeof elapsedMs === "number" ? ` after ${(elapsedMs / 1000).toFixed(1)}s` : ""}.`
              : "Codex session marked cancelled (was idle).",
            result:
              partialMessage ||
              (wasActive
                ? "Codex was cancelled mid-turn; no partial output was captured."
                : "Codex session was already idle when cancelled."),
            session_id: args.session_id,
            cancelled_turn: activeTurn ? { ...activeTurn, status: "cancelled" } : undefined,
            elapsed_ms: elapsedMs,
            diagnostics: includeDiagnostics(args.advanced)
              ? {
                  session: compactSession,
                  ...sessionProgressPayload(compactSession),
                }
              : undefined,
            hint: "The session is closed. Start a new codex_task if more work is needed.",
          });
        }

        const description = args.description;
        const runOptions = publicRunOptions({
          ...args,
          description,
          prompt: prompt ?? "",
        });
        const { prompt: runPrompt, ...overrides } = runOptions;
        const wait = !args.background;
        const waitTimeout = capToolBlockingWaitTimeout(args.wait_timeout_ms, extra);
        if (wait) logCappedWait("codex_followup", waitTimeout, { sessionId: args.session_id, mode });
        await progress.send(
          mode === "steer"
            ? `Steering Codex session ${args.session_id}`
            : `Sending follow-up to Codex session ${args.session_id}`,
        );
        const run = () =>
          mode === "steer"
            ? sessionManager.steer(args.session_id, runPrompt, overrides, {
                wait: false,
                interruptCurrent: args.interrupt_current,
                waitSignal: extra?.signal,
              })
            : sessionManager.send(args.session_id, runPrompt, overrides, {
                wait: false,
                waitSignal: extra?.signal,
              });
        const response = await run();
        if (response.error || !response.session) {
          await progress.flush();
          return nativeErrorResult(new Error(response.error ?? "Codex follow-up did not return a session."), "codex_followup");
        }
        const delivery = "delivery" in response ? response.delivery : undefined;
        const turnId =
          response.turn && typeof (response.turn as { id?: unknown }).id === "string"
            ? (response.turn as { id: string }).id
            : undefined;
        const activeTurnId =
          delivery === "delivered_to_active_turn" &&
          response.session.activeTurn &&
          typeof response.session.activeTurn.id === "string"
            ? response.session.activeTurn.id
            : undefined;
        const waitTurnId = activeTurnId ?? turnId;
        if (wait && waitTurnId) {
          const waited = await withProgressHeartbeat(
            progress,
            () => codexLiveProgressMessage(args.session_id, `Still waiting for Codex session ${args.session_id}`),
            () =>
              withSessionMilestoneProgress(progress, args.session_id, () =>
                sessionManager.wait(args.session_id, waitTimeout.effectiveMs, waitTurnId, extra?.signal),
              ),
          );
          if (waited.error || !waited.session) {
            await progress.flush();
            return nativeErrorResult(new Error(waited.error ?? "Codex follow-up wait did not return a session."), "codex_followup");
          }
          if (waited.timeoutReason === "wait_cancelled") {
            await progress.flush();
            return nativeErrorResult(new Error("MCP request was cancelled by the client."), "codex_followup");
          }
          const compactSession = compactSessionSnapshotForMcp(waited.session);
          if (waited.completed) {
            if (!waited.result) {
              await progress.flush();
              return nativeErrorResult(
                new Error(waited.turn?.error ?? "Codex follow-up completed without a result."),
                "codex_followup",
              );
            }
            await reportAgentResult(progress, waited.result);
            await progress.flush();
            return nativeAgentResponse(waited.result, {
              description,
              prompt: prompt ?? "",
              tool: "codex_followup",
              session: compactSession,
              turn: waited.turn ?? response.turn,
              includeDiagnostics: includeDiagnostics(args.advanced),
              includeSessionId: true,
            });
          }
          await progress.flush();
          const progressPayload = sessionProgressPayload(compactSession);
          const payload: Record<string, unknown> = {
            ok: true,
            status: "running",
            completed: false,
            timeoutReason: "wait_timeout",
            summary: "Codex follow-up is still running.",
            result: "Codex follow-up is still running.",
            session_id: args.session_id,
            turn: waited.turn ?? response.turn,
            delivery,
            last_milestone_seq: waited.session.lastMilestoneSeq,
            elapsed_ms: progressPayload.elapsed_ms,
            ...waitTimeoutFields(waitTimeout),
            hint: waitTimeout.capped
              ? "This wait returned at the server responsiveness cap. Call codex_followup mode wait again with this session_id and turn_id, or read codex://sessions/<session_id>."
              : "Call codex_followup mode wait again with this session_id and turn_id, or read codex://sessions/<session_id>.",
          };
          if (includeDiagnostics(args.advanced)) {
            payload.diagnostics = {
              session: compactSession,
              ...progressPayload,
            };
          }
          return nativeTextResult(payload);
        }
        if (response.result) await reportAgentResult(progress, response.result);
        await progress.flush();
        const compactSession = compactSessionSnapshotForMcp(response.session);
        if (response.result) {
          return nativeAgentResponse(response.result, {
            description,
            prompt: prompt ?? "",
            tool: "codex_followup",
            session: compactSession,
            turn: response.turn,
            includeDiagnostics: includeDiagnostics(args.advanced),
            includeSessionId: true,
          });
        }
        const payload: Record<string, unknown> = {
          ok: true,
          status: compactSession.active ? "running" : "queued",
          summary:
            mode === "steer"
              ? `Codex steering ${delivery ?? "queued"}.`
              : "Codex follow-up queued.",
          result:
            mode === "steer"
              ? `Codex steering ${delivery ?? "queued"}.`
              : "Codex follow-up queued.",
          session_id: args.session_id,
          turn: response.turn,
          delivery,
          hint: "Use codex_wait_any for parallel background tasks, or codex_followup mode wait, steer, or cancel with this session_id.",
        };
        if (includeDiagnostics(args.advanced)) {
          payload.diagnostics = {
            session: compactSession,
            ...sessionProgressPayload(compactSession),
          };
        }
        return nativeTextResult(payload);
      } catch (error) {
        await progress.flush();
        logger.error("codex_followup.failed", { error: errorForLog(error) });
        return nativeErrorResult(error, "codex_followup");
      }
    });
  },
);

registerTool(
  "codex_wait_any",
  {
    title: "Wait For Any Task",
    description:
      "Use this when you have several background Codex session_ids and want to harvest results as they finish. Waits until any listed Codex background session reaches a terminal state, then returns that session's result and remaining_session_ids. Long waits are capped into responsive slices; call again if completed=false. This is a Codex extension beyond native Task.",
    inputSchema: {
      session_ids: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(32)
        .describe("Session ids returned by previous codex_task or codex_task_group calls."),
      wait_timeout_ms: z
        .number()
        .int()
        .positive()
        .max(86_400_000)
        .default(defaultBlockingWaitTimeoutMs)
        .describe(
          "Requested total wait. The server caps long waits to keep Claude responsive; if no session finishes, returns completed=false.",
        ),
    },
  },
  async (args: NativeWaitAnyInput, extra) => {
    return loggedToolCall("codex_wait_any", args, extra, async () => {
      const progress = createProgressReporter(extra);
      const startedAt = Date.now();
      const sessionIds = [...new Set(args.session_ids)];
      const waitTimeout = capToolBlockingWaitTimeout(args.wait_timeout_ms, extra);
      const unsubscribers: Array<() => void> = [];
      try {
        logCappedWait("codex_wait_any", waitTimeout, { sessionIds });
        await progress.send(`Waiting for ${sessionIds.length} Codex session${sessionIds.length === 1 ? "" : "s"}`);
        for (const sessionId of sessionIds) {
          unsubscribers.push(
            sessionManager.subscribeMilestones(sessionId, (milestone) => {
              const message = formatMilestoneProgress(milestone);
              if (message) void progress.send(`${sessionId}: ${message}`);
            }),
          );
        }
        const waited = await withProgressHeartbeat(
          progress,
          () => {
            const active = sessionIds
              .map((sessionId) => codexLiveProgressMessage(sessionId, ""))
              .filter(Boolean)
              .slice(0, 2);
            return active.length > 0
              ? active.join(" | ")
              : `Still waiting for ${sessionIds.length} Codex session${sessionIds.length === 1 ? "" : "s"}`;
          },
          () => sessionManager.waitAny(sessionIds, waitTimeout.effectiveMs, extra?.signal),
        );
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        await progress.flush();

        if (waited.error) return nativeErrorResult(new Error(waited.error), "codex_wait_any");
        if (waited.timeoutReason === "wait_cancelled") {
          return nativeErrorResult(new Error("MCP request was cancelled by the client."), "codex_wait_any");
        }

        const elapsedMs = Date.now() - startedAt;
        if (!waited.completed || !waited.session) {
          return nativeTextResult({
            ok: true,
            status: "running",
            completed: false,
            timeoutReason: "wait_timeout",
            session_ids: waited.remainingSessionIds ?? sessionIds,
            elapsed_ms: elapsedMs,
            ...waitTimeoutFields(waitTimeout),
            hint: waitTimeout.capped
              ? "No session completed before the server responsiveness cap. Call codex_wait_any again with session_ids, or inspect codex://sessions/<id>."
              : "No session completed within the wait window. Call codex_wait_any again or inspect codex://sessions/<id>.",
          });
        }

        const compactResult = waited.result ? compactAgentResultForMcp(waited.result) : undefined;
        const recovery = waited.result ? recoveryForAgentResult(waited.result) : undefined;
        const resultValue = compactResult?.structuredOutput ?? compactResult?.finalMessage;
        const resultText = compactResult
          ? visibleAgentAnswer(compactResult, recovery)
          : waited.session.error ?? `Codex session ${sessionResourceStatus(waited.session)}`;
        const status =
          compactResult?.status ??
          (waited.session.status === "cancelled"
            ? "cancelled"
            : waited.session.status === "failed"
              ? "failed"
              : "completed");
        await progress.send(`Codex session ${waited.session.id} finished`, { force: true });
        await progress.flush();
        const payload: Record<string, unknown> = {
          ok: status === "completed",
          status,
          completed: true,
          session_id: waited.session.id,
          result: resultText || `Codex session ${status}.`,
          remaining_session_ids: waited.remainingSessionIds ?? sessionIds.filter((id) => id !== waited.session?.id),
          elapsed_ms: elapsedMs,
          last_milestone_seq: waited.session.lastMilestoneSeq,
          ...waitTimeoutFields(waitTimeout),
          hint: "Call codex_wait_any again with remaining_session_ids to collect the next finisher.",
        };
        if (compactResult && recovery) {
          payload.error = {
            message: agentFallbackErrorText(compactResult, recovery) ?? `Codex task ${status}`,
            recoverable: recovery.recoverable,
            kind: recovery.reason,
            retry_after_ms: recovery.retryAfterMs,
          };
        }
        return nativeTextResult(payload, status === "failed" || status === "cancelled");
      } catch (error) {
        await progress.flush();
        logger.error("codex_wait_any.failed", { error: errorForLog(error) });
        return nativeErrorResult(error, "codex_wait_any");
      } finally {
        for (const unsubscribe of unsubscribers) unsubscribe();
      }
    });
  },
);

registerLegacyTool(
  "ask_codex_parallel",
  {
    title: "Ask parallel Codex agents",
    description:
      "Preferred front door for launching multiple independent Codex agents concurrently. Use this automatically for natural requests like run several Codex agents, ask Codex in parallel, use multiple Codex subagents, or split review work across independent Codex workstreams. Defaults are read-only and bounded. Pass project_dir so every Codex agent works in Claude's current project.",
    inputSchema: {
      tasks: z
        .array(frontDoorParallelTaskSchema)
        .min(1)
        .max(12)
        .describe(
          "Independent Codex tasks. Use names like api, tests, security, docs, performance, or ui when helpful.",
        ),
      max_parallel: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum concurrent Codex processes. Use 2-4 for most responsive parallel reviews."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("ask_codex_parallel", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const total = args.tasks.length * 2 + 1;
        let completed = 0;
        let failed = 0;
        await progress.send(`Queued ${args.tasks.length} Codex agents`, { total });
        const results = await withProgressHeartbeat(
          progress,
          `Still running ${args.tasks.length} Codex agents`,
          () =>
            runQueuedAgents(toFrontDoorParallelRunOptions(args), {
              signal: extra?.signal,
              onStart: (queuedMs, label) => {
                void progress.send(`Started ${label ?? "Codex agent"} after ${queuedMs}ms queued`, { total });
              },
              onComplete: async (result) => {
                completed += 1;
                if (!result.ok) failed += 1;
                const last = completed === args.tasks.length;
                const message = last
                  ? failed === 0
                    ? `Parallel Codex run completed (${completed}/${args.tasks.length})`
                    : `Parallel Codex run finished with errors (${completed}/${args.tasks.length})`
                  : `${result.ok ? "Completed" : "Finished"} ${result.name ?? "Codex agent"} (${completed}/${args.tasks.length})`;
                await progress.send(message, last ? { progress: total, total } : { total, reserveFinal: true });
              },
            }),
          { total, reserveFinal: true },
        );
        const ok = results.every((result) => result.ok);
        await progress.flush();
        return jsonResult(
          {
            ok,
            agents: compactAgentResultsForMcp(results),
            recoveries: results.map(recoveryForAgentResult),
          },
          !ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("ask_codex_parallel.failed", { error: errorForLog(error) });
        return errorResult(error, "ask_codex_parallel");
      }
    });
  },
);

registerLegacyTool(
  "run_agents",
  {
    title: "Run parallel Codex agents",
    description:
      "Compatibility/manual tool for launching multiple independent OpenAI Codex agents concurrently. Prefer ask_codex_parallel for normal Claude delegation. Split work by clear ownership, pass project_dir, keep defaults read-only, and use max_parallel to bound concurrency. For explicit non-sandbox/full-access requests, set dangerously_bypass_approvals_and_sandbox true.",
    inputSchema: {
      agents: z
        .array(parallelAgentSchema)
        .min(1)
        .max(12)
        .describe(
          "Independent Codex agent tasks. Use names like api, tests, security, docs, performance, or ui when helpful.",
        ),
      max_parallel: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum concurrent Codex processes. Use 2-4 for most responsive parallel reviews."),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("run_agents", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const total = args.agents.length * 2 + 1;
        let completed = 0;
        let failed = 0;
        await progress.send(`Queued ${args.agents.length} Codex agents`, { total });
        const results = await withProgressHeartbeat(
          progress,
          `Still running ${args.agents.length} Codex agents`,
          () =>
            runQueuedAgents(toParallelRunOptions(args), {
              signal: extra?.signal,
              onStart: (queuedMs, label) => {
                void progress.send(`Started ${label ?? "Codex agent"} after ${queuedMs}ms queued`, { total });
              },
              onComplete: async (result) => {
                completed += 1;
                if (!result.ok) failed += 1;
                const last = completed === args.agents.length;
                const message = last
                  ? failed === 0
                    ? `Parallel Codex run completed (${completed}/${args.agents.length})`
                    : `Parallel Codex run finished with errors (${completed}/${args.agents.length})`
                  : `${result.ok ? "Completed" : "Finished"} ${result.name ?? "Codex agent"} (${completed}/${args.agents.length})`;
                await progress.send(message, last ? { progress: total, total } : { total, reserveFinal: true });
              },
            }),
          { total, reserveFinal: true },
        );
        const ok = results.every((result) => result.ok);
        await progress.flush();
        return jsonResult(
          {
            ok,
            agents: compactAgentResultsForMcp(results),
            recoveries: results.map(recoveryForAgentResult),
          },
          !ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("run_agents.failed", { error: errorForLog(error) });
        return errorResult(error, "run_agents");
      }
    });
  },
);

registerLegacyTool(
  "run_agents_aggregate",
  {
    title: "Run and aggregate parallel Codex agents",
    description:
      "Launch multiple independent Codex agents and return both individual results and a deterministic aggregation object with summaries, structured findings, failed agents, and a recommended next action.",
    inputSchema: {
      agents: z
        .array(parallelAgentSchema)
        .min(1)
        .max(12)
        .describe("Independent Codex agent tasks. Use output_contract when you need structured findings."),
      max_parallel: z.number().int().min(1).max(8).default(4),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("run_agents_aggregate", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const total = args.agents.length * 2 + 1;
        let completed = 0;
        await progress.send(`Queued ${args.agents.length} Codex agents for aggregation`, { total });
        const results = await withProgressHeartbeat(
          progress,
          `Still running ${args.agents.length} Codex agents for aggregation`,
          () =>
            runQueuedAgents(toParallelRunOptions(args), {
              signal: extra?.signal,
              onStart: (queuedMs, label) => {
                void progress.send(`Started ${label ?? "Codex agent"} after ${queuedMs}ms queued`, { total });
              },
              onComplete: async () => {
                completed += 1;
                const last = completed === args.agents.length;
                await progress.send(
                  last
                    ? `Aggregating ${completed}/${args.agents.length} Codex results`
                    : `Completed ${completed}/${args.agents.length} Codex agents`,
                  last ? { progress: total, total } : { total, reserveFinal: true },
                );
              },
            }),
          { total, reserveFinal: true },
        );
        const aggregation = aggregateAgentResults(results);
        await progress.flush();
        return jsonResult(
          {
            ok: aggregation.ok,
            aggregation,
            agents: compactAgentResultsForMcp(results),
            recoveries: results.map(recoveryForAgentResult),
          },
          !aggregation.ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("run_agents_aggregate.failed", { error: errorForLog(error) });
        return errorResult(error, "run_agents_aggregate");
      }
    });
  },
);

registerLegacyTool(
  "start_agents_run",
  {
    title: "Start parallel Codex agents",
    description:
      "Start multiple Codex agents asynchronously and return a job_id immediately. Use for broad or slow parallel Codex reviews; poll with get_agent_run or wait_agent_run.",
    inputSchema: {
      agents: z
        .array(parallelAgentSchema)
        .min(1)
        .max(12)
        .describe("Independent Codex agent tasks."),
      max_parallel: z.number().int().min(1).max(8).default(4),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("start_agents_run", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        throwIfRequestAborted(extra);
        await progress.send(`Queued asynchronous run for ${args.agents.length} Codex agents`);
        const job = jobManager.startAgents(toParallelRunOptions(args));
        await progress.send(`Started Codex job ${job.id}`);
        await progress.flush();
        return jsonResult({ job, durability: ephemeralJobDurability() });
      } catch (error) {
        await progress.flush();
        logger.error("start_agents_run.failed", { error: errorForLog(error) });
        return errorResult(error, "start_agents_run");
      }
    });
  },
);

registerLegacyTool(
  "get_agent_run",
  {
    title: "Get Codex run job",
    description: "Return current status and result, if available, for an asynchronous Codex job.",
    inputSchema: {
      job_id: jobIdSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("get_agent_run", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send(`Checking Codex job ${args.job_id}`);
      await progress.flush();
      const job = jobManager.get(args.job_id);
      if (!job) {
        await progress.flush();
        return errorResult(new Error(`Unknown job_id: ${args.job_id}`), "get_agent_run");
      }
      return jsonResult({ job: compactJobSnapshotForMcp(job) });
    });
  },
);

registerLegacyTool(
  "wait_agent_run",
  {
    title: "Wait for Codex run job",
    description:
      "Wait up to timeout_ms for an asynchronous Codex job to complete. Returns the current job state if it is still running.",
    inputSchema: {
      job_id: jobIdSchema,
      timeout_ms: z.number().int().positive().max(300_000).default(30_000),
    },
  },
  async (args, extra) => {
    return loggedToolCall("wait_agent_run", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send(`Waiting for Codex job ${args.job_id}`);
      const job = await jobManager.wait(args.job_id, args.timeout_ms, extra?.signal);
      const waitCancelled = Boolean(extra?.signal?.aborted);
      if (!job) return errorResult(new Error(`Unknown job_id: ${args.job_id}`), "wait_agent_run");
      if (job.completedAt) await progress.send(`Codex job ${job.status}`);
      await progress.flush();
      const waitReason = job.completedAt ? undefined : waitCancelled ? "wait_cancelled" : "wait_timeout";
      const completed = Boolean(job.completedAt);
      return jsonResult(
        {
          completed,
          job: compactJobSnapshotForMcp(job),
          timeoutReason: waitReason,
          recovery: recoveryForWait("agent_job", waitReason),
          note: completed
            ? undefined
            : "The Codex job is still managed by this MCP server. Use get_agent_run or wait_agent_run again.",
        },
        waitCancelled || job.status === "failed" || job.status === "cancelled",
      );
    });
  },
);

registerLegacyTool(
  "cancel_agent_run",
  {
    title: "Cancel Codex run job",
    description:
      "Cancel a queued or running asynchronous Codex job. Running Codex child processes are terminated with SIGTERM and then SIGKILL if needed.",
    inputSchema: {
      job_id: jobIdSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("cancel_agent_run", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send(`Cancelling Codex job ${args.job_id}`);
      await progress.flush();
      const job = jobManager.cancel(args.job_id);
      if (!job) return errorResult(new Error(`Unknown job_id: ${args.job_id}`), "cancel_agent_run");
      return jsonResult({ job: compactJobSnapshotForMcp(job) });
    });
  },
);

registerDebugTool(
  "codex_session_start",
  {
    title: "Codex Session Start",
    description:
      "Native Claude-like front door for starting a persistent Codex subagent that keeps context across prompts. Returns a session id immediately by default so Claude can keep working, poll progress, queue prompts, or steer the active turn.",
    inputSchema: {
      description: z
        .string()
        .trim()
        .min(1)
        .describe("Short human-readable label for the persistent Codex session."),
      prompt: z.string().min(1).describe("Initial prompt for the persistent Codex session."),
      subagent_type: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional Claude-style role label such as explorer, reviewer, security, performance, tests, ui, or docs."),
      session_name: z.string().trim().min(1).optional().describe("Optional human label for this session."),
      wait_for_completion: z
        .boolean()
        .default(false)
        .describe("When true, wait for the initial turn to finish before returning. Leave false for long-running sessions."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("codex_session_start", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const runOptions = {
          ...toNativeSessionRunOptions(args),
          ephemeral: false,
        };
        await progress.send(`Starting Codex session: ${args.description}`);
        if (args.wait_for_completion) {
          const { session, result } = await withProgressHeartbeat(
            progress,
            `Still starting Codex session: ${args.description}`,
            () => sessionManager.start(withRequestAbort(runOptions, extra), { sessionName: args.session_name }),
          );
          await reportAgentResult(progress, result);
          await progress.flush();
          const compactSession = compactSessionSnapshotForMcp(session);
          return jsonResult(
            {
              ...nativeAgentPayload(result, {
                description: args.description,
                prompt: args.prompt,
                tool: "codex_session_start",
              }),
              session: compactSession,
              ...sessionProgressPayload(compactSession),
            },
            !result.ok,
          );
        }
        throwIfRequestAborted(extra);
        const { session, turn } = sessionManager.startAsync(runOptions, { sessionName: args.session_name });
        await progress.flush();
        const compactSession = compactSessionSnapshotForMcp(session);
        return jsonResult({
          ok: true,
          status: "running",
          result: `Codex session ${session.id} started.`,
          summary: `Started Codex session: ${args.description}`,
          confidence: "high",
          session: compactSession,
          ...sessionProgressPayload(compactSession),
          turn,
          next_action:
            "Use codex_session_status for progress, codex_session_wait when Claude needs completion, codex_session_prompt for follow-ups, or codex_session_steer for active redirection.",
        });
      } catch (error) {
        await progress.flush();
        logger.error("codex_session_start.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_session_start");
      }
    });
  },
);

registerDebugTool(
  "codex_session_prompt",
  {
    title: "Codex Session Prompt",
    description:
      "Send a normal follow-up prompt to an existing persistent Codex session. If the session is active, this queues behind the active turn; if idle, it starts the next turn in the same Codex context.",
    inputSchema: {
      session_id: sessionIdSchema,
      prompt: z.string().min(1).describe("Follow-up prompt for the persistent Codex session."),
      description: z.string().trim().min(1).optional().describe("Optional short label for this follow-up turn."),
      subagent_type: z.string().trim().min(1).optional().describe("Optional role label to include in the prompt context."),
      wait_for_completion: z
        .boolean()
        .default(false)
        .describe("When true, wait for this turn to finish before returning. Leave false when the session is already running."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("codex_session_prompt", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Queueing prompt for Codex session ${args.session_id}`);
        const run = () =>
          sessionManager.send(args.session_id, nativeTaskPrompt(args), toNativeSessionRunOptions(args), {
            wait: args.wait_for_completion,
            waitSignal: extra?.signal,
          });
        const { session, turn, result, error } = args.wait_for_completion
          ? await withProgressHeartbeat(progress, `Still waiting for Codex session ${args.session_id}`, run)
          : await run();
        if (error || !session) {
          await progress.flush();
          return errorResult(new Error(error ?? "Codex session prompt did not return a session."), "codex_session_prompt");
        }
        if (result) await reportAgentResult(progress, result);
        await progress.flush();
        const compactSession = compactSessionSnapshotForMcp(session);
        return jsonResult(
          {
            ok: result ? result.ok : true,
            status: result?.status ?? "queued",
            result: result ? stringifyResultValue(result.structuredOutput ?? result.finalMessage, result.finalMessage) : "Prompt queued.",
            summary: result ? firstUsefulLine(result.finalMessage, `Codex turn ${result.status}`) : "Queued Codex session prompt.",
            confidence: result?.ok === false ? "low" : "high",
            session: compactSession,
            ...sessionProgressPayload(compactSession),
            turn,
            queued: !args.wait_for_completion,
            agent: result ? compactAgentResultForMcp(result) : undefined,
            recovery: result ? recoveryForAgentResult(result) : undefined,
            next_action: result
              ? suggestedActionForAgent(result, recoveryForAgentResult(result))
              : "Use codex_session_status to inspect progress or codex_session_wait when Claude needs the queued turn result.",
          },
          result ? !result.ok : false,
        );
      } catch (error) {
        await progress.flush();
        logger.error("codex_session_prompt.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_session_prompt");
      }
    });
  },
);

registerDebugTool(
  "codex_session_steer",
  {
    title: "Codex Session Steer",
    description:
      "Steer an active Codex session. App-server sessions deliver this into the running turn. If the session fell back to codex exec, steering becomes a high-priority queued turn.",
    inputSchema: {
      session_id: sessionIdSchema,
      prompt: z.string().min(1).describe("Steering instruction to apply to the Codex session."),
      interrupt_current: z
        .boolean()
        .default(false)
        .describe("Cancel the currently running turn and run this steering prompt next. Leave false to avoid losing in-flight work."),
      wait_for_completion: z
        .boolean()
        .default(false)
        .describe("When true, wait until the steered active turn or queued fallback steering turn completes."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("codex_session_steer", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Steering Codex session ${args.session_id}`);
        const runOptions = toNativeSessionRunOptions({ ...args, description: "Steer Codex session" });
        const run = () =>
          sessionManager.steer(args.session_id, args.prompt, runOptions, {
            wait: args.wait_for_completion,
            interruptCurrent: args.interrupt_current,
            waitSignal: extra?.signal,
          });
        const { session, turn, result, delivery, error } = args.wait_for_completion
          ? await withProgressHeartbeat(progress, `Still waiting for Codex session steering ${args.session_id}`, run)
          : await run();
        if (error || !session) {
          await progress.flush();
          return errorResult(new Error(error ?? "Codex steering did not return a session."), "codex_session_steer");
        }
        if (result) await reportAgentResult(progress, result);
        await progress.flush();
        const compactSession = compactSessionSnapshotForMcp(session);
        return jsonResult(
          {
            ok: result ? result.ok : true,
            status: result?.status ?? "queued",
            result: result ? stringifyResultValue(result.structuredOutput ?? result.finalMessage, result.finalMessage) : "Steering delivered.",
            summary: result ? firstUsefulLine(result.finalMessage, `Codex steering ${result.status}`) : `Steering ${delivery}.`,
            confidence: result?.ok === false ? "low" : "high",
            session: compactSession,
            ...sessionProgressPayload(compactSession),
            turn,
            delivery,
            queued: !args.wait_for_completion,
            agent: result ? compactAgentResultForMcp(result) : undefined,
            recovery: result ? recoveryForAgentResult(result) : undefined,
            next_action: result
              ? suggestedActionForAgent(result, recoveryForAgentResult(result))
              : delivery === "delivered_to_active_turn"
                ? "Use codex_session_status to inspect live progress or codex_session_wait to wait for the steered turn."
                : "Use codex_session_wait to wait for the queued steering turn.",
          },
          result ? !result.ok : false,
        );
      } catch (error) {
        await progress.flush();
        logger.error("codex_session_steer.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_session_steer");
      }
    });
  },
);

registerDebugTool(
  "codex_session_status",
  {
    title: "Codex Session Status",
    description:
      "Inspect a persistent Codex session: status, active turn, queued turns, partial result, last event, elapsed time, and the next suggested polling delay.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_session_status", args, extra, async () => {
      const session = sessionManager.get(args.session_id);
      if (!session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "codex_session_status");
      const compactSession = compactSessionSnapshotForMcp(session);
      return jsonResult({
        ok: true,
        session: compactSession,
        ...sessionProgressPayload(compactSession),
        next_action: compactSession.active
          ? "Poll codex_session_status for progress, call codex_session_wait when Claude needs completion, or codex_session_steer to redirect active work."
          : "Use codex_session_prompt for follow-up work in this same Codex context.",
      });
    }),
);

registerDebugTool(
  "codex_session_wait",
  {
    title: "Codex Session Wait",
    description:
      "Wait until a Codex session becomes idle, or until a specific queued/running turn completes. Use after codex_session_start, codex_session_prompt, or codex_session_steer.",
    inputSchema: {
      session_id: sessionIdSchema,
      turn_id: z.string().trim().min(1).optional().describe("Optional turn id to wait for. Omit to wait until the whole session queue is idle."),
      timeout_ms: z.number().int().positive().max(86_400_000).default(defaultBlockingWaitTimeoutMs),
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_session_wait", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const waitTimeout = capToolBlockingWaitTimeout(args.timeout_ms, extra);
        logCappedWait("codex_session_wait", waitTimeout, { sessionId: args.session_id });
        await progress.send(`Waiting for Codex session ${args.session_id}`);
        const waited = await withProgressHeartbeat(
          progress,
          `Still waiting for Codex session ${args.session_id}`,
          () => sessionManager.wait(args.session_id, waitTimeout.effectiveMs, args.turn_id, extra?.signal),
        );
        await progress.flush();
        if (waited.error || !waited.session) {
          return errorResult(new Error(waited.error ?? "Codex session was not found."), "codex_session_wait");
        }
        const compactSession = compactSessionSnapshotForMcp(waited.session);
        const recovery = recoveryForWait("codex_session", waited.timeoutReason);
        return jsonResult({
          ok: waited.timeoutReason !== "wait_cancelled",
          completed: waited.completed,
          timeoutReason: waited.timeoutReason,
          session: compactSession,
          ...sessionProgressPayload(compactSession),
          turn: waited.turn,
          ...waitTimeoutFields(waitTimeout),
          recovery,
          suggested_next_action: recovery?.recommendedAction,
          next_action:
            recovery?.recommendedAction ??
            "Use session.lastResult directly, or send a follow-up prompt if more Codex context is needed.",
        }, waited.timeoutReason === "wait_cancelled");
      } catch (error) {
        await progress.flush();
        logger.error("codex_session_wait.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_session_wait");
      }
    }),
);

registerDebugTool(
  "codex_sessions",
  {
    title: "Codex Sessions",
    description: "List persistent Codex sessions held by this daemonless MCP server process.",
    inputSchema: {},
  },
  async (args, extra) =>
    loggedToolCall("codex_sessions", args, extra, async () =>
      jsonResult({ ok: true, sessions: sessionManager.list().map(compactSessionSnapshotForMcp) }),
    ),
);

registerDebugTool(
  "codex_session_recover",
  {
    title: "Codex Session Recover",
    description:
      "Reattach a durable Codex session after Claude Code or the MCP server restarted. Use before codex_session_prompt when Claude has an older persisted session id.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_session_recover", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send(`Recovering Codex session ${args.session_id}`);
      const recovered = await sessionManager.recover(args.session_id);
      await progress.flush();
      if (recovered.error || !recovered.session) {
        return errorResult(new Error(recovered.error ?? "Codex session could not be recovered."), "codex_session_recover");
      }
      const compactSession = compactSessionSnapshotForMcp(recovered.session);
      return jsonResult({
        ok: true,
        recovered: recovered.recovered,
        session: compactSession,
        ...sessionProgressPayload(compactSession),
        next_action: "Use codex_session_prompt to continue this recovered Codex context.",
      });
    }),
);

registerDebugTool(
  "codex_session_cancel",
  {
    title: "Codex Session Cancel",
    description: "Cancel the currently running turn for a persistent Codex session, or mark an idle session cancelled.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_session_cancel", args, extra, async () => {
      const session = sessionManager.cancel(args.session_id);
      if (!session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "codex_session_cancel");
      const compactSession = compactSessionSnapshotForMcp(session);
      return jsonResult({
        ok: true,
        session: compactSession,
        ...sessionProgressPayload(compactSession),
        next_action: "Start a new Codex session only if more work is needed.",
      });
    }),
);

registerLegacyTool(
  "start_codex_session",
  {
    title: "Start Codex session",
    description:
      "Preferred front door for starting a multi-turn Codex worker that keeps context across later prompts. Use this when the user asks for a long-running Codex subagent, a Codex agent with memory, or to continue working with the same Codex context. Pass project_dir on the initial call so follow-ups remain pinned to the same project.",
    inputSchema: {
      task: z.string().min(1).describe("Initial task for the persistent Codex session."),
      session_name: z.string().trim().min(1).optional().describe("Optional human label for this session."),
      name: z.string().trim().min(1).optional().describe("Optional label for the initial Codex run."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("start_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send("Starting persistent Codex session");
        const { session, result } = await withProgressHeartbeat(
          progress,
          "Still starting persistent Codex session",
          () =>
            sessionManager.start(
              withRequestAbort(
                {
                  ...toFrontDoorRunOptions(args),
                  ephemeral: false,
                },
                extra,
              ),
              { sessionName: args.session_name },
            ),
        );
        await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            agent: compactAgentResultForMcp(result),
            recovery: recoveryForAgentResult(result),
          },
          !result.ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("start_codex_session.failed", { error: errorForLog(error) });
        return errorResult(error, "start_codex_session");
      }
    });
  },
);

registerLegacyTool(
  "start_codex_session_async",
  {
    title: "Start long-running Codex session",
    description:
      "Start a persistent Codex session and return immediately with a session id while the first Codex turn continues in the background. Use this for long-running Codex work that Claude may need to inspect, queue more prompts onto, or steer while it is running.",
    inputSchema: {
      task: z.string().min(1).describe("Initial task for the long-running persistent Codex session."),
      session_name: z.string().trim().min(1).optional().describe("Optional human label for this session."),
      name: z.string().trim().min(1).optional().describe("Optional label for the initial Codex run."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("start_codex_session_async", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        throwIfRequestAborted(extra);
        await progress.send("Starting long-running Codex session");
        const { session, turn } = sessionManager.startAsync(
          {
            ...toFrontDoorRunOptions(args),
            ephemeral: false,
          },
          { sessionName: args.session_name },
        );
        await progress.flush();
        const compactSession = compactSessionSnapshotForMcp(session);
        return jsonResult({
          session: compactSession,
          ...sessionProgressPayload(compactSession),
          turn,
          next_action:
            "Session is running in the background. Use get_codex_session for progress, wait_codex_session to wait, send_codex_session_prompt for follow-ups, or steer_codex_session for active redirection.",
          note:
            "Session is running in the background. Use get_codex_session, wait_codex_session, send_codex_session_prompt, or steer_codex_session with this session_id.",
        });
      } catch (error) {
        await progress.flush();
        logger.error("start_codex_session_async.failed", { error: errorForLog(error) });
        return errorResult(error, "start_codex_session_async");
      }
    });
  },
);

registerLegacyTool(
  "continue_codex_session",
  {
    title: "Continue Codex session",
    description:
      "Preferred front door for sending a follow-up task to an existing Codex session. Use this after start_codex_session when the same Codex subagent should keep context. You normally do not need to pass project_dir again; the session preserves it.",
    inputSchema: {
      session_id: sessionIdSchema,
      task: z.string().min(1).describe("Follow-up task for the persistent Codex session."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("continue_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Resuming Codex session ${args.session_id}`);
        const { session, result, error } = await withProgressHeartbeat(
          progress,
          `Still running Codex session ${args.session_id}`,
          () =>
            sessionManager.send(args.session_id, args.task, toFrontDoorRunOptions(args), {
              waitSignal: extra?.signal,
            }),
        );
        if (error || !session || !result) {
          await progress.flush();
          return jsonResult(
            {
              ok: false,
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              recovery: recoveryForError(new Error(error ?? "Codex session did not return a result."), "continue_codex_session"),
              suggested_next_action: recoveryForError(new Error(error ?? "Codex session did not return a result."), "continue_codex_session").recommendedAction,
            },
            true,
          );
        }
        await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            agent: compactAgentResultForMcp(result),
            recovery: recoveryForAgentResult(result),
          },
          !result.ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("continue_codex_session.failed", { error: errorForLog(error) });
        return errorResult(error, "continue_codex_session");
      }
    });
  },
);

registerLegacyTool(
  "send_codex_session_prompt",
  {
    title: "Queue Codex session prompt",
    description:
      "Send an additional prompt to a Codex session. If the session is already running, this queues the prompt and preserves Codex context; if idle, it starts the next turn. Defaults to returning immediately so Claude can keep working or poll later.",
    inputSchema: {
      session_id: sessionIdSchema,
      task: z.string().min(1).describe("Additional prompt for this Codex session."),
      wait_for_completion: z
        .boolean()
        .default(false)
        .describe("When true, wait for this queued turn to finish before returning. Leave false for long-running sessions."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("send_codex_session_prompt", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Queueing prompt for Codex session ${args.session_id}`);
        const run = () =>
          sessionManager.send(args.session_id, args.task, toFrontDoorRunOptions(args), {
            wait: args.wait_for_completion,
            waitSignal: extra?.signal,
          });
        const { session, turn, result, error } = args.wait_for_completion
          ? await withProgressHeartbeat(
              progress,
              `Still waiting for Codex session prompt ${args.session_id}`,
              run,
            )
          : await run();
        if (error || !session) {
          await progress.flush();
          return jsonResult(
            {
              ok: false,
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              turn,
              recovery: recoveryForError(new Error(error ?? "Codex session prompt did not return a session."), "send_codex_session_prompt"),
              suggested_next_action: recoveryForError(new Error(error ?? "Codex session prompt did not return a session."), "send_codex_session_prompt").recommendedAction,
            },
            true,
          );
        }
        if (result) await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            turn,
            queued: !args.wait_for_completion,
            agent: result ? compactAgentResultForMcp(result) : undefined,
            recovery: result ? recoveryForAgentResult(result) : undefined,
            next_action: result
              ? suggestedActionForAgent(result, recoveryForAgentResult(result))
              : "Use get_codex_session to inspect progress or wait_codex_session when Claude needs the queued turn result.",
          },
          result ? !result.ok : false,
        );
      } catch (error) {
        await progress.flush();
        logger.error("send_codex_session_prompt.failed", { error: errorForLog(error) });
        return errorResult(error, "send_codex_session_prompt");
      }
    });
  },
);

registerLegacyTool(
  "steer_codex_session",
  {
    title: "Steer Codex session",
    description:
      "Send a steering prompt to an active Codex session. App-server sessions deliver this into the currently running turn via Codex turn/steer. If the session fell back to codex exec, steering is delivered as the next high-priority persistent turn. Set interrupt_current true only to cancel the active turn and run the steering prompt next.",
    inputSchema: {
      session_id: sessionIdSchema,
      steering_prompt: z
        .string()
        .min(1)
        .describe("Steering instruction to apply to the Codex session, for example a changed priority or constraint."),
      interrupt_current: z
        .boolean()
        .default(false)
        .describe("Cancel the currently running turn and run this steering prompt next. Leave false to avoid losing in-flight work."),
      wait_for_completion: z
        .boolean()
        .default(false)
        .describe("When true, wait until the steered active turn or queued fallback steering turn completes. Leave false for active long-running sessions."),
      ...frontDoorInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("steer_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Steering Codex session ${args.session_id}`);
        const run = () =>
          sessionManager.steer(
            args.session_id,
            args.steering_prompt,
            toFrontDoorRunOptions({ ...args, task: args.steering_prompt }),
            {
              wait: args.wait_for_completion,
              interruptCurrent: args.interrupt_current,
              waitSignal: extra?.signal,
            },
          );
        const { session, turn, result, delivery, error } = args.wait_for_completion
          ? await withProgressHeartbeat(
              progress,
              `Still waiting for Codex session steering ${args.session_id}`,
              run,
            )
          : await run();
        if (error || !session) {
          await progress.flush();
          return jsonResult(
            {
              ok: false,
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              turn,
              delivery,
              recovery: recoveryForError(new Error(error ?? "Codex steering did not return a session."), "steer_codex_session"),
              suggested_next_action: recoveryForError(new Error(error ?? "Codex steering did not return a session."), "steer_codex_session").recommendedAction,
            },
            true,
          );
        }
        if (result) await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            turn,
            delivery,
            queued: !args.wait_for_completion,
            agent: result ? compactAgentResultForMcp(result) : undefined,
            recovery: result ? recoveryForAgentResult(result) : undefined,
            next_action: result
              ? suggestedActionForAgent(result, recoveryForAgentResult(result))
              : delivery === "delivered_to_active_turn"
                ? "Use get_codex_session to inspect live progress or wait_codex_session to wait for the steered turn."
                : "Use wait_codex_session to wait for the queued steering turn.",
          },
          result ? !result.ok : false,
        );
      } catch (error) {
        await progress.flush();
        logger.error("steer_codex_session.failed", { error: errorForLog(error) });
        return errorResult(error, "steer_codex_session");
      }
    });
  },
);

registerLegacyTool(
  "start_session",
  {
    title: "Start persistent Codex session",
    description:
      "Start a Codex session that can keep Codex context across later send_session_prompt calls. The initial run is non-ephemeral so Codex records a resumable thread id.",
    inputSchema: {
      prompt: z.string().min(1).describe("Initial prompt for the persistent Codex session."),
      session_name: z.string().trim().min(1).optional().describe("Optional human label for this session."),
      name: z.string().trim().min(1).optional().describe("Optional label for the initial Codex run."),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("start_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send("Starting persistent Codex session");
        const { session, result } = await withProgressHeartbeat(
          progress,
          "Still starting persistent Codex session",
          () =>
            sessionManager.start(
              withRequestAbort(
                {
                  ...toRunOptions(args),
                  ephemeral: false,
                },
                extra,
              ),
              { sessionName: args.session_name },
            ),
        );
        await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            agent: compactAgentResultForMcp(result),
            recovery: recoveryForAgentResult(result),
          },
          !result.ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("start_session.failed", { error: errorForLog(error) });
        return errorResult(error, "start_session");
      }
    });
  },
);

registerLegacyTool(
  "send_session_prompt",
  {
    title: "Send prompt to Codex session",
    description:
      "Resume an existing Codex session and send another prompt, preserving Codex context through the recorded Codex thread id.",
    inputSchema: {
      session_id: sessionIdSchema,
      prompt: z.string().min(1).describe("Follow-up prompt for the persistent Codex session."),
      ...commonInputSchema,
    },
  },
  async (args, extra) => {
    return loggedToolCall("send_session_prompt", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Resuming Codex session ${args.session_id}`);
        const { session, result, error } = await withProgressHeartbeat(
          progress,
          `Still running Codex session ${args.session_id}`,
          () => sessionManager.send(args.session_id, args.prompt, toRunOptions(args), { waitSignal: extra?.signal }),
        );
        if (error || !session || !result) {
          await progress.flush();
          return jsonResult(
            {
              ok: false,
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              recovery: recoveryForError(new Error(error ?? "Codex session did not return a result."), "send_session_prompt"),
              suggested_next_action: recoveryForError(new Error(error ?? "Codex session did not return a result."), "send_session_prompt").recommendedAction,
            },
            true,
          );
        }
        await reportAgentResult(progress, result);
        await progress.flush();
        return jsonResult(
          {
            session: compactSessionSnapshotForMcp(session),
            agent: compactAgentResultForMcp(result),
            recovery: recoveryForAgentResult(result),
          },
          !result.ok,
        );
      } catch (error) {
        await progress.flush();
        logger.error("send_session_prompt.failed", { error: errorForLog(error) });
        return errorResult(error, "send_session_prompt");
      }
    });
  },
);

registerLegacyTool(
  "get_session",
  {
    title: "Get Codex session",
    description: "Return metadata, partial progress, and last result for a persistent Codex session.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("get_session", args, extra, async () => {
      const session = sessionManager.get(args.session_id);
      if (!session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "get_session");
      const compactSession = compactSessionSnapshotForMcp(session);
      return jsonResult({ session: compactSession, ...sessionProgressPayload(compactSession) });
    }),
);

registerLegacyTool(
  "get_codex_session",
  {
    title: "Get Codex session",
    description:
      "Return metadata, queued turns, active turn progress, and last result for a persistent Codex session. Prefer this intuitive alias when Claude is tracking a long-running Codex session.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("get_codex_session", args, extra, async () => {
      const session = sessionManager.get(args.session_id);
      if (!session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "get_codex_session");
      const compactSession = compactSessionSnapshotForMcp(session);
      return jsonResult({
        session: compactSession,
        ...sessionProgressPayload(compactSession),
        next_action: compactSession.active
          ? "Poll get_codex_session for progress, wait_codex_session when Claude needs completion, or steer_codex_session for active redirection."
          : "Use send_codex_session_prompt or continue_codex_session for follow-up work in this same Codex context.",
      });
    }),
);

registerLegacyTool(
  "recover_codex_session",
  {
    title: "Recover Codex session",
    description:
      "Reattach a durable Codex session after Claude Code or the MCP server restarted. Use this before continue_codex_session when list_sessions shows durable.recovered true or Claude has an older session_id. App-server sessions resume the Codex thread via thread/resume; exec sessions reuse their persisted thread id on the next prompt.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("recover_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send(`Recovering Codex session ${args.session_id}`);
      const recovered = await sessionManager.recover(args.session_id);
      await progress.flush();
      if (recovered.error || !recovered.session) {
        return jsonResult(
          {
            ok: false,
            error: recovered.error,
            session: recovered.session ? compactSessionSnapshotForMcp(recovered.session) : recovered.session,
            recovery: recoveryForError(new Error(recovered.error ?? "Codex session could not be recovered."), "recover_codex_session"),
            suggested_next_action: recoveryForError(new Error(recovered.error ?? "Codex session could not be recovered."), "recover_codex_session").recommendedAction,
          },
          true,
        );
      }
      return jsonResult({
        recovered: recovered.recovered,
        session: compactSessionSnapshotForMcp(recovered.session),
      });
    }),
);

registerLegacyTool(
  "wait_codex_session",
  {
    title: "Wait for Codex session",
    description:
      "Wait until a Codex session becomes idle, or until a specific queued/running turn completes. Use after start_codex_session_async, send_codex_session_prompt, or steer_codex_session.",
    inputSchema: {
      session_id: sessionIdSchema,
      turn_id: z.string().trim().min(1).optional().describe("Optional turn id to wait for. Omit to wait until the whole session queue is idle."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(86_400_000)
        .default(defaultBlockingWaitTimeoutMs)
        .describe("Requested time to wait in milliseconds. The server caps long waits to keep Claude responsive."),
    },
  },
  async (args, extra) =>
    loggedToolCall("wait_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        const waitTimeout = capToolBlockingWaitTimeout(args.timeout_ms, extra);
        logCappedWait("wait_codex_session", waitTimeout, { sessionId: args.session_id });
        await progress.send(`Waiting for Codex session ${args.session_id}`);
        const waited = await withProgressHeartbeat(
          progress,
          `Still waiting for Codex session ${args.session_id}`,
          () => sessionManager.wait(args.session_id, waitTimeout.effectiveMs, args.turn_id, extra?.signal),
        );
        await progress.send(
          waited.completed
            ? `Codex session ${args.session_id} is ready`
            : waited.timeoutReason === "wait_cancelled"
              ? `Cancelled wait for Codex session ${args.session_id}`
              : `Timed out waiting for Codex session ${args.session_id}`,
        );
        await progress.flush();
        if (waited.error || !waited.session) {
          return errorResult(new Error(waited.error ?? "Codex session was not found."), "wait_codex_session");
        }
        const compactSession = compactSessionSnapshotForMcp(waited.session);
        const recovery = recoveryForWait("codex_session", waited.timeoutReason);
        return jsonResult({
          completed: waited.completed,
          timeoutReason: waited.timeoutReason,
          session: compactSession,
          ...sessionProgressPayload(compactSession),
          turn: waited.turn,
          ...waitTimeoutFields(waitTimeout),
          recovery,
          suggested_next_action: recovery?.recommendedAction,
          next_action:
            recovery?.recommendedAction ??
            "Use the session.lastResult or turn result directly, or send a follow-up prompt if more Codex context is needed.",
        }, waited.timeoutReason === "wait_cancelled");
      } catch (error) {
        await progress.flush();
        logger.error("wait_codex_session.failed", { error: errorForLog(error) });
        return errorResult(error, "wait_codex_session");
      }
    }),
);

registerLegacyTool(
  "list_sessions",
  {
    title: "List Codex sessions",
    description: "List persistent Codex sessions held by this daemonless MCP server process.",
    inputSchema: {},
  },
  async (args, extra) =>
    loggedToolCall("list_sessions", args, extra, async () =>
      jsonResult({ sessions: sessionManager.list().map(compactSessionSnapshotForMcp) }),
    ),
);

registerLegacyTool(
  "cancel_session",
  {
    title: "Cancel Codex session",
    description:
      "Cancel the currently running turn for a persistent Codex session, or mark an idle session cancelled.",
    inputSchema: {
      session_id: sessionIdSchema,
    },
  },
  async (args, extra) =>
    loggedToolCall("cancel_session", args, extra, async () => {
      const session = sessionManager.cancel(args.session_id);
      if (!session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "cancel_session");
      return jsonResult({ session: compactSessionSnapshotForMcp(session) });
    }),
);

registerDebugTool(
  "codex_export_debug_bundle",
  {
    title: "Export Codex debug bundle",
    description:
      "Write a local diagnostics bundle for debugging repeated Claude/Codex MCP failures. Includes recent in-memory failures, status, selected session/job snapshots, and the configured log file tail when available. Use after a failed or flaky Codex tool call.",
    inputSchema: {
      session_id: sessionIdSchema.optional(),
      job_id: jobIdSchema.optional(),
      include_all_sessions: z.boolean().default(false),
      include_log_tail: z
        .boolean()
        .default(false)
        .describe("Include a bounded tail of CODEX_SUBAGENTS_LOG_FILE in the bundle. This may contain raw MCP traffic."),
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_export_debug_bundle", args, extra, async () => {
      const progress = createProgressReporter(extra);
      await progress.send("Writing Codex debug bundle");
      const session = args.session_id ? sessionManager.get(args.session_id) : undefined;
      const job = args.job_id ? jobManager.get(args.job_id) : undefined;
      if (args.session_id && !session) return errorResult(new Error(`Unknown session_id: ${args.session_id}`), "codex_export_debug_bundle");
      if (args.job_id && !job) return errorResult(new Error(`Unknown job_id: ${args.job_id}`), "codex_export_debug_bundle");
      const bundle = await createDebugBundle({
        session: args.include_all_sessions
          ? sessionManager.list().map(compactSessionSnapshotForMcp)
          : session
            ? compactSessionSnapshotForMcp(session)
            : undefined,
        job: job ? compactJobSnapshotForMcp(job) : undefined,
        status: {
          cwd: process.cwd(),
          queue: jobManager.stats(),
          sessions: sessionManager.stats(),
          logging: loggingDiagnostics(),
          artifacts: outputArtifactDiagnostics(),
          lifecycle: lifecycleStats(),
          diagnostics: diagnosticStats(),
        },
        notes: [
          "The bundle intentionally records environment key names, not environment values.",
          args.include_log_tail
            ? "A bounded CODEX_SUBAGENTS_LOG_FILE tail was included because include_log_tail was true."
            : "The configured log file tail was not included; rerun with include_log_tail=true when raw MCP traffic is needed.",
        ],
        includeLogTail: args.include_log_tail,
      });
      await progress.flush();
      return jsonResult({
        ok: true,
        ...bundle,
        recentDiagnostics: recentDiagnosticEvents(20),
      });
    }),
);

registerDebugTool(
  "codex_status",
  {
    title: "Codex status",
    description:
      "Report Codex binary resolution, version, server working directory, and default execution settings. Use for diagnostics before delegation only when Codex availability is uncertain or a prior tool call failed.",
    inputSchema: {
      codex_bin: commonInputSchema.codex_bin,
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_status", args, extra, async () => {
      try {
        return jsonResult(await codexStatusPayload(args.codex_bin));
      } catch (error) {
        logger.error("codex_status.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_status");
      }
    }),
);

registerDebugTool(
  "codex_doctor",
  {
    title: "Codex subagents doctor",
    description:
      "Run local diagnostics for the Codex subagents plugin without invoking a model: binary resolution, version probe, project directory, defaults, queue state, and safety posture.",
    inputSchema: {
      codex_bin: commonInputSchema.codex_bin,
      project_dir: commonInputSchema.project_dir,
    },
  },
  async (args, extra) =>
    loggedToolCall("codex_doctor", args, extra, async () => jsonResult(await codexDoctorPayload(args))),
);

if (debugToolsEnabled) {
  server.registerPrompt(
    "codex_agent",
    {
      title: "Delegate to one Codex agent",
      description: "Prompt Claude to launch one Codex agent through this MCP server; read-only by default.",
      argsSchema: {
        prompt: z.string().describe("Task for the Codex agent."),
        model: z.string().optional().describe("Optional Codex model."),
        reasoning_effort: reasoningEffortSchema.optional().describe("Optional reasoning effort."),
        model_preset: modelPresetSchema.optional().describe("Optional model preset, such as spark."),
      },
    },
    ({ prompt, model, reasoning_effort, model_preset }) => {
      const promptResult = {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Use the codex-subagents MCP tool `codex_task` for this task.",
                "Keep full_access false unless I explicitly ask for full non-sandbox access.",
                "For full non-sandbox access, set full_access true.",
                model ? `Use advanced.model ${model}.` : "Use the configured Codex model default.",
                model_preset ? `Use advanced.model_preset ${model_preset}.` : "",
                reasoning_effort
                  ? `Use advanced.reasoning ${reasoning_effort}.`
                  : "Use reasoning medium unless the task clearly needs more.",
                "",
                prompt,
              ].join("\n"),
            },
          },
        ],
      };
      logger.rawDebug("mcp.prompt.result", {
        prompt: "codex_agent",
        arguments: summarizeRawTrafficForLog({ prompt, model, reasoning_effort, model_preset }),
        result: summarizeRawTrafficForLog(promptResult),
      });
      return promptResult;
    },
  );

  server.registerPrompt(
    "codex_parallel",
    {
      title: "Delegate to parallel Codex agents",
      description:
        "Prompt Claude to split independent work across multiple Codex agents through this MCP server; read-only by default.",
      argsSchema: {
        prompt: z.string().describe("Parallel delegation request."),
        max_parallel: z.string().optional().describe("Optional max parallelism."),
        model_preset: modelPresetSchema.optional().describe("Optional model preset for all agents."),
      },
    },
    ({ prompt, max_parallel, model_preset }) => {
      const promptResult = {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                "Use the codex-subagents MCP tool `codex_task_group` for this task.",
                "Create one task object per independent workstream and run them read-only unless I explicitly ask for full non-sandbox access.",
                "For full non-sandbox access, set full_access true.",
                max_parallel ? `Use max_parallel ${max_parallel}.` : "Use max_parallel 4 unless fewer agents are needed.",
                model_preset ? `Use advanced.model_preset ${model_preset} unless an agent needs a different model.` : "",
                "Ask each Codex agent for concise findings with file paths and line references when relevant.",
                "",
                prompt,
              ].join("\n"),
            },
          },
        ],
      };
      logger.rawDebug("mcp.prompt.result", {
        prompt: "codex_parallel",
        arguments: summarizeRawTrafficForLog({ prompt, max_parallel, model_preset }),
        result: summarizeRawTrafficForLog(promptResult),
      });
      return promptResult;
    },
  );
}

registerCleanupHandler(async (reason) => {
  jobManager.cancelAll(reason);
  await sessionManager.shutdown(reason);
});

function envBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function installOrphanWatchdog(controller: ShutdownController): void {
  const forceOrphanForTest = process.env.CODEX_SUBAGENTS_TEST_FORCE_ORPHAN === "1";
  const initialParentPid = forceOrphanForTest ? 2 : process.ppid;
  if (initialParentPid <= 1) {
    logger.warn("lifecycle.orphan_watchdog.disabled", {
      parentPid: initialParentPid,
      reason: "process started without a live parent",
    });
    return;
  }

  const intervalMs = envBoundedInteger("CODEX_SUBAGENTS_ORPHAN_WATCHDOG_INTERVAL_MS", 1_000, 100, 60_000);
  const graceMs = envBoundedInteger("CODEX_SUBAGENTS_ORPHAN_WATCHDOG_GRACE_MS", 2_000, 250, 60_000);
  let orphanSinceMs: number | undefined;
  const interval = setInterval(() => {
    if (controller.isShuttingDown()) return;
    const parentPid = forceOrphanForTest ? 1 : process.ppid;
    const state = updateOrphanWatchdogState({
      parentPid,
      nowMs: Date.now(),
      previousOrphanSinceMs: orphanSinceMs,
      graceMs,
    });
    orphanSinceMs = state.orphanSinceMs;
    if (state.shouldExit) {
      logger.warn("lifecycle.orphaned_parent", {
        parentPid,
        graceMs,
        reason: "daemonless stdio MCP server lost its parent process",
      });
      controller.shutdown("orphaned_parent", 0, 250);
    }
  }, intervalMs);
  interval.unref();
  registerCleanupHandler(() => clearInterval(interval));
}

type ShutdownController = {
  shutdown: (reason: string, exitCode?: number, graceMs?: number) => void;
  isShuttingDown: () => boolean;
  exitCode: () => number | undefined;
};

function installProcessCleanup(): ShutdownController {
  let shutdownStarted = false;
  let requestedExitCode: number | undefined;
  const shutdown = (reason: string, exitCode?: number, graceMs = 2_500) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    requestedExitCode = exitCode;
    disableStderrLogMirrorForShutdown();
    const forceExit = exitCode === undefined
      ? undefined
      : setTimeout(() => process.exit(exitCode), Math.max(250, graceMs + 250));
    forceExit?.unref();
    void cleanupRuntime(reason, graceMs).finally(() => {
      if (forceExit) clearTimeout(forceExit);
      if (exitCode !== undefined) process.exit(exitCode);
    });
  };
  const shutdownOnBrokenStdio = (reason: string) => (error: unknown) => {
    if (isBrokenStdioError(error)) {
      shutdown(reason, 0, 250);
      return;
    }
    logger.error(`${reason}.error`, { error: errorForLog(error) });
  };

  process.once("SIGINT", () => shutdown("SIGINT", 130));
  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  process.stdin.once("close", () => shutdown("stdin_close", 0, 250));
  process.stdin.once("end", () => shutdown("stdin_end", 0, 250));
  process.stdin.once("error", shutdownOnBrokenStdio("stdin"));
  process.stdout.once("error", shutdownOnBrokenStdio("stdout"));
  process.stderr.once("error", shutdownOnBrokenStdio("stderr"));
  return {
    shutdown,
    isShuttingDown: () => shutdownStarted,
    exitCode: () => requestedExitCode,
  };
}

async function main(): Promise<void> {
  const shutdownController = installProcessCleanup();
  installOrphanWatchdog(shutdownController);
  process.on("unhandledRejection", (error) => {
    if (shutdownController.isShuttingDown()) return;
    if (isBrokenStdioError(error)) {
      shutdownController.shutdown("unhandled_broken_stdio", 0, 250);
      return;
    }
    logger.error("process.unhandled_rejection", { error: errorForLog(error) });
  });
  process.on("uncaughtException", (error) => {
    if (shutdownController.isShuttingDown()) {
      process.exit(shutdownController.exitCode() ?? 1);
    }
    if (isBrokenStdioError(error)) {
      shutdownController.shutdown("uncaught_broken_stdio", 0, 250);
      return;
    }
    logger.error("process.uncaught_exception", { error: errorForLog(error) });
    shutdownController.shutdown("uncaught_exception", 1, 500);
  });

  logger.info("server.starting", {
    logging: loggingDiagnostics(),
  });
  const transport = new StdioServerTransport();
  registerCleanupHandler(async () => {
    try {
      await transport.close();
    } catch (error) {
      if (!isBrokenStdioError(error)) {
        logger.error("mcp.transport.close_failed", { error: errorForLog(error) });
      }
    }
  });
  installTransportLogging(transport, shutdownController.shutdown, shutdownController.isShuttingDown);
  await server.connect(transport);
  logger.info("server.connected", { transport: "stdio" });
}

main().catch((error) => {
  if (isBrokenStdioError(error)) process.exit(0);
  logger.error("server.start_failed", { error: errorForLog(error) });
  process.exit(1);
});
