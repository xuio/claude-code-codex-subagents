---
description: Launch one or more OpenAI Codex agents from Claude Code for read-only-by-default exploration, review, planning, second opinions, Spark checks, parallel codebase analysis, or explicit full-access Codex work. Use automatically when the user asks for Codex, OpenAI Codex, Codex Spark, Codex subagents, parallel Codex agents, a Codex second opinion, or for Claude Code to delegate work to Codex.
---

# Codex Subagents

Use the `codex-subagents` MCP server like Claude's native Task tool when the task benefits from an independent OpenAI Codex worker inside Claude Code. If the user asks to "use Codex", "ask Codex", "launch Codex subagents", "use Spark", "get a Codex second opinion", or "run parallel Codex agents", call the MCP tools directly. Do not wait for the user to name the MCP tool.

Default behavior:

- Launches one-shot Codex work through `codex exec`; persistent sessions use `codex app-server --listen stdio://` by default for real live steering. The app-server child is owned by the MCP server process, so no external background daemon is required.
- Prefers the Codex desktop app binary at `/Applications/Codex.app/Contents/Resources/codex` when it exists.
- Runs Codex in `read-only` sandbox mode unless the user explicitly requests a different sandbox.
- Uses non-interactive approvals so write or privileged operations fail instead of prompting.
- Supports explicit non-sandbox/full-access execution with `full_access: true`, which maps to Codex's `--dangerously-bypass-approvals-and-sandbox` flag and allows DNS/network plus unrestricted file and git writes.
- Lets the caller set model, reasoning effort, project directory, timeout, and parallelism per agent. Put uncommon settings under `advanced`.
- Supports `advanced.model: "spark"` for Codex Spark (`gpt-5.3-codex-spark`) without requiring Claude to remember the exact model string.
- Supports nested Codex subagents by passing `advanced.codex_subagents`, `advanced.subagent_tasks`, and `advanced.subagent_runtime`; custom agents are sent as Codex `agents.<name>...` config overrides for the child run.
- Supports persistent Codex sessions through the `session_id` returned by `codex_task` and `codex_task_group`; use `codex_followup` to continue, steer, or wait on the same Codex context.
- Supports structured results with `advanced.output_contract` or `advanced.output_schema`; use these when Claude must merge, compare, or aggregate Codex outputs.
- Redacts secret-looking output by default and does not forward secret-looking environment variables unless `forward_sensitive_env` is explicitly true.
- Writes very verbose JSONL logs to stderr by default, including raw MCP JSON-RPC frames, tool arguments/results, prompt outputs, progress notifications, queue/job/session lifecycle, and Codex stdin/stdout/stderr traffic.
- Compacts large tool responses before returning them to Claude; when `mcpResponse.compacted` is true, use the returned summary first and inspect server logs only if the omitted raw tail is necessary.

Prefer the native Claude-like tools for normal use:

- For one delegated task, call `codex_task`. Provide `description` like Claude's Task description and `prompt` as the self-contained task. For code review and exploration, ask for concise findings with file paths and line references.
- For independent tasks that can run concurrently, call `codex_task_group` with one task object per workstream. Split by ownership such as API flow, tests, security, performance, UI, docs, or migration risk. Keep tasks concrete and bounded, and set `max_parallel` to the smaller of the useful agent count and `4` unless the user asks for more.
- For multi-turn Codex work, call `codex_task` for the initial prompt and preserve the returned `session_id`. Use `codex_followup` with `mode: "queue"` for ordinary follow-ups, `mode: "wait"` when Claude needs completion, and `mode: "steer"` for active redirection.
- Use `codex_followup` mode `steer` only when the user wants to redirect active work now. It delivers real live steering with Codex `turn/steer` when app-server support is active. Set `interrupt_current: true` only when the active turn should be cancelled and redirected.
- If unsure which path fits, call `codex_task` or `codex_followup` first; use MCP resources only for diagnostics or when a tool response explicitly says to inspect a resource.

Legacy tools such as `ask_codex`, `run_agent`, and old session names are hidden by default. They are exposed only when `CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS=1` is set for older clients. Tool-callable diagnostics are hidden unless `CODEX_SUBAGENTS_ENABLE_DEBUG_TOOLS=1`; use resources `codex://status`, `codex://doctor`, and `codex://usage` for normal diagnostics.

