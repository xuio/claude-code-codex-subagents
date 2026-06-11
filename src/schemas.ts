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
import { modelPresets } from "./subagents.js";

export const reasoningEffortSchema = z.enum(reasoningEfforts);
export const publicReasoningSchema = z.enum(["low", "medium", "high"]);
export const sandboxModeSchema = z.enum(sandboxModes);
export const serviceTierSchema = z.enum(serviceTiers);
export const modelVerbositySchema = z.enum(modelVerbosities);
export const reasoningSummarySchema = z.enum(reasoningSummaries);
export const modelPresetSchema = z.enum(modelPresets);
export const outputContractSchema = z.enum(outputContracts);
export const mcpConfigPolicySchema = z.enum(mcpConfigPolicies);
export const looseRecordSchema = z.record(z.unknown());

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

export const commonInputSchema = {
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

export const frontDoorInputSchema = {
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

export const advertisedCodexRoleValues = [
  "general-purpose",
  "code-reviewer",
  "security-reviewer",
  "explorer",
  "planner",
  "patcher",
  "docs",
] as const;
const codexRoleAliasValues = [
  "reviewer",
  "security",
  "performance",
  "tests",
  "risk",
  "ui",
] as const;
export const advertisedCodexRoleSchema = z.enum(advertisedCodexRoleValues);
export const codexRoleSchema = z.enum([
  ...advertisedCodexRoleValues,
  ...codexRoleAliasValues,
]);
export type CodexRole = z.infer<typeof codexRoleSchema>;

export const codexRoleDefaults: Record<
  CodexRole,
  {
    reasoning?: (typeof reasoningEfforts)[number];
    output_contract?: (typeof outputContracts)[number];
    sandbox?: (typeof sandboxModes)[number];
    persona: string;
  }
> = {
  "general-purpose": {
    reasoning: "medium",
    output_contract: "freeform",
    sandbox: "read-only",
    persona:
      "You are a general-purpose Codex subagent. Work independently, stay scoped to the task, and return a concise answer with concrete file paths or commands when relevant.",
  },
  "code-reviewer": {
    reasoning: "medium",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a code-review subagent. Look for correctness, security, reliability, and maintainability issues. Lead with findings ordered by severity; each finding needs a file:line reference and a short recommendation. Do not summarize the code unless there are no findings.",
  },
  "security-reviewer": {
    reasoning: "high",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a security-review subagent. Focus on exploitable behavior, secret handling, injection, authz/authn, filesystem/network exposure, and unsafe defaults. Report only actionable risks with file:line evidence and severity.",
  },
  reviewer: {
    reasoning: "medium",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a code-review subagent. Look for correctness, security, reliability, and maintainability issues. Lead with findings ordered by severity; each finding needs a file:line reference and a short recommendation. Do not summarize the code unless there are no findings.",
  },
  explorer: {
    reasoning: "low",
    output_contract: "freeform",
    sandbox: "read-only",
    persona:
      "You are exploring a codebase. Return concise findings with file paths and line numbers first. Do not edit files, do not propose broad refactors, and keep prose minimal.",
  },
  security: {
    reasoning: "high",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a security-review subagent. Focus on exploitable behavior, secret handling, injection, authz/authn, filesystem/network exposure, and unsafe defaults. Report only actionable risks with file:line evidence and severity.",
  },
  performance: {
    reasoning: "high",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a performance-review subagent. Find concrete latency, CPU, memory, I/O, concurrency, or scaling risks. Prefer measured or code-backed findings and include exact file:line references.",
  },
  tests: {
    reasoning: "medium",
    output_contract: "review_findings",
    sandbox: "read-only",
    persona:
      "You are a test-coverage subagent. Identify missing or weak tests for the requested change. Return focused gaps with the behavior to test, where the test should live, and why it matters.",
  },
  planner: {
    reasoning: "high",
    output_contract: "plan",
    sandbox: "read-only",
    persona:
      "You are a planning subagent. Produce a practical implementation plan grounded in the current codebase. Keep scope tight, call out risks and dependencies, and do not edit files.",
  },
  risk: {
    reasoning: "high",
    output_contract: "risk_matrix",
    sandbox: "read-only",
    persona:
      "You are a risk-analysis subagent. Identify concrete technical, operational, security, and compatibility risks. Rank by likelihood and impact, and include mitigation suggestions.",
  },
  patcher: {
    reasoning: "high",
    output_contract: "patch_suggestions",
    sandbox: "workspace-write",
    persona:
      "You are a patch-suggestion subagent. Propose minimal, codebase-consistent changes. If editing is allowed by the sandbox, keep the patch tightly scoped and list changed files.",
  },
  docs: {
    reasoning: "medium",
    output_contract: "freeform",
    sandbox: "read-only",
    persona:
      "You are a documentation subagent. Improve clarity, accuracy, examples, and user-facing guidance. Keep suggestions concrete and aligned with the existing documentation style.",
  },
  ui: {
    reasoning: "medium",
    output_contract: "freeform",
    sandbox: "read-only",
    persona:
      "You are a UI-review subagent. Focus on usability, accessibility, responsive behavior, design-system consistency, and concrete frontend implementation details.",
  },
};

export const advancedInputSchema = z
  .object({
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Exact Codex model, or alias `spark` / `codex`. Omit by default; use `spark` only when the user asks for Codex Spark or a quick focused sidecar check.",
      ),
    model_preset: modelPresetSchema
      .optional()
      .describe("Compatibility preset retained for older callers. Prefer advanced.model for new calls."),
    reasoning: reasoningEffortSchema
      .optional()
      .describe("Advanced reasoning effort, including xhigh. Minimal is still rejected by this server."),
    reasoning_effort: reasoningEffortSchema
      .optional()
      .describe("Compatibility alias for advanced.reasoning."),
    sandbox: sandboxModeSchema
      .optional()
      .describe("Advanced sandbox override. Leave unset for normal read-only Codex delegation."),
    service_tier: commonInputSchema.service_tier,
    model_verbosity: commonInputSchema.model_verbosity,
    reasoning_summary: commonInputSchema.reasoning_summary,
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
    include_diagnostics: z
      .boolean()
      .default(false)
      .describe("Include verbose diagnostics in the tool response. Leave false unless debugging this MCP server."),
    dangerously_bypass_approvals_and_sandbox:
      commonInputSchema.dangerously_bypass_approvals_and_sandbox.optional(),
    wait_for_completion: z
      .boolean()
      .optional()
      .describe("Advanced compatibility flag. Prefer top-level background on native tools."),
  })
  .strict()
  .describe(
    "DO NOT USE unless the user explicitly asked for exact model, timeout, diagnostics, custom MCP sharing, nested Codex subagents, or another uncommon Codex setting.",
  );

export const advertisedAdvancedInputSchema = looseRecordSchema.describe(
  "Power-user Codex settings object. Usually omit. Common keys: model (`spark`, `codex`, or exact model), reasoning (`xhigh` only when explicitly requested), timeout_ms, include_diagnostics, sandbox, codex_bin, output_contract, output_schema, codex_subagents, subagent_tasks, subagent_runtime, and MCP sharing options. The server validates this object strictly at runtime.",
);

export const nativeBaseInputSchema = {
  project_dir: commonInputSchema.project_dir.describe(
    "Project directory for Codex. Defaults to CLAUDE_PROJECT_DIR from Claude Code; usually omit this unless the user specified a directory.",
  ),
  reasoning: publicReasoningSchema
    .optional()
    .describe("Codex reasoning effort for normal use. Omit for medium; use high only for difficult analysis."),
  full_access: z
    .boolean()
    .default(false)
    .describe("Allow Codex to write files, use network/DNS, and modify git. Only true when the user explicitly asks for non-sandbox execution."),
  advanced: advertisedAdvancedInputSchema.optional(),
};

export const parallelRunOverrideSchema = {
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
};

export const parallelAgentSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      "Concrete independent task for this Codex agent. Keep overlap low across parallel agents.",
    ),
  name: z.string().trim().min(1).optional().describe("Optional label for this agent."),
  ...parallelRunOverrideSchema,
});

