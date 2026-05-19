import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  defaultModel,
  defaultReasoningEffort,
  mcpConfigPolicies,
  modelVerbosities,
  outputContracts,
  probeCodexVersion,
  reasoningEfforts,
  reasoningSummaries,
  resolveWorkingDirectory,
  sandboxModes,
  serviceTiers,
} from "./runner.js";
import { aggregateAgentResults } from "./aggregate.js";
import { outputArtifactDiagnostics } from "./artifacts.js";
import { cleanOption } from "./binary.js";
import {
  createDebugBundle,
  diagnosticStats,
  recentDiagnosticEvents,
  recordDiagnosticEvent,
} from "./diagnostics.js";
import { jobManager, runQueuedAgent, runQueuedAgents } from "./jobs.js";
import { cleanupRuntime, lifecycleStats, registerCleanupHandler } from "./lifecycle.js";
import { errorForLog, logger, loggingDiagnostics, makeLogId, summarizeRawTrafficForLog } from "./logging.js";
import { recoveryForAgentResult, recoveryForError, recoveryForWait } from "./recovery.js";
import { redactJsonValue, redactSensitiveText } from "./redaction.js";
import { createProgressReporter, type ProgressOptions, type ProgressReporter, type ToolExtra } from "./progress.js";
import {
  compactAgentResultForMcp,
  compactAgentResultsForMcp,
  compactJobSnapshotForMcp,
  compactSessionSnapshotForMcp,
} from "./response.js";
import { sessionManager } from "./sessions.js";
import { modelPresets } from "./subagents.js";
import { packageVersion } from "./version.js";

