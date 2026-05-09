---
description: Launch one or more OpenAI Codex agents from Claude Code for read-only exploration, review, planning, or parallel codebase analysis. Use when the user asks for Codex subagents, parallel Codex agents, or wants Claude Code to delegate work to Codex.
---

# Codex Subagents

Use the `codex-subagents` MCP server when the task benefits from delegating read-only work to OpenAI Codex from inside Claude Code.

Default behavior:

- Launches Codex through `codex exec` over a stdio MCP tool call; no background daemon is required.
- Prefers the Codex desktop app binary at `/Applications/Codex.app/Contents/Resources/codex` when it exists.
- Runs Codex in `read-only` sandbox mode unless the user explicitly requests a different sandbox.
- Uses non-interactive approvals so write or privileged operations fail instead of prompting.
- Lets the caller set model, reasoning effort, project directory, timeout, and parallelism per agent.
- Supports `model_preset: "spark"` for Codex Spark (`gpt-5.3-codex-spark`) without requiring Claude to remember the exact model string.
- Supports nested Codex subagents by passing `codex_subagents`, `subagent_tasks`, and `subagent_runtime`; custom agents are sent as Codex `agents.<name>...` config overrides for the child run.

For one delegated task, call `run_agent`.

For independent tasks that can run concurrently, call `run_agents` with one agent object per task. Keep each prompt concrete and bounded, and ask Codex to return concise findings with file paths and line references when relevant.

When Claude wants Codex to work in the same repository or folder as the active Claude Code session, pass that folder as `project_dir`. Use `cwd` only as a compatibility alias.

Prefer `reasoning_effort: "medium"` for exploration and `high` or `xhigh` only when the task is complex enough to justify the extra latency and token usage.

Use `model_preset: "spark"` for fast, focused work such as UI iteration, narrow exploration, small reviews, and quick sidecar checks.

When nested Codex delegation is needed:

- Put complete custom subagent definitions in `codex_subagents`.
- Use `subagent_tasks` to explicitly tell the parent Codex agent which built-in or custom subagents to spawn.
- Keep `subagent_runtime.max_depth` at `1` unless recursive delegation is deliberately requested; raising it increases cost and latency.
