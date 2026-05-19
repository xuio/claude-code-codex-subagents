import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
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
  sandboxModes,
  serviceTiers,
} from "./runner.js";
import { aggregateAgentResults } from "./aggregate.js";
import { cleanOption } from "./binary.js";
import { jobManager, runQueuedAgent, runQueuedAgents } from "./jobs.js";
import { sessionManager } from "./sessions.js";
import { modelPresets } from "./subagents.js";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ProgressReporter = ReturnType<typeof createProgressReporter>;

const usageGuide = [
  "Claude Code integration guide for codex-subagents:",
  "",
  "Use this MCP server whenever the user asks Claude to use Codex, OpenAI Codex, Codex subagents, Codex Spark, a Codex second opinion, parallel Codex review, or independent Codex codebase analysis. You do not need the user to name an MCP tool.",
  "",
  "Tool choice:",
  "- Use run_agent for one delegated Codex task.",
  "- Use run_agents when the work can be split into independent concurrent tasks, for example separate reviewers for API flow, tests, security, performance, UI, docs, or migration risk.",
  "- Use run_agents_aggregate when Claude needs a concise consensus object from several independent Codex agents.",
  "- Use start_agent_run or start_agents_run for slow or broad Codex work; poll with get_agent_run, wait with wait_agent_run, and cancel with cancel_agent_run.",
  "- Use start_session and send_session_prompt when the user wants a Codex agent to keep context across multiple prompts.",
  "- Use codex_doctor for installation, binary, auth, and default-setting diagnostics.",
  "- Use codex_status only for diagnostics or when you need to confirm the Codex binary/version.",
  "- Use codex_usage_guide if you are unsure how to structure a Codex delegation.",
  "",
  "Default operating rules:",
  "- Keep sandbox read-only unless the user explicitly asks for a different sandbox.",
  "- If the user explicitly asks for non-sandbox/full local capabilities, set dangerously_bypass_approvals_and_sandbox true. This maps to Codex's --dangerously-bypass-approvals-and-sandbox flag and allows DNS/network plus unrestricted file and git writes.",
  "- Approvals are non-interactive; do not expect Codex to ask permission.",
  "- Prefer model_preset \"spark\" for responsive focused checks, small reviews, UI iteration, and sidecar analysis.",
  "- Use reasoning_effort \"medium\" by default, \"low\" for simple checks, and \"high\" or \"xhigh\" only for difficult analysis. Do not use \"minimal\"; Codex currently auto-attaches web_search and the API rejects that tool with minimal reasoning.",
  "- Do not combine model_preset \"spark\" with reasoning_summary values other than \"none\"; Spark does not support reasoning.summary.",
  "- Do not set service_tier by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.",
  "- Pass project_dir whenever Claude knows the active project directory so Codex works in the same tree as Claude Code.",
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
    version: "0.1.0",
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
  return {
    structuredContent: value,
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function createProgressReporter(extra: ToolExtra | undefined) {
  const progressToken = extra?._meta?.progressToken;
  let progress = 0;
  let pending = Promise.resolve();

  async function send(message: string, options: { progress?: number; total?: number } = {}) {
    if (progressToken === undefined || !extra) return;

    pending = pending
      .catch(() => {})
      .then(async () => {
        const requested = options.progress ?? progress + 1;
        progress = Math.max(progress + 1, requested);
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(options.total === undefined ? {} : { total: options.total }),
            message,
          },
        });
      })
      .catch(() => {
        // Progress is best-effort; a failed notification must not fail the tool call.
      });

    await pending;
  }

  async function flush() {
    if (progressToken === undefined || !extra) return;
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { send, flush };
}