const usageGuide = [
  "Claude Code integration guide for codex-subagents:",
  "",
  "Use this MCP server whenever the user asks Claude to use Codex, OpenAI Codex, Codex subagents, Codex Spark, a Codex second opinion, parallel Codex review, or independent Codex codebase analysis. You do not need the user to name an MCP tool.",
  "",
  "Tool choice:",
  "- Prefer ask_codex for one delegated Codex task. This is the clearest front door for normal \"ask Codex\" or \"Codex second opinion\" requests.",
  "- Prefer ask_codex_parallel when the work can be split into independent concurrent tasks, for example separate reviewers for API flow, tests, security, performance, UI, docs, or migration risk.",
  "- Prefer start_codex_session and continue_codex_session when the user wants a Codex agent to keep context across multiple prompts. Persistent sessions use Codex app-server by default and fall back to codex exec only when app-server is unavailable.",
  "- Prefer start_codex_session_async when Claude needs a session id immediately while Codex keeps working in the background.",
  "- Use send_codex_session_prompt for ordinary follow-ups on an active or idle Codex session. This preserves context and queues behind the active turn when needed.",
  "- Use steer_codex_session only when the user wants to redirect the active work now. It sends real live steering into a running app-server turn; use interrupt_current only when the active turn should be cancelled and redirected. If a session had to fall back to codex exec, steering degrades to the next high-priority queued turn.",
  "- Use get_codex_session or wait_codex_session to inspect or wait for long-running Codex sessions. Session snapshots include appServer.supports and appServerFallbackReason for protocol diagnostics.",
  "- Use recover_codex_session when Claude has a persisted session_id from before a Claude/MCP restart and wants to reattach to that Codex thread before sending a follow-up.",
  "- Use codex_export_debug_bundle after repeated failures; it writes recent diagnostics, selected session/job state, status, and optional log tail into one local JSON bundle.",
  "- Use codex_choose_tool if you are unsure which Codex tool fits the request.",
  "- Use run_agent, run_agents, run_agents_aggregate, start_session, and send_session_prompt for lower-level/manual control; they are compatibility tools behind the intuitive front doors.",
  "- Use run_agents_aggregate when Claude needs a concise consensus object from several independent Codex agents.",
  "- Use start_agent_run or start_agents_run for slow or broad Codex work; poll with get_agent_run, wait with wait_agent_run, and cancel with cancel_agent_run.",
  "- Use codex_doctor for installation, binary, auth, and default-setting diagnostics.",
  "- Use codex_status only for diagnostics or when you need to confirm the Codex binary/version.",
  "- Use codex_usage_guide if you are unsure how to structure a Codex delegation.",
  "- Use codex_choose_tool before delegating when the request is ambiguous between one agent, parallel agents, aggregation, a persistent session, an async job, or live steering.",
  "",
  "Default operating rules:",
  "- Keep sandbox read-only unless the user explicitly asks for a different sandbox.",
  "- If the user explicitly asks for non-sandbox/full local capabilities, set dangerously_bypass_approvals_and_sandbox true. This maps to Codex's --dangerously-bypass-approvals-and-sandbox flag and allows DNS/network plus unrestricted file and git writes.",
  "- Approvals are non-interactive; do not expect Codex to ask permission.",
  "- If wait_codex_session returns completed false with timeoutReason \"wait_timeout\", the session is still running unless its status says otherwise.",
  "- If a tool returns recovery.reason \"backpressure\", reduce max_parallel or wait before retrying. codex_status exposes current queue/session limits.",
  "- If a response mentions outputArtifacts, use the artifact paths for full retained output instead of asking Codex to resend huge stdout/stderr.",
  "- Prefer model_preset \"spark\" for responsive focused checks, small reviews, UI iteration, and sidecar analysis.",
  "- Use reasoning_effort \"medium\" by default, \"low\" for simple checks, and \"high\" or \"xhigh\" only for difficult analysis. Do not use \"minimal\"; Codex currently auto-attaches web_search and the API rejects that tool with minimal reasoning.",
  "- Do not combine model_preset \"spark\" with reasoning_summary values other than \"none\"; Spark does not support reasoning.summary.",
  "- Do not set service_tier by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.",
  "- Pass project_dir whenever Claude knows the active project directory so Codex works in the same tree as Claude Code.",
  "- Persistent sessions are durable across MCP restarts when Codex has produced a thread id. After restart, list_sessions can show recovered sessions and recover_codex_session can validate the thread.",
  "- Async one-shot jobs from start_agent_run/start_agents_run are not durable across MCP restarts. Use persistent session tools for recoverable long-running work.",
  "- Raw debug logs are intentionally verbose and may contain MCP traffic and prompt text. Treat logs and debug bundles as sensitive local data.",
  "- Do not use Bash, Read, or filesystem inspection to locate Codex. The MCP server resolves Codex automatically, preferring the Codex desktop app binary when installed.",
  "- Set isolated_codex_home true when a run should ignore the user's Codex MCP server config and use only this request's temporary Codex configuration.",
  "- Use mcp_config_policy \"explicit\" with codex_mcp_servers for intentional MCP sharing. Use \"inherit_claude_project\" only when the project has a Claude MCP config that should be shared with Codex.",
  "- Use output_contract for machine-readable results when Claude needs to merge or compare Codex outputs.",
  "- Ask Codex for concise results with file paths, line references, and actionable findings when reviewing code.",
  "",
  "Nested Codex subagents:",
  "- When the user wants Codex to use its own subagents, pass complete custom definitions in codex_subagents and explicit work items in subagent_tasks.",
  "- Keep subagent_runtime.max_depth at 1 unless recursive delegation is intentionally requested.",
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

const reasoningEffortSchema = z.enum(reasoningEfforts);
const sandboxModeSchema = z.enum(sandboxModes);
const serviceTierSchema = z.enum(serviceTiers);
const modelVerbositySchema = z.enum(modelVerbosities);
const reasoningSummarySchema = z.enum(reasoningSummaries);
const modelPresetSchema = z.enum(modelPresets);
const outputContractSchema = z.enum(outputContracts);
const mcpConfigPolicySchema = z.enum(mcpConfigPolicies);
const looseRecordSchema = z.record(z.unknown());

const codexSubagentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe("Agent name Codex should use when spawning or referring to this subagent."),
  description: z
    .string()
    .trim()
    .min(1)
    .describe("Human-facing guidance for when Codex should use this subagent."),
  developer_instructions: z
    .string()
    .trim()
    .min(1)
    .describe("Core instructions defining this Codex subagent's behavior."),
  nickname_candidates: z
    .array(z.string().trim().min(1))
    .min(1)
    .optional()
    .describe("Optional display nicknames for multiple instances of this subagent."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Exact model for this Codex subagent. Overrides model_preset."),
  model_preset: modelPresetSchema
    .optional()
    .describe("Convenience preset. `spark` maps to gpt-5.3-codex-spark."),
  reasoning_effort: reasoningEffortSchema
    .optional()
    .describe("Reasoning effort for this Codex subagent."),
  sandbox: sandboxModeSchema
    .optional()
    .describe("Sandbox mode for this Codex subagent. Parent runtime overrides still apply."),
  mcp_servers: looseRecordSchema
    .optional()
    .describe("Optional Codex mcp_servers config for this custom subagent."),
  skills_config: looseRecordSchema
    .optional()
    .describe("Optional Codex skills.config table for this custom subagent."),
  extra_config: looseRecordSchema
    .optional()
    .describe("Additional config.toml-compatible keys for this custom subagent."),
});

const subagentTaskSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .describe("Built-in or custom Codex subagent name to spawn, for example explorer or pr_explorer."),
  prompt: z.string().trim().min(1).describe("Task prompt for this spawned Codex subagent."),
  name: z.string().trim().min(1).optional().describe("Optional display label for this task."),
});

const subagentRuntimeSchema = z.object({
  max_threads: z.number().int().min(1).max(32).optional(),
  max_depth: z.number().int().min(1).max(4).optional(),
  job_max_runtime_seconds: z.number().int().positive().max(86_400).optional(),
});

