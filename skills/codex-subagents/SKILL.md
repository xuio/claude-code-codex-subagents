---
description: Launch one or more OpenAI Codex agents from Claude Code for read-only-by-default exploration, review, planning, second opinions, Spark checks, parallel codebase analysis, or explicit full-access Codex work. Use automatically when the user asks for Codex, OpenAI Codex, Codex Spark, Codex subagents, parallel Codex agents, a Codex second opinion, or for Claude Code to delegate work to Codex.
---

# Codex Subagents

Use the `codex-subagents` MCP server when the task benefits from delegating work to OpenAI Codex from inside Claude Code. If the user asks to "use Codex", "ask Codex", "launch Codex subagents", "use Spark", "get a Codex second opinion", or "run parallel Codex agents", call the MCP tools directly. Do not wait for the user to name the MCP tool.

Default behavior:

- Launches Codex through `codex exec` over a stdio MCP tool call; no background daemon is required.
- Prefers the Codex desktop app binary at `/Applications/Codex.app/Contents/Resources/codex` when it exists.
- Runs Codex in `read-only` sandbox mode unless the user explicitly requests a different sandbox.
- Uses non-interactive approvals so write or privileged operations fail instead of prompting.
- Supports explicit non-sandbox/full-access execution with `dangerously_bypass_approvals_and_sandbox: true`, which maps to Codex's `--dangerously-bypass-approvals-and-sandbox` flag and allows DNS/network plus unrestricted file and git writes.
- Lets the caller set model, reasoning effort, project directory, timeout, and parallelism per agent.
- Supports `model_preset: "spark"` for Codex Spark (`gpt-5.3-codex-spark`) without requiring Claude to remember the exact model string.
- Supports nested Codex subagents by passing `codex_subagents`, `subagent_tasks`, and `subagent_runtime`; custom agents are sent as Codex `agents.<name>...` config overrides for the child run.
- Supports persistent Codex sessions with `start_codex_session` and `continue_codex_session`; use these when the same Codex subagent should keep context across multiple prompts.
- Supports structured results with `output_contract` or `output_schema`; use these when Claude must merge, compare, or aggregate Codex outputs.
- Redacts secret-looking output by default and does not forward secret-looking environment variables unless `forward_sensitive_env` is explicitly true.
- Writes very verbose JSONL logs to stderr by default, including raw MCP JSON-RPC frames, tool arguments/results, prompt outputs, progress notifications, queue/job/session lifecycle, and Codex stdin/stdout/stderr traffic.
- Compacts large tool responses before returning them to Claude; when `mcpResponse.compacted` is true, use the returned summary first and inspect server logs only if the omitted raw tail is necessary.

Prefer the intuitive front-door tools for normal use:

- For one delegated task, call `ask_codex`. Make `task` self-contained: include the scope, expected read-only behavior, and output shape Claude needs. For code review and exploration, ask for concise findings with file paths and line references.
- For independent tasks that can run concurrently, call `ask_codex_parallel` with one task object per workstream. Split by ownership such as API flow, tests, security, performance, UI, docs, or migration risk. Keep tasks concrete and bounded, and set `max_parallel` to the smaller of the useful agent count and `4` unless the user asks for more.
- For multi-turn Codex work, call `start_codex_session` for the initial task and `continue_codex_session` for follow-ups. Session tools use Codex's recorded thread id and remain daemonless; the MCP server keeps only metadata and the last result.
- If unsure which path fits, call `codex_choose_tool` before delegating.

Use the lower-level compatibility tools only when they fit better: `run_agent`, `run_agents`, `start_session`, and `send_session_prompt` expose the same execution paths with more literal naming. When Claude needs a concise consensus object from several agents, call `run_agents_aggregate`. Prefer `output_contract: "review_findings"` for review-style aggregation.

For slow, broad, or potentially flaky Codex work, prefer `start_agent_run` or `start_agents_run` instead of the blocking tools. Poll with `get_agent_run`, wait with `wait_agent_run`, and cancel with `cancel_agent_run` when the work is no longer needed. The async tools keep the MCP request responsive and use the same global Codex process queue.

When Claude wants Codex to work in the same repository or folder as the active Claude Code session, pass that folder as `project_dir`. Use `cwd` only as a compatibility alias.

Do not use Bash, Read, or filesystem inspection to locate Codex. The MCP server resolves Codex automatically and prefers the Codex desktop app binary when it is installed.

When the user explicitly asks Codex to edit files, write to git, use DNS/network, install packages, or otherwise run with normal non-sandbox Codex capabilities, set `dangerously_bypass_approvals_and_sandbox: true`. Keep it off for routine review or exploration.

Prefer `reasoning_effort: "medium"` for exploration and `high` or `xhigh` only when the task is complex enough to justify the extra latency and token usage. Do not use `minimal`; the plugin rejects it because Codex currently auto-attaches `web_search`, which the API does not allow with minimal reasoning.

Use `model_preset: "spark"` for responsive, focused work such as UI iteration, narrow exploration, small reviews, and quick sidecar checks.

Do not set `reasoning_summary` with `model_preset: "spark"` except for `reasoning_summary: "none"`. Spark does not support `reasoning.summary`, and the plugin rejects unsupported combinations before starting Codex.

Do not set `service_tier` by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.

Set `isolated_codex_home: true` when unrelated Codex MCP servers from the user's `~/.codex/config.toml` should not be loaded for the run.

Use `mcp_config_policy: "explicit"` with `codex_mcp_servers` when the user intentionally wants to share MCP servers with Codex. Use `mcp_config_policy: "inherit_claude_project"` only when `project_dir` has a Claude project MCP config that should be imported.

Use `codex_doctor` or `codex_status` only when diagnosing installation, binary resolution, defaults, or after a failed Codex tool call. Normal delegation should start with `ask_codex`, `ask_codex_parallel`, `run_agents_aggregate`, or a session tool.

Example single-agent call:

```json
{
  "task": "Review the MCP server implementation read-only. Return the top risks with file paths and line references, then a brief summary.",
  "project_dir": "/path/to/project",
  "model_preset": "spark",
  "reasoning_effort": "medium"
}
```

Example parallel call:

```json
{
  "tasks": [
    {
      "name": "api",
      "task": "Review the MCP tool schemas and runtime options read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "tests",
      "task": "Review the test coverage read-only. Identify missing scenarios with paths.",
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
