---
description: Launch one or more OpenAI Codex agents from Claude Code for read-only exploration, review, planning, second opinions, Spark checks, or parallel codebase analysis. Use automatically when the user asks for Codex, OpenAI Codex, Codex Spark, Codex subagents, parallel Codex agents, a Codex second opinion, or for Claude Code to delegate work to Codex.
---

# Codex Subagents

Use the `codex-subagents` MCP server when the task benefits from delegating read-only work to OpenAI Codex from inside Claude Code. If the user asks to "use Codex", "ask Codex", "launch Codex subagents", "use Spark", "get a Codex second opinion", or "run parallel Codex agents", call the MCP tools directly. Do not wait for the user to name the MCP tool.

Default behavior:

- Launches Codex through `codex exec` over a stdio MCP tool call; no background daemon is required.
- Prefers the Codex desktop app binary at `/Applications/Codex.app/Contents/Resources/codex` when it exists.
- Runs Codex in `read-only` sandbox mode unless the user explicitly requests a different sandbox.
- Uses non-interactive approvals so write or privileged operations fail instead of prompting.
- Lets the caller set model, reasoning effort, project directory, timeout, and parallelism per agent.
- Supports `model_preset: "spark"` for Codex Spark (`gpt-5.3-codex-spark`) without requiring Claude to remember the exact model string.
- Supports nested Codex subagents by passing `codex_subagents`, `subagent_tasks`, and `subagent_runtime`; custom agents are sent as Codex `agents.<name>...` config overrides for the child run.

For one delegated task, call `run_agent`. Make the prompt self-contained: include the scope, the expected read-only behavior, and the output shape Claude needs. For code review and exploration, ask for concise findings with file paths and line references.

For independent tasks that can run concurrently, call `run_agents` with one agent object per task. Split by ownership such as API flow, tests, security, performance, UI, docs, or migration risk. Keep prompts concrete and bounded, and set `max_parallel` to the smaller of the useful agent count and `4` unless the user asks for more.

When Claude wants Codex to work in the same repository or folder as the active Claude Code session, pass that folder as `project_dir`. Use `cwd` only as a compatibility alias.

Prefer `reasoning_effort: "medium"` for exploration and `high` or `xhigh` only when the task is complex enough to justify the extra latency and token usage.

Use `model_preset: "spark"` for responsive, focused work such as UI iteration, narrow exploration, small reviews, and quick sidecar checks.

Do not set `service_tier` by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.

Use `codex_status` only when diagnosing installation or binary resolution, or after a failed Codex tool call. Normal delegation should start with `run_agent` or `run_agents`.

Example single-agent call:

```json
{
  "prompt": "Review the MCP server implementation read-only. Return the top risks with file paths and line references, then a brief summary.",
  "project_dir": "/path/to/project",
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

Example parallel call:

```json
{
  "agents": [
    {
      "name": "api",
      "prompt": "Review the MCP tool schemas and runtime options read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "tests",
      "prompt": "Review the test coverage read-only. Identify missing scenarios with paths.",
      "project_dir": "/path/to/project"
    }
  ],
  "max_parallel": 2,
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

When nested Codex delegation is needed:

- Put complete custom subagent definitions in `codex_subagents`.
- Use `subagent_tasks` to explicitly tell the parent Codex agent which built-in or custom subagents to spawn.
- Keep `subagent_runtime.max_depth` at `1` unless recursive delegation is deliberately requested; raising it increases cost and latency.
