import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  defaultModel,
  defaultReasoningEffort,
  modelVerbosities,
  probeCodexVersion,
  reasoningEfforts,
  reasoningSummaries,
  runAgent,
  runAgents,
  sandboxModes,
  serviceTiers,
} from "./runner.js";
import { cleanOption } from "./binary.js";
import { modelPresets } from "./subagents.js";

const usageGuide = [
  "Claude Code integration guide for codex-subagents:",
  "",
  "Use this MCP server whenever the user asks Claude to use Codex, OpenAI Codex, Codex subagents, Codex Spark, a Codex second opinion, parallel Codex review, or independent Codex codebase analysis. You do not need the user to name an MCP tool.",
  "",
  "Tool choice:",
  "- Use run_agent for one delegated Codex task.",
  "- Use run_agents when the work can be split into independent concurrent tasks, for example separate reviewers for API flow, tests, security, performance, UI, docs, or migration risk.",
  "- Use codex_status only for diagnostics or when you need to confirm the Codex binary/version.",
  "- Use codex_usage_guide if you are unsure how to structure a Codex delegation.",
  "",
  "Default operating rules:",
  "- Keep sandbox read-only unless the user explicitly asks for a different sandbox.",
  "- Approvals are non-interactive; do not expect Codex to ask permission.",
  "- Prefer model_preset \"spark\" for fast focused checks, small reviews, UI iteration, and responsive sidecar analysis.",
  "- Use reasoning_effort \"medium\" by default, \"low\" for simple checks, and \"high\" or \"xhigh\" only for difficult analysis.",
  "- Pass project_dir whenever Claude knows the active project directory so Codex works in the same tree as Claude Code.",
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
      "Convenience model preset. Use `spark` for fast Codex Spark work; it maps to gpt-5.3-codex-spark.",
    ),
  reasoning_effort: reasoningEffortSchema
    .optional()
    .describe(
      "Codex model reasoning effort. Prefer medium by default, low for simple checks, high/xhigh only for difficult analysis.",
    ),
  sandbox: sandboxModeSchema
    .default("read-only")
    .describe("Codex sandbox mode. Keep read-only unless the user explicitly asks otherwise."),
  service_tier: serviceTierSchema
    .default("fast")
    .describe("Codex service tier. Defaults to fast for responsiveness."),
  model_verbosity: modelVerbositySchema
    .optional()
    .describe("Optional GPT-5 model verbosity override."),
  reasoning_summary: reasoningSummarySchema
    .optional()
    .describe("Optional Codex reasoning summary setting."),
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

function toRunOptions(args: {
  prompt: string;
  name?: string;
  model?: string;
  model_preset?: (typeof modelPresets)[number];
  reasoning_effort?: (typeof reasoningEfforts)[number];
  sandbox?: (typeof sandboxModes)[number];
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
      "Launch one OpenAI Codex agent via codex exec. Use automatically when the user asks Claude to use Codex, ask Codex, get a Codex second opinion, run a Codex subagent, use Codex Spark, or delegate one read-only analysis task. Defaults to the Codex desktop app binary when installed, read-only sandbox, fast service tier, and non-interactive approvals.",
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
  async (args) => {
    try {
      const result = await runAgent(toRunOptions(args));
      return jsonResult({ agent: result }, !result.ok);
    } catch (error) {
      return jsonResult(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
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
  codex_subagents: commonInputSchema.codex_subagents,
  subagent_tasks: commonInputSchema.subagent_tasks,
  subagent_runtime: commonInputSchema.subagent_runtime,
});

server.registerTool(
  "run_agents",
  {
    title: "Run parallel Codex agents",
    description:
      "Launch multiple independent OpenAI Codex agents concurrently and return one structured result per agent. Use automatically when the user asks for parallel Codex agents, multiple Codex subagents, broad review by independent agents, or several concurrent Codex workstreams. Split work by clear ownership, pass project_dir, keep defaults read-only, and use max_parallel to bound concurrency.",
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
  async (args) => {
    try {
      const results = await runAgents({
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
      });
      const ok = results.every((result) => result.ok);
      return jsonResult(
        {
          ok,
          agents: results,
        },
        !ok,
      );
    } catch (error) {
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
        defaultServiceTier: "fast",
        modelPresets: {
          codex: "gpt-5.3-codex",
          spark: "gpt-5.3-codex-spark",
        },
        pluginCodexBin: cleanOption(process.env.CODEX_SUBAGENTS_CODEX_BIN),
        claudeProjectDir: cleanOption(process.env.CLAUDE_PROJECT_DIR),
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

server.registerPrompt(
  "codex_agent",
  {
    title: "Delegate to one Codex agent",
    description: "Prompt Claude to launch one read-only Codex agent through this MCP server.",
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
            "Keep the sandbox read-only unless I explicitly say otherwise.",
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
      "Prompt Claude to split independent work across multiple read-only Codex agents through this MCP server.",
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
            "Create one agent object per independent workstream and run them read-only.",
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