async function reportAgentResult(progress: ProgressReporter, result: { ok?: boolean; status?: string }) {
  const status = result.status ?? (result.ok ? "completed" : "failed");
  await progress.send(result.ok ? "Codex run completed" : `Codex run ${status}`);
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
    mcpConfigPolicy: args.mcp_config_policy,
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
      mcpConfigPolicy: agent.mcp_config_policy ?? args.mcp_config_policy,
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

server.registerTool(
  "codex_usage_guide",
  {
    title: "How to use Codex subagents",
    description:
      "Read the operating guide for this MCP server. Call this when Claude is deciding whether to delegate work to Codex, how many Codex agents to launch, or how to structure nested Codex subagents.",
    inputSchema: {},
  },
  async () =>
    jsonResult({
      guide: usageGuide,
      examples: {
        single: {
          tool: "run_agent",
          arguments: {
            prompt:
              "Inspect the authentication flow read-only. Return the top risks with file paths and line references.",
            project_dir: "/path/to/project",
            model_preset: "spark",
            reasoning_effort: "medium",
          },
        },
        parallel: {
          tool: "run_agents",
          arguments: {
            agents: [
              {
                name: "api",
                prompt: "Review API flow read-only. Return concrete findings with paths.",
                project_dir: "/path/to/project",
              },
              {
                name: "tests",
                prompt: "Review test coverage gaps read-only. Return concrete findings with paths.",
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
);

server.registerTool(
  "run_agent",
  {
    title: "Run one Codex agent",
    description:
      "Launch one OpenAI Codex agent via codex exec. Use automatically when the user asks Claude to use Codex, ask Codex, get a Codex second opinion, run a Codex subagent, use Codex Spark, or delegate one read-only analysis task. Defaults to the Codex desktop app binary when installed, read-only sandbox, Codex's normal service tier, and non-interactive approvals. For explicit non-sandbox/full-access requests, set dangerously_bypass_approvals_and_sandbox true.",
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
    const progress = createProgressReporter(extra);
    try {
      await progress.send("Queued Codex run");
      const result = await runQueuedAgent(toRunOptions(args), {
        onStart: (queuedMs) => {
          void progress.send(`Started Codex run after ${queuedMs}ms queued`);
        },
      });
      await reportAgentResult(progress, result);
      await progress.flush();
      return jsonResult({ agent: result }, !result.ok);
    } catch (error) {
      await progress.flush();
      return jsonResult(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
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
    const progress = createProgressReporter(extra);
    try {
      await progress.send("Queued asynchronous Codex run");
      const job = jobManager.startAgent(toRunOptions(args));
      await progress.send(`Started Codex job ${job.id}`);
      await progress.flush();
      return jsonResult({ job });
    } catch (error) {
      await progress.flush();
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
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

server.registerTool(
  "run_agents",
  {
    title: "Run parallel Codex agents",
    description:
      "Launch multiple independent OpenAI Codex agents concurrently and return one structured result per agent. Use automatically when the user asks for parallel Codex agents, multiple Codex subagents, broad review by independent agents, or several concurrent Codex workstreams. Split work by clear ownership, pass project_dir, keep defaults read-only, and use max_parallel to bound concurrency. For explicit non-sandbox/full-access requests, set dangerously_bypass_approvals_and_sandbox true.",
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
    const progress = createProgressReporter(extra);
    try {
      const total = args.agents.length * 2 + 1;
      let completed = 0;
      let failed = 0;
      await progress.send(`Queued ${args.agents.length} Codex agents`, { total });
      const results = await runQueuedAgents(toParallelRunOptions(args), {
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
          await progress.send(message, last ? { progress: total, total } : { total });
        },
      });
      const ok = results.every((result) => result.ok);
      await progress.flush();
      return jsonResult(
        {
          ok,
          agents: results,
        },
        !ok,
      );
    } catch (error) {
      await progress.flush();
      return jsonResult(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
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
    const progress = createProgressReporter(extra);
    try {
      const total = args.agents.length * 2 + 1;
      let completed = 0;
      await progress.send(`Queued ${args.agents.length} Codex agents for aggregation`, { total });
      const results = await runQueuedAgents(toParallelRunOptions(args), {
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
            last ? { progress: total, total } : { total },
          );
        },
      });
      const aggregation = aggregateAgentResults(results);
      await progress.flush();
      return jsonResult(
        {
          ok: aggregation.ok,
          aggregation,
          agents: results,
        },
        !aggregation.ok,
      );
    } catch (error) {
      await progress.flush();
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
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
    const progress = createProgressReporter(extra);
    try {
      await progress.send(`Queued asynchronous run for ${args.agents.length} Codex agents`);
      const job = jobManager.startAgents(toParallelRunOptions(args));
      await progress.send(`Started Codex job ${job.id}`);
      await progress.flush();
      return jsonResult({ job });
    } catch (error) {
      await progress.flush();
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
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
    const progress = createProgressReporter(extra);
    await progress.send(`Checking Codex job ${args.job_id}`);
    await progress.flush();
    const job = jobManager.get(args.job_id);
    if (!job) {
      await progress.flush();
      return jsonResult({ error: `Unknown job_id: ${args.job_id}` }, true);
    }
    return jsonResult({ job });
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
    const progress = createProgressReporter(extra);
    await progress.send(`Waiting for Codex job ${args.job_id}`);
    const started = Date.now();
    let job = jobManager.get(args.job_id);
    while (job && !job.completedAt && Date.now() - started < args.timeout_ms) {
      const remaining = args.timeout_ms - (Date.now() - started);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, Math.max(1, remaining))));
      job = jobManager.get(args.job_id);
      if (job) await progress.send(`Codex job ${job.status}`);
    }
    if (job && !job.completedAt) {
      const waitedJob = await jobManager.wait(args.job_id, 1);
      job = waitedJob ?? job;
    }
    if (!job) return jsonResult({ error: `Unknown job_id: ${args.job_id}` }, true);
    if (job.completedAt) await progress.send(`Codex job ${job.status}`);
    await progress.flush();
    return jsonResult({ job }, job.status === "failed" || job.status === "cancelled");
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
    const progress = createProgressReporter(extra);
    await progress.send(`Cancelling Codex job ${args.job_id}`);
    await progress.flush();
    const job = jobManager.cancel(args.job_id);
    if (!job) return jsonResult({ error: `Unknown job_id: ${args.job_id}` }, true);
    return jsonResult({ job });
  },
);

const sessionIdSchema = z.string().trim().min(1).describe("Session id returned by start_session.");

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
    const progress = createProgressReporter(extra);
    try {
      await progress.send("Starting persistent Codex session");
      const { session, result } = await sessionManager.start(
        {
          ...toRunOptions(args),
          ephemeral: false,
        },
        { sessionName: args.session_name },
      );
      await reportAgentResult(progress, result);
      await progress.flush();
      return jsonResult({ session, agent: result }, !result.ok);
    } catch (error) {
      await progress.flush();
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
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
    const progress = createProgressReporter(extra);
    try {
      await progress.send(`Resuming Codex session ${args.session_id}`);
      const { session, result, error } = await sessionManager.send(args.session_id, args.prompt, toRunOptions(args));
      if (error || !session || !result) {
        await progress.flush();
        return jsonResult({ error, session }, true);
      }
      await reportAgentResult(progress, result);
      await progress.flush();
      return jsonResult({ session, agent: result }, !result.ok);
    } catch (error) {
      await progress.flush();
      return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
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
  async (args) => {
    const session = sessionManager.get(args.session_id);
    if (!session) return jsonResult({ error: `Unknown session_id: ${args.session_id}` }, true);
    return jsonResult({ session });
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "List Codex sessions",
    description: "List persistent Codex sessions held by this daemonless MCP server process.",
    inputSchema: {},
  },
  async () => jsonResult({ sessions: sessionManager.list() }),
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
  async (args) => {
    const session = sessionManager.cancel(args.session_id);
    if (!session) return jsonResult({ error: `Unknown session_id: ${args.session_id}` }, true);
    return jsonResult({ session });
  },
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
  async (args) => {
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
        modelPresets: {
          codex: "gpt-5.3-codex",
          spark: "gpt-5.3-codex-spark",
        },
        outputContracts,
        mcpConfigPolicies,
        pluginCodexBin: cleanOption(process.env.CODEX_SUBAGENTS_CODEX_BIN),
        claudeProjectDir: cleanOption(process.env.CLAUDE_PROJECT_DIR),
        queue: jobManager.stats(),
      });
    } catch (error) {
      return jsonResult(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  },
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
  async (args) => {
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
      checks.push({
        name: "codex_binary",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const projectDir = args.project_dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      checks.push({
        name: "project_dir",
        ok: Boolean(projectDir),
        detail: { projectDir: cleanOption(projectDir) },
      });
    } catch (error) {
      ok = false;
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
  },
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
  ({ prompt, model, reasoning_effort, model_preset }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Use the codex-subagents MCP tool `run_agent` for this task.",
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
  }),
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
  ({ prompt, max_parallel, model_preset }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Use the codex-subagents MCP tool `run_agents` for this task.",
            "Create one agent object per independent workstream and run them read-only unless I explicitly ask for full non-sandbox access.",
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
  }),
);

async function main(): Promise<void> {
  process.on("unhandledRejection", (error) => {
    console.error("codex-subagents unhandled rejection", error);
  });
  process.on("uncaughtException", (error) => {
    console.error("codex-subagents uncaught exception", error);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