const commonInputSchema = {
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Exact Codex model, for example gpt-5.3-codex. Omit to use model_preset, the plugin default, or Codex default.",
    ),
  model_preset: modelPresetSchema
    .optional()
    .describe(
      "Convenience model preset. Use `spark` for responsive Codex Spark work; it maps to gpt-5.3-codex-spark.",
    ),
  reasoning_effort: reasoningEffortSchema
    .optional()
    .describe(
      "Codex model reasoning effort. Prefer medium by default, low for simple checks, high/xhigh only for difficult analysis. `minimal` is rejected because Codex currently auto-attaches web_search, which the API does not allow with minimal reasoning.",
    ),
  sandbox: sandboxModeSchema
    .default("read-only")
    .describe("Codex sandbox mode. Keep read-only unless the user explicitly asks otherwise."),
  dangerously_bypass_approvals_and_sandbox: z
    .boolean()
    .default(false)
    .describe(
      "Bypass all Codex sandboxing and approval prompts with Codex's --dangerously-bypass-approvals-and-sandbox flag. This gives Codex normal local capabilities such as DNS/network access and unrestricted file/git writes. Only set when the user explicitly asks for non-sandbox/full-access execution.",
    ),
  service_tier: serviceTierSchema
    .optional()
    .describe(
      "Optional Codex service tier. Omit by default; only set this when the user explicitly asks for a service tier.",
    ),
  model_verbosity: modelVerbositySchema
    .optional()
    .describe("Optional GPT-5 model verbosity override."),
  reasoning_summary: reasoningSummarySchema
    .optional()
    .describe(
      "Optional Codex reasoning summary setting. Do not use with model_preset `spark` except `none`; Spark does not support reasoning.summary.",
    ),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Compatibility alias for project_dir."),
  project_dir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Project directory for Codex. Pass Claude Code's active project directory so Codex works in the same tree. Defaults to CLAUDE_PROJECT_DIR when Claude provides it.",
    ),
  codex_bin: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Explicit Codex CLI path. Overrides default binary resolution for this call."),
  profile: z.string().trim().min(1).optional().describe("Optional Codex config profile."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .default(600_000)
    .describe("Maximum runtime per Codex process in milliseconds."),
  max_output_chars: z
    .number()
    .int()
    .positive()
    .max(500_000)
    .default(60_000)
    .describe("Maximum final message/stdout characters retained per agent. Lower this for concise parallel reviews."),
  include_events: z
    .boolean()
    .default(false)
    .describe("Include parsed Codex JSONL events in the result. Usually leave false."),
  ephemeral: z
    .boolean()
    .default(true)
    .describe("Run Codex without persisting session rollout files."),
  skip_git_repo_check: z
    .boolean()
    .default(false)
    .describe("Allow Codex to run outside a Git repository."),
  ignore_rules: z.boolean().default(false).describe("Skip Codex execpolicy .rules files."),
  isolated_codex_home: z
    .boolean()
    .default(false)
    .describe(
      "Run with a temporary Codex home that links auth but does not inherit the user's Codex config.toml. Use to avoid unrelated MCP servers from the user's Codex config.",
    ),
  mcp_config_policy: mcpConfigPolicySchema
    .default("inherit_codex")
    .describe(
      "How to provide MCP servers to Codex: inherit_codex uses the user's Codex config, isolated uses no MCP servers, explicit uses codex_mcp_servers, inherit_claude_project imports a project .mcp.json when present.",
    ),
  codex_mcp_servers: looseRecordSchema
    .optional()
    .describe("Explicit Codex mcp_servers config used when mcp_config_policy is explicit."),
  forward_sensitive_env: z
    .boolean()
    .default(false)
    .describe("Forward secret-looking environment variables to Codex. Leave false unless Codex auth requires env-based secrets."),
  idle_timeout_ms: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .optional()
    .describe("Optional no-output timeout. Kills the Codex process if stdout/stderr are silent for this long."),
  spawn_timeout_ms: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .default(10_000)
    .describe("Maximum time to wait for the Codex process to spawn."),
  terminate_grace_ms: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(2_000)
    .describe("Time between SIGTERM and SIGKILL during cancellation or timeout."),
  output_contract: outputContractSchema
    .default("freeform")
    .describe("Optional structured output contract for Codex final responses."),
  output_schema: looseRecordSchema
    .optional()
    .describe("Custom JSON Schema passed to Codex --output-schema for final response validation."),
  codex_subagents: z
    .array(codexSubagentSchema)
    .max(24)
    .optional()
    .describe(
      "Complete custom Codex subagent definitions available inside this Codex run for nested delegation.",
    ),
  subagent_tasks: z
    .array(subagentTaskSchema)
    .max(24)
    .optional()
    .describe(
      "Specific built-in or custom Codex subagents the parent Codex agent should spawn and wait for.",
    ),
  subagent_runtime: subagentRuntimeSchema
    .optional()
    .describe("Runtime limits for nested Codex subagent orchestration. Keep max_depth at 1 by default."),
};