export const frontDoorParallelTaskSchema = z.object({
  task: z
    .string()
    .min(1)
    .describe(
      "Concrete independent Codex task. Keep overlap low across parallel tasks and state the expected output shape.",
    ),
  name: z.string().trim().min(1).optional().describe("Optional label for this Codex task."),
  ...parallelRunOverrideSchema,
});

export const nativeTaskGroupTaskSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1)
    .describe("Short task label, like Claude's native Task description."),
  prompt: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Self-contained Codex prompt for this independent task. Keep overlap low across parallel tasks.",
    ),
  subagent_type: advertisedCodexRoleSchema
    .optional()
    .describe("Claude-style Codex persona. Prefer general-purpose, explorer, planner, code-reviewer, or security-reviewer."),
  name: z.string().trim().min(1).optional().describe("Optional stable label for this Codex task."),
  keep_session: z
    .boolean()
    .default(false)
    .describe("Return this task's session_id after completion so Claude can follow up. Leave false for native Task-like one-shot work."),
  ...nativeBaseInputSchema,
});

export const followupModeSchema = z.enum(["queue", "steer", "wait", "cancel"]);
export const jobIdSchema = z.string().trim().min(1).describe("Job id returned by start_agent_run or start_agents_run.");
export const sessionIdSchema = z.string().trim().min(1).describe("Session id returned by codex_task or codex_task_group.");

export type AdvancedInput = z.infer<typeof advancedInputSchema>;
export type PublicReasoning = z.infer<typeof publicReasoningSchema>;
export type NativeBaseInput = {
  project_dir?: string;
  reasoning?: PublicReasoning;
  full_access?: boolean;
  advanced?: unknown;
};
export type NativeTaskV3Input = NativeBaseInput & {
  description: string;
  prompt: string;
  subagent_type?: CodexRole;
  background?: boolean;
  keep_session?: boolean;
  session_name?: string;
};
export type NativeTaskGroupItemV3Input = NativeBaseInput & {
  description: string;
  prompt: string;
  subagent_type?: CodexRole;
  name?: string;
  keep_session?: boolean;
};
export type NativeTaskGroupV3Input = NativeBaseInput & {
  tasks: NativeTaskGroupItemV3Input[];
  max_parallel?: number;
};
export type NativeFollowupMode = "queue" | "steer" | "wait" | "cancel";
export type NativeFollowupInput = NativeBaseInput & {
  session_id: string;
  description?: string;
  prompt?: string;
  reason?: string;
  mode?: NativeFollowupMode;
  interrupt_current?: boolean;
  background?: boolean;
  turn_id?: string;
  wait_timeout_ms?: number;
};
export type NativeWaitAnyInput = {
  session_ids: string[];
  wait_timeout_ms?: number;
};