When Claude wants Codex to work in the same repository or folder as the active Claude Code session, pass that folder as `project_dir`. Use `cwd` only as a compatibility alias.

Do not use Bash, Read, or filesystem inspection to locate Codex. The MCP server resolves Codex automatically and prefers the Codex desktop app binary when it is installed.

When the user explicitly asks Codex to edit files, write to git, use DNS/network, install packages, or otherwise run with normal non-sandbox Codex capabilities, set `full_access: true`. Keep it off for routine review or exploration.

Prefer top-level `reasoning: "medium"` for exploration and `high` only when the task is complex enough to justify the extra latency and token usage. Use `advanced.reasoning: "xhigh"` only when the user asks for maximum reasoning. Do not use `minimal`; the plugin rejects it because Codex currently auto-attaches `web_search`, which the API does not allow with minimal reasoning.

Do not use `advanced.model: "spark"` by default. Use Spark only when the user asks for Spark or when a quick focused sidecar check is clearly more appropriate than the default Codex model.

Do not set `advanced.reasoning_summary` with `advanced.model: "spark"` except for `advanced.reasoning_summary: "none"`. Spark does not support `reasoning.summary`, and the plugin rejects unsupported combinations before starting Codex.

Do not set `service_tier` by default. Let Codex use its normal account/default service tier unless the user explicitly asks for a service tier.

Verbose debug logs may contain raw MCP traffic and prompt text. Treat diagnostics bundles and logs as sensitive local data.

Set `advanced.isolated_codex_home: true` when unrelated Codex MCP servers from the user's `~/.codex/config.toml` should not be loaded for the run.

Use `advanced.mcp_config_policy: "explicit"` with `advanced.codex_mcp_servers` when the user intentionally wants to share MCP servers with Codex. Use `advanced.mcp_config_policy: "inherit_claude_project"` only when `project_dir` has a Claude project MCP config that should be imported.

Do not use Codex for simple file reads, simple grep/search, or tiny local commands that Claude can do directly faster.

Read `codex://doctor` or `codex://status` only when diagnosing installation, binary resolution, defaults, or after a failed Codex tool call. Normal delegation should start with `codex_task`, `codex_task_group`, or `codex_followup`.

When using Claude's generic `ReadMcpResourceTool`, the server id for this plugin is `plugin:codex-subagents:codex-subagents`. Do not convert the tool prefix `mcp__plugin_codex-subagents_codex-subagents__...` into `plugin_codex-subagents_codex-subagents`; that underscore form is not a server id. Do not use a plain `codex-subagents` server id if Claude also lists the plugin server, because that indicates a stale direct MCP entry and session resources will not line up with plugin tool calls.

Example `codex_task` arguments for a retained session:

```json
{
  "description": "Investigate migration",
  "prompt": "Investigate the migration read-only. Keep notes concise and cite files.",
  "project_dir": "/path/to/project",
  "reasoning": "medium"
}
```

Then queue or steer with the returned `session_id` using `codex_followup`:

```json
{
  "session_id": "session-...",
  "mode": "queue",
  "prompt": "Prioritize the database migration path and ignore UI polish for now."
}
```

Example single-agent call:

```json
{
  "description": "Review MCP server",
  "prompt": "Review the MCP server implementation read-only. Return the top risks with file paths and line references, then a brief summary.",
  "project_dir": "/path/to/project",
  "reasoning": "medium"
}
```

Example parallel call:

```json
{
  "tasks": [
    {
      "name": "api",
      "description": "Review API behavior",
      "prompt": "Review the MCP tool schemas and runtime options read-only. Return concrete risks with paths.",
      "project_dir": "/path/to/project"
    },
    {
      "name": "tests",
      "description": "Review tests",
      "prompt": "Review the test coverage read-only. Identify missing scenarios with paths.",
      "project_dir": "/path/to/project"
    }
  ],
  "max_parallel": 2,
  "reasoning": "medium"
}
```

When nested Codex delegation is needed:

- Put complete custom subagent definitions in `advanced.codex_subagents`.
- Use `advanced.subagent_tasks` to explicitly tell the parent Codex agent which built-in or custom subagents to spawn.
- Keep `advanced.subagent_runtime.max_depth` at `1` unless recursive delegation is deliberately requested; raising it increases cost and latency.