const frontDoorInputSchema = {
  project_dir: commonInputSchema.project_dir,
  model_preset: commonInputSchema.model_preset,
  reasoning_effort: commonInputSchema.reasoning_effort,
  sandbox: commonInputSchema.sandbox,
  dangerously_bypass_approvals_and_sandbox:
    commonInputSchema.dangerously_bypass_approvals_and_sandbox,
  codex_bin: commonInputSchema.codex_bin,
  timeout_ms: commonInputSchema.timeout_ms,
  max_output_chars: commonInputSchema.max_output_chars,
  output_contract: commonInputSchema.output_contract,
  output_schema: commonInputSchema.output_schema,
  model: commonInputSchema.model,
  service_tier: commonInputSchema.service_tier,
  model_verbosity: commonInputSchema.model_verbosity,
  reasoning_summary: commonInputSchema.reasoning_summary,
  cwd: commonInputSchema.cwd,
  profile: commonInputSchema.profile,
  include_events: commonInputSchema.include_events,
  ephemeral: commonInputSchema.ephemeral,
  skip_git_repo_check: commonInputSchema.skip_git_repo_check,
  ignore_rules: commonInputSchema.ignore_rules,
  isolated_codex_home: commonInputSchema.isolated_codex_home,
  mcp_config_policy: commonInputSchema.mcp_config_policy,
  codex_mcp_servers: commonInputSchema.codex_mcp_servers,
  forward_sensitive_env: commonInputSchema.forward_sensitive_env,
  idle_timeout_ms: commonInputSchema.idle_timeout_ms,
  spawn_timeout_ms: commonInputSchema.spawn_timeout_ms,
  terminate_grace_ms: commonInputSchema.terminate_grace_ms,
  codex_subagents: commonInputSchema.codex_subagents,
  subagent_tasks: commonInputSchema.subagent_tasks,
  subagent_runtime: commonInputSchema.subagent_runtime,
};

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

function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  const fullText = JSON.stringify(value, null, 2);
  const text =
    fullText.length <= 4_000
      ? fullText
      : JSON.stringify(
          {
            ok: Boolean(value.ok ?? !isError),
            isError,
            note:
              "MCP text content was shortened to keep Claude responsive; use structuredContent for the compacted result.",
            keys: Object.keys(value),
          },
          null,
          2,
        );
  return {
    structuredContent: value,
    isError,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function errorResult(error: unknown, context = "tool_call"): CallToolResult {
  return jsonResult(
    {
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      recovery: redactJsonValue(recoveryForError(error, context)),
    },
    true,
  );
}

function agentResultResponse(result: Parameters<typeof compactAgentResultForMcp>[0]): CallToolResult {
  const recovery = recoveryForAgentResult(result);
  return jsonResult(
    {
      agent: compactAgentResultForMcp(result),
      recovery,
    },
    !result.ok,
  );
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
      "Use start_codex_session_async when Claude needs recoverable long-running Codex work across MCP restarts.",
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

function installTransportLogging(transport: StdioServerTransport): void {
  const previousOnMessage = transport.onmessage;
  transport.onmessage = (message) => {
    logger.rawDebug("mcp.transport.inbound", {
      message: summarizeRawTrafficForLog(message),
    });
    previousOnMessage?.(message);
  };

  const previousOnError = transport.onerror;
  transport.onerror = (error) => {
    logger.error("mcp.transport.error", { error: errorForLog(error) });
    previousOnError?.(error);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage): Promise<void> => {
    logger.rawDebug("mcp.transport.outbound", {
      message: summarizeRawTrafficForLog(message),
    });
    try {
      await send(message);
    } catch (error) {
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

async function withProgressHeartbeat<T>(
  progress: ProgressReporter,
  message: string,
  operation: () => Promise<T>,
  progressOptions?: ProgressOptions,
): Promise<T> {
  const interval = setInterval(() => {
    void progress.send(message, progressOptions);
  }, progressHeartbeatMs());
  interval.unref();
  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
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
    mcpConfigPolicy: args.mcp_config_policy ?? (args.codex_mcp_servers ? "explicit" : undefined),
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

function toParallelRunOptions(args: ParallelToolInput) {
  return {
    ...toRunOptions({
      ...args,
      prompt: "shared-options",
    }),
    agents: args.agents.map((agent) => ({
      prompt: agent.prompt,
      name: agent.name,
      model: agent.model ?? args.model,
      modelPreset: agent.model_preset ?? args.model_preset,
      reasoningEffort: agent.reasoning_effort ?? args.reasoning_effort,
      sandbox: agent.sandbox ?? args.sandbox,
      dangerouslyBypassApprovalsAndSandbox:
        agent.dangerously_bypass_approvals_and_sandbox ??
        args.dangerously_bypass_approvals_and_sandbox,
      serviceTier: agent.service_tier ?? args.service_tier,
      modelVerbosity: agent.model_verbosity ?? args.model_verbosity,
      reasoningSummary: agent.reasoning_summary ?? args.reasoning_summary,
      cwd: agent.cwd ?? args.cwd,
      projectDir: agent.project_dir ?? args.project_dir,
      codexBin: agent.codex_bin ?? args.codex_bin,
      profile: agent.profile ?? args.profile,
      timeoutMs: agent.timeout_ms ?? args.timeout_ms,
      maxOutputChars: agent.max_output_chars ?? args.max_output_chars,
      includeEvents: agent.include_events ?? args.include_events,
      ephemeral: agent.ephemeral ?? args.ephemeral,
      skipGitRepoCheck: agent.skip_git_repo_check ?? args.skip_git_repo_check,
      ignoreRules: agent.ignore_rules ?? args.ignore_rules,
      isolatedCodexHome: agent.isolated_codex_home ?? args.isolated_codex_home,
      mcpConfigPolicy:
        agent.mcp_config_policy ??
        args.mcp_config_policy ??
        (agent.codex_mcp_servers ?? args.codex_mcp_servers ? "explicit" : undefined),
      codexMcpServers: agent.codex_mcp_servers ?? args.codex_mcp_servers,
      forwardSensitiveEnv: agent.forward_sensitive_env ?? args.forward_sensitive_env,
      idleTimeoutMs: agent.idle_timeout_ms ?? args.idle_timeout_ms,
      spawnTimeoutMs: agent.spawn_timeout_ms ?? args.spawn_timeout_ms,
      terminateGraceMs: agent.terminate_grace_ms ?? args.terminate_grace_ms,
      outputContract: agent.output_contract ?? args.output_contract,
      outputSchema: agent.output_schema ?? args.output_schema,
      codexSubagents: toCodexSubagents(agent.codex_subagents ?? args.codex_subagents),
      subagentTasks: agent.subagent_tasks ?? args.subagent_tasks,
      subagentRuntime: agent.subagent_runtime
        ? {
            maxThreads: agent.subagent_runtime.max_threads,
            maxDepth: agent.subagent_runtime.max_depth,
            jobMaxRuntimeSeconds: agent.subagent_runtime.job_max_runtime_seconds,
          }
        : args.subagent_runtime
          ? {
              maxThreads: args.subagent_runtime.max_threads,
              maxDepth: args.subagent_runtime.max_depth,
              jobMaxRuntimeSeconds: args.subagent_runtime.job_max_runtime_seconds,
            }
          : undefined,
    })),
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

server.registerTool(
  "codex_usage_guide",
  {
    title: "How to use Codex subagents",
    description:
      "Read the operating guide for this MCP server. Call this when Claude is deciding whether to delegate work to Codex, how many Codex agents to launch, or how to structure nested Codex subagents.",
    inputSchema: {},
  },
  async (args, extra) =>
    loggedToolCall("codex_usage_guide", args, extra, async () =>
      jsonResult({
        guide: usageGuide,
        preferredTools: {
          oneTask: "ask_codex",
          parallelTasks: "ask_codex_parallel",
          persistentSessionStart: "start_codex_session",
          persistentSessionFollowUp: "continue_codex_session",
          longRunningSessionStart: "start_codex_session_async",
          queuedSessionPrompt: "send_codex_session_prompt",
          steerRunningSession: "steer_codex_session",
          inspectSession: "get_codex_session",
          waitForSession: "wait_codex_session",
          recoverSessionAfterRestart: "recover_codex_session",
          exportDiagnostics: "codex_export_debug_bundle",
          longRunningOneTask: "start_agent_run",
          longRunningParallelTasks: "start_agents_run",
          lowerLevelSingle: "run_agent",
          lowerLevelParallel: "run_agents",
        },
        examples: {
          single: {
            tool: "ask_codex",
            arguments: {
              task:
                "Inspect the authentication flow read-only. Return the top risks with file paths and line references.",
              project_dir: "/path/to/project",
              model_preset: "spark",
              reasoning_effort: "medium",
            },
          },
          parallel: {
            tool: "ask_codex_parallel",
            arguments: {
              tasks: [
                {
                  name: "api",
                  task: "Review API flow read-only. Return concrete findings with paths.",
                  project_dir: "/path/to/project",
                },
                {
                  name: "tests",
                  task: "Review test coverage gaps read-only. Return concrete findings with paths.",
                  project_dir: "/path/to/project",
                },
              ],
              max_parallel: 2,
              model_preset: "spark",
              reasoning_effort: "medium",
            },
          },
        },
      }),
    ),
);

server.registerTool(
  "codex_choose_tool",
  {
    title: "Choose Codex tool",
    description:
      "Return a short decision guide for which Codex MCP tool Claude should use. Call this when a user asks for Codex and Claude is unsure whether to run one agent, parallel agents, a persistent session, or an async job.",
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
      let recommendedTool = "ask_codex";
      if (args.recovering_after_restart) recommendedTool = "recover_codex_session";
      else if (args.wants_steering) recommendedTool = "steer_codex_session";
      else if (args.continuing_session && args.long_running) recommendedTool = "send_codex_session_prompt";
      else if (args.continuing_session) recommendedTool = "continue_codex_session";
      else if (args.wants_session && (args.wants_async_session || args.long_running)) recommendedTool = "start_codex_session_async";
      else if (args.wants_session) recommendedTool = "start_codex_session";
      else if (args.wants_aggregation) recommendedTool = "run_agents_aggregate";
      else if (args.long_running && taskCount > 1) recommendedTool = "start_agents_run";
      else if (args.long_running) recommendedTool = "start_agent_run";
      else if (args.wants_parallel || taskCount > 1) recommendedTool = "ask_codex_parallel";

      return jsonResult({
        recommendedTool,
        request: args.request,
        rules: [
          "Use ask_codex for one normal Codex task.",
          "Use ask_codex_parallel for multiple independent Codex tasks.",
          "Use start_codex_session for a new multi-turn Codex worker and continue_codex_session for follow-ups.",
          "Use recover_codex_session after an MCP restart when Claude has a previous persisted session id.",
          "Use start_codex_session_async when Claude needs the session id immediately and will poll or wait later.",
          "Use send_codex_session_prompt for ordinary follow-up prompts on an active or idle Codex session.",
          "Use steer_codex_session only for active redirection. Live steering requires app-server support; exec fallback queues a high-priority turn.",
          "Use start_agent_run/start_agents_run for slow jobs that should not hold a blocking MCP request open.",
          "Use run_agents_aggregate only when Claude needs a deterministic consensus object.",
          "Pass project_dir whenever Claude knows the active project directory.",
          "When recovery.reason is backpressure, inspect codex_status and retry with less parallelism after a short wait.",
          "Do not use Bash or Read to locate Codex; this MCP server resolves the binary.",
        ],
        aliases: {
          ask_codex: ["run_agent"],
          ask_codex_parallel: ["run_agents"],
          start_codex_session: ["start_session"],
          continue_codex_session: ["send_session_prompt"],
          start_codex_session_async: ["start_session + return immediately"],
          send_codex_session_prompt: ["queued continue_codex_session"],
          steer_codex_session: ["live app-server turn steering"],
          recover_codex_session: ["reattach persisted Codex thread"],
        },
      });
    }),
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

const parallelAgentSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Concrete independent task for this Codex agent. Keep overlap low across parallel agents.",
    ),
  name: z.string().trim().min(1).optional().describe("Optional label for this agent."),
  model: commonInputSchema.model,
  model_preset: commonInputSchema.model_preset,
  reasoning_effort: commonInputSchema.reasoning_effort,
  sandbox: commonInputSchema.sandbox.optional(),
  dangerously_bypass_approvals_and_sandbox:
    commonInputSchema.dangerously_bypass_approvals_and_sandbox.optional(),
  service_tier: commonInputSchema.service_tier.optional(),
  model_verbosity: commonInputSchema.model_verbosity,
  reasoning_summary: commonInputSchema.reasoning_summary,
  cwd: commonInputSchema.cwd,
  project_dir: commonInputSchema.project_dir,
  codex_bin: commonInputSchema.codex_bin,
  profile: commonInputSchema.profile,
  timeout_ms: commonInputSchema.timeout_ms.optional(),
  max_output_chars: commonInputSchema.max_output_chars.optional(),
  include_events: commonInputSchema.include_events.optional(),
  ephemeral: commonInputSchema.ephemeral.optional(),
  skip_git_repo_check: commonInputSchema.skip_git_repo_check.optional(),
  ignore_rules: commonInputSchema.ignore_rules.optional(),
  isolated_codex_home: commonInputSchema.isolated_codex_home.optional(),
  mcp_config_policy: commonInputSchema.mcp_config_policy.optional(),
  codex_mcp_servers: commonInputSchema.codex_mcp_servers,
  forward_sensitive_env: commonInputSchema.forward_sensitive_env.optional(),
  idle_timeout_ms: commonInputSchema.idle_timeout_ms,
  spawn_timeout_ms: commonInputSchema.spawn_timeout_ms.optional(),
  terminate_grace_ms: commonInputSchema.terminate_grace_ms.optional(),
  output_contract: commonInputSchema.output_contract.optional(),
  output_schema: commonInputSchema.output_schema,
  codex_subagents: commonInputSchema.codex_subagents,
  subagent_tasks: commonInputSchema.subagent_tasks,
  subagent_runtime: commonInputSchema.subagent_runtime,
});

const frontDoorParallelTaskSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      "Concrete independent Codex task. Keep overlap low across parallel tasks and state the expected output shape.",
    ),
  name: z.string().trim().min(1).optional().describe("Optional label for this Codex task."),
  project_dir: commonInputSchema.project_dir,
  model_preset: commonInputSchema.model_preset,
  reasoning_effort: commonInputSchema.reasoning_effort,
  sandbox: commonInputSchema.sandbox.optional(),
  dangerously_bypass_approvals_and_sandbox:
    commonInputSchema.dangerously_bypass_approvals_and_sandbox.optional(),
  codex_bin: commonInputSchema.codex_bin,
  timeout_ms: commonInputSchema.timeout_ms.optional(),
  max_output_chars: commonInputSchema.max_output_chars.optional(),
  output_contract: commonInputSchema.output_contract.optional(),
  output_schema: commonInputSchema.output_schema,
  model: commonInputSchema.model,
  service_tier: commonInputSchema.service_tier.optional(),
  model_verbosity: commonInputSchema.model_verbosity,
  reasoning_summary: commonInputSchema.reasoning_summary,
  cwd: commonInputSchema.cwd,
  profile: commonInputSchema.profile,
  include_events: commonInputSchema.include_events.optional(),
  ephemeral: commonInputSchema.ephemeral.optional(),
  skip_git_repo_check: commonInputSchema.skip_git_repo_check.optional(),
  ignore_rules: commonInputSchema.ignore_rules.optional(),
  isolated_codex_home: commonInputSchema.isolated_codex_home.optional(),
  mcp_config_policy: commonInputSchema.mcp_config_policy.optional(),
  codex_mcp_servers: commonInputSchema.codex_mcp_servers,
  forward_sensitive_env: commonInputSchema.forward_sensitive_env.optional(),
  idle_timeout_ms: commonInputSchema.idle_timeout_ms,
  spawn_timeout_ms: commonInputSchema.spawn_timeout_ms.optional(),
  terminate_grace_ms: commonInputSchema.terminate_grace_ms.optional(),
  codex_subagents: commonInputSchema.codex_subagents,
  subagent_tasks: commonInputSchema.subagent_tasks,
  subagent_runtime: commonInputSchema.subagent_runtime,
});

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

const jobIdSchema = z.string().trim().min(1).describe("Job id returned by start_agent_run or start_agents_run.");

server.registerTool(
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

server.registerTool(
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
      const started = Date.now();
      let job = jobManager.get(args.job_id);
      while (job && !job.completedAt && Date.now() - started < args.timeout_ms && !extra?.signal?.aborted) {
        const remaining = args.timeout_ms - (Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, remaining))));
        job = jobManager.get(args.job_id);
        if (job) await progress.send(`Codex job ${job.status}`);
      }
      const waitCancelled = Boolean(extra?.signal?.aborted);
      if (job && !job.completedAt) {
        const waitedJob = await jobManager.wait(args.job_id, 1, extra?.signal);
        job = waitedJob ?? job;
      }
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

server.registerTool(
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

const sessionIdSchema = z.string().trim().min(1).describe("Session id returned by start_codex_session or start_session.");

server.registerTool(
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

server.registerTool(
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
        return jsonResult({
          session: compactSessionSnapshotForMcp(session),
          turn,
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

server.registerTool(
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
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              recovery: recoveryForError(new Error(error ?? "Codex session did not return a result."), "continue_codex_session"),
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

server.registerTool(
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
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              turn,
              recovery: recoveryForError(new Error(error ?? "Codex session prompt did not return a session."), "send_codex_session_prompt"),
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

server.registerTool(
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
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              turn,
              delivery,
              recovery: recoveryForError(new Error(error ?? "Codex steering did not return a session."), "steer_codex_session"),
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

server.registerTool(
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

server.registerTool(
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
              error,
              session: session ? compactSessionSnapshotForMcp(session) : session,
              recovery: recoveryForError(new Error(error ?? "Codex session did not return a result."), "send_session_prompt"),
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

server.registerTool(
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
      return jsonResult({ session: compactSessionSnapshotForMcp(session) });
    }),
);

server.registerTool(
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
      return jsonResult({ session: compactSessionSnapshotForMcp(session) });
    }),
);

server.registerTool(
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
            error: recovered.error,
            session: recovered.session ? compactSessionSnapshotForMcp(recovered.session) : recovered.session,
            recovery: recoveryForError(new Error(recovered.error ?? "Codex session could not be recovered."), "recover_codex_session"),
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

server.registerTool(
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
        .default(600_000)
        .describe("Maximum time to wait in milliseconds."),
    },
  },
  async (args, extra) =>
    loggedToolCall("wait_codex_session", args, extra, async () => {
      const progress = createProgressReporter(extra);
      try {
        await progress.send(`Waiting for Codex session ${args.session_id}`);
        const waited = await withProgressHeartbeat(
          progress,
          `Still waiting for Codex session ${args.session_id}`,
          () => sessionManager.wait(args.session_id, args.timeout_ms, args.turn_id, extra?.signal),
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
        return jsonResult({
          completed: waited.completed,
          timeoutReason: waited.timeoutReason,
          session: compactSessionSnapshotForMcp(waited.session),
          turn: waited.turn,
          recovery: recoveryForWait("codex_session", waited.timeoutReason),
        }, waited.timeoutReason === "wait_cancelled");
      } catch (error) {
        await progress.flush();
        logger.error("wait_codex_session.failed", { error: errorForLog(error) });
        return errorResult(error, "wait_codex_session");
      }
    }),
);

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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
        const status = await probeCodexVersion(args.codex_bin);
        return jsonResult({
          ok: !status.error,
          binary: status.binary,
          version: status.version,
          error: status.error,
          cwd: process.cwd(),
          defaultModel: defaultModel(),
          defaultReasoningEffort: defaultReasoningEffort(),
          defaultSandbox: "read-only",
          fullAccessFlag: "dangerously_bypass_approvals_and_sandbox",
          defaultServiceTier: "codex-default",
          defaultSessionProtocol: process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server",
          appServerProtocol: {
            transport: "stdio",
            command: "codex app-server --listen stdio://",
            default: process.env.CODEX_SUBAGENTS_SESSION_PROTOCOL === "exec" ? "exec" : "app-server",
            requiredMethods: ["initialize", "thread/start", "turn/start"],
            liveSteeringMethods: ["turn/steer", "turn/interrupt"],
            recoveryMethods: ["thread/resume", "thread/read"],
            passiveMethods: ["thread/read"],
            fallbackToExec:
              process.env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1" ? "disabled" : "enabled",
          },
          appServerFallback: process.env.CODEX_SUBAGENTS_DISABLE_EXEC_FALLBACK === "1" ? "disabled" : "enabled",
          modelPresets: {
            codex: "gpt-5.3-codex",
            spark: "gpt-5.3-codex-spark",
          },
          outputContracts,
          mcpConfigPolicies,
          pluginCodexBin: cleanOption(process.env.CODEX_SUBAGENTS_CODEX_BIN),
          claudeProjectDir: cleanOption(process.env.CLAUDE_PROJECT_DIR),
          queue: jobManager.stats(),
          sessions: sessionManager.stats(),
          logging: loggingDiagnostics(),
          artifacts: outputArtifactDiagnostics(),
          diagnostics: {
            ...diagnosticStats(),
            recentFailures: recentDiagnosticEvents(20),
          },
          lifecycle: lifecycleStats(),
        });
      } catch (error) {
        logger.error("codex_status.failed", { error: errorForLog(error) });
        return errorResult(error, "codex_status");
      }
    }),
);

server.registerTool(
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
    loggedToolCall("codex_doctor", args, extra, async () => {
      const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
      let ok = true;

      try {
        const status = await probeCodexVersion(args.codex_bin);
        checks.push({
          name: "codex_binary",
          ok: !status.error,
          detail: { binary: status.binary, version: status.version, error: status.error },
        });
        if (status.error) ok = false;
      } catch (error) {
        ok = false;
        logger.error("codex_doctor.binary_failed", { error: errorForLog(error) });
        checks.push({
          name: "codex_binary",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const projectDir = await resolveWorkingDirectory(args.project_dir);
        checks.push({
          name: "project_dir",
          ok: true,
          detail: { projectDir: cleanOption(projectDir) },
        });
      } catch (error) {
        ok = false;
        logger.error("codex_doctor.project_dir_failed", { error: errorForLog(error) });
        checks.push({ name: "project_dir", ok: false, detail: String(error) });
      }

      checks.push({
        name: "defaults",
        ok: defaultReasoningEffort() !== "minimal",
        detail: {
          sandbox: "read-only",
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalPolicy: "never",
          defaultModel: defaultModel(),
          defaultReasoningEffort: defaultReasoningEffort(),
          forwardSensitiveEnvDefault: false,
        },
      });
      checks.push({ name: "queue", ok: true, detail: jobManager.stats() });
      checks.push({ name: "sessions", ok: true, detail: sessionManager.stats() });
      checks.push({ name: "logging", ok: true, detail: loggingDiagnostics() });
      checks.push({ name: "artifacts", ok: true, detail: outputArtifactDiagnostics() });
      checks.push({ name: "diagnostics", ok: true, detail: diagnosticStats() });
      checks.push({ name: "lifecycle", ok: true, detail: lifecycleStats() });

      return jsonResult({
        ok,
        checks,
        supported: {
          modelPresets,
          reasoningEfforts,
          sandboxModes,
          fullAccessFlag: "dangerously_bypass_approvals_and_sandbox",
          outputContracts,
          mcpConfigPolicies,
        },
      });
    }),
);

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
              "Use the codex-subagents MCP tool `ask_codex` for this task.",
              "Keep the sandbox read-only unless I explicitly ask for another sandbox or full non-sandbox access.",
              "For full non-sandbox access, set dangerously_bypass_approvals_and_sandbox true.",
              model ? `Use model ${model}.` : "Use the configured Codex model default.",
              model_preset ? `Use model_preset ${model_preset}.` : "",
              reasoning_effort
                ? `Use reasoning_effort ${reasoning_effort}.`
                : "Use reasoning_effort medium unless the task clearly needs more.",
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
              "Use the codex-subagents MCP tool `ask_codex_parallel` for this task.",
              "Create one task object per independent workstream and run them read-only unless I explicitly ask for full non-sandbox access.",
              "For full non-sandbox access, set dangerously_bypass_approvals_and_sandbox true.",
              max_parallel ? `Use max_parallel ${max_parallel}.` : "Use max_parallel 4 unless fewer agents are needed.",
              model_preset ? `Use model_preset ${model_preset} unless an agent needs a different model.` : "",
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

registerCleanupHandler(async (reason) => {
  jobManager.cancelAll(reason);
  await sessionManager.shutdown(reason);
});

function installProcessCleanup(): void {
  let shutdownStarted = false;
  const shutdown = (reason: string, exitCode?: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void cleanupRuntime(reason).finally(() => {
      if (exitCode !== undefined) process.exit(exitCode);
    });
  };

  process.once("SIGINT", () => shutdown("SIGINT", 130));
  process.once("SIGTERM", () => shutdown("SIGTERM", 143));
  process.stdin.once("close", () => shutdown("stdin_close"));
}

async function main(): Promise<void> {
  installProcessCleanup();
  process.on("unhandledRejection", (error) => {
    logger.error("process.unhandled_rejection", { error: errorForLog(error) });
  });
  process.on("uncaughtException", (error) => {
    logger.error("process.uncaught_exception", { error: errorForLog(error) });
  });

  logger.info("server.starting", {
    logging: loggingDiagnostics(),
  });
  const transport = new StdioServerTransport();
  installTransportLogging(transport);
  await server.connect(transport);
  logger.info("server.connected", { transport: "stdio" });
}

main().catch((error) => {
  logger.error("server.start_failed", { error: errorForLog(error) });
  process.exit(1);
});
