# Claude Code Codex Subagents

[![CI](https://github.com/xuio/claude-code-codex-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/xuio/claude-code-codex-subagents/actions/workflows/ci.yml)

Claude Code plugin that exposes OpenAI Codex agents through a daemonless stdio MCP server.

The plugin lets Claude Code launch one Codex agent or several Codex agents in parallel. It is designed for read-only delegation by default: codebase exploration, review, planning, risk checks, documentation mapping, and other sidecar work where Claude should collect independent Codex results without giving those agents write access. When explicitly requested, Claude can also launch Codex with the same full local capabilities as normal non-sandbox Codex.

## Defaults

- Codex binary: prefers `/Applications/Codex.app/Contents/Resources/codex` when the Codex desktop app is installed, then falls back to configured overrides and `codex` on `PATH`.
- Sandbox: `read-only`.
- Approvals: non-interactive `approval_policy="never"`.
- Full local access: opt in per call with `dangerously_bypass_approvals_and_sandbox: true`, which maps to Codex's `--dangerously-bypass-approvals-and-sandbox` flag and allows DNS/network access plus unrestricted file and git writes.
- Service tier: omitted by default so Codex uses its normal account/default service tier. Pass `service_tier` only when you explicitly want one.
- Transport: stdio MCP, launched by Claude Code for the active session. No daemon is required.
- Prompt delivery: stdin, not command-line arguments.
- Codex home: uses the user's Codex home by default; pass `isolated_codex_home: true` to use a temporary Codex home with auth but without inherited `config.toml` MCP servers.
- Concurrency: Codex processes run through a global queue. Defaults are `CODEX_SUBAGENTS_MAX_GLOBAL_PROCESSES=4` and `CODEX_SUBAGENTS_MAX_PROJECT_PROCESSES=2`.
- Progress: long-running tools emit MCP `notifications/progress` events when the client supplies a progress token.
- Logging: verbose JSONL logs are written to stderr by default. The logs include raw MCP JSON-RPC frames, tool arguments/results, prompt outputs, progress notifications, queue/job/session lifecycle, and Codex stdin/stdout/stderr traffic.
- MCP responses: long Codex outputs are compacted before returning to Claude so successful runs do not trip Claude Code's tool-result size limits. The full raw traffic remains available in the verbose server logs.
- Security: secret-looking output is redacted before it is returned to Claude, and secret-looking environment variables are not forwarded to Codex unless `forward_sensitive_env` is explicitly true.
- Sessions: `start_session` and `send_session_prompt` use Codex's recorded thread id so a Codex subagent can keep context across multiple prompts without a background daemon.

Optional environment overrides:

- `CODEX_SUBAGENTS_CODEX_BIN`: explicit Codex CLI path.
- `CODEX_SUBAGENTS_DEFAULT_MODEL`: model to use when a tool call omits `model`.
- `CODEX_SUBAGENTS_DEFAULT_REASONING_EFFORT`: `low`, `medium`, `high`, or `xhigh`. `minimal` is ignored as a default and falls back to `medium`.
- `CODEX_SUBAGENTS_MAX_GLOBAL_PROCESSES`: maximum Codex child processes across this MCP server.
- `CODEX_SUBAGENTS_MAX_PROJECT_PROCESSES`: maximum Codex child processes per project key.
- `CODEX_SUBAGENTS_JOB_TTL_SECONDS`: completed async job retention window. Defaults to one hour.
- `CODEX_SUBAGENTS_LOG_LEVEL`: `debug`, `info`, `warn`, `error`, or `silent`. Defaults to `debug`.
- `CODEX_SUBAGENTS_LOG_MAX_STRING_CHARS`: maximum string payload retained per log field before truncation metadata is used. Defaults to `20000`.
- `CODEX_SUBAGENTS_PROGRESS_HEARTBEAT_MS`: interval for progress heartbeats on blocking tool calls. Defaults to `10000`.

## Spark And Nested Subagents

Use `model_preset: "spark"` to launch a top-level Codex agent with `gpt-5.3-codex-spark`. Exact `model` still wins when both are provided.

Spark does not support `reasoning_summary`; the plugin rejects `model_preset: "spark"` with `reasoning_summary` values other than `none` before starting Codex.

`reasoning_effort: "minimal"` is also rejected before starting Codex because the current Codex CLI auto-attaches `web_search`, which the API does not allow with minimal reasoning. Use `low` or higher.

To let a Codex agent spawn its own Codex subagents, pass:

- `codex_subagents`: custom Codex agent definitions with `name`, `description`, `developer_instructions`, optional `model` or `model_preset`, reasoning effort, sandbox, MCP servers, skills config, and extra config.
- `subagent_tasks`: the specific built-in or custom subagents the parent Codex run should spawn and wait for.
- `subagent_runtime`: runtime limits such as `max_threads`, `max_depth`, and `job_max_runtime_seconds`.

Custom subagents are passed to Codex as `agents.<name>...` config overrides and also materialized in a temporary Codex home for the duration of one run. The target project is not modified, and the default sandbox remains `read-only`.

## Full Access Mode

By default, all tools run Codex with `--sandbox read-only`. If the user explicitly asks Codex to edit files, use network/DNS, run git writes, install packages, or otherwise behave like an unrestricted local Codex run, pass:

```json
{
  "dangerously_bypass_approvals_and_sandbox": true
}
```

This uses Codex's `--dangerously-bypass-approvals-and-sandbox` flag. It bypasses all sandboxing and approval prompts for that Codex process, so keep it request-scoped and do not set it as a default.

## Structured Output And MCP Config

Pass `output_contract` when Claude needs machine-readable Codex results:

- `review_findings`
- `plan`
- `risk_matrix`
- `patch_suggestions`

You can also pass `output_schema` with a custom JSON Schema. The plugin passes schemas to Codex through `--output-schema`, parses the final JSON message, and returns it as `structuredOutput`.

MCP sharing is explicit:

- `mcp_config_policy: "inherit_codex"` uses the user's normal Codex config.
- `mcp_config_policy: "isolated"` uses a temporary Codex home without inherited MCP servers.
- `mcp_config_policy: "explicit"` uses only `codex_mcp_servers`.
- `mcp_config_policy: "inherit_claude_project"` imports `.mcp.json` or `.claude/mcp.json` from `project_dir` when present.

## Installation

```sh
git clone <repo-url>
cd claude-code-codex-subagents
npm install
npm run build
claude --plugin-dir .
```

The plugin manifest points Claude Code at `dist/index.js`, so run `npm run build` after changing TypeScript source. The built file is committed so the plugin can be loaded directly from a clone.

For local development against the installed plugin, link Claude's installed cache entry directly to this repository:

```sh
npm run dev:link
```

This makes both the Homebrew Claude Code CLI and the Claude Desktop bundled Claude Code CLI read the same working tree through `~/.claude/plugins/cache/codex-subagents-local/codex-subagents/<version>`. TypeScript source still needs to be rebuilt into `dist/index.js`; keep this running while editing MCP code:

```sh
npm run dev:watch
```

## Development

```sh
npm install
npm run build
npm run dev:link
npm test
npm run test:comprehensive
npm run validate:plugin
npm run test:claude-desktop
```

`test:ci` is the GitHub-safe suite. It uses the fake Codex binary and does not require Claude Code, the Codex desktop app, or live model credentials.

`test:comprehensive` runs the TypeScript build, unit tests, stdio MCP smoke test, reliability matrix, MCP stress test, MCP progress notification test, advanced MCP behavior test, Codex desktop runtime probe, Claude plugin validation, and desktop-shipped Claude Code CLI plugin/auth checks. The runtime probe validates local Codex capabilities without invoking a model.

`test:stress` uses the fake Codex binary to exercise queued async jobs, noisy output, malformed JSONL, and truncation behavior.

`test:progress` verifies that SDK clients receive monotonically increasing MCP progress notifications from blocking, async start, parallel, and wait-style tool calls.

`test:advanced` verifies structured output, secret redaction, safe env forwarding, partial job snapshots, persistent sessions, result aggregation, doctor diagnostics, and explicit MCP config materialization through the stdio MCP server.

`test:claude-orchestration` is an opt-in live Claude Code test. It loads the plugin inside Claude Code, lets Claude call the plugin MCP tools, and uses the fake Codex binary so no Codex model tokens are spent. It is kept out of `test:comprehensive` because it does spend Claude tokens.

`test:claude-real-codex` is the full opt-in live path: Claude Code loads the plugin and calls real Codex through the desktop app binary, including one single agent, one parallel run, and one nested Spark subagent run. It spends both Claude and Codex tokens, so it is intentionally not part of the default suite.

`test:claude-real-session` is an opt-in live Claude Code test for daemonless persistent sessions. It loads the symlinked installed plugin, starts a real Codex session, sends a follow-up without `project_dir`, and verifies the session stays pinned to the original project directory.

`test:claude-autodiscovery` is an opt-in live Claude Code test for automatic tool selection. It gives Claude a natural "ask Codex" request, loads the local plugin with the fake Codex binary, and verifies that Claude chooses the intuitive Codex MCP front door without being told the exact low-level tool name.

Run Claude Code with the local plugin:

```sh
claude --plugin-dir .
```

After startup, ask Claude to use Codex subagents, or invoke the plugin skill:

```text
/codex-subagents:codex-subagents run three read-only Codex agents: one for API flow, one for tests, one for security risks
```

## MCP Tools

`codex_usage_guide` returns the operating guide and example calls Claude can use when deciding how to delegate to Codex.

`codex_choose_tool` returns a concise decision guide for picking between one agent, parallel agents, persistent sessions, aggregation, and async jobs.

`ask_codex` is the preferred front door for one Codex task. It launches one Codex `exec` process and waits for it.

`ask_codex_parallel` is the preferred front door for multiple independent Codex tasks. It launches bounded parallel Codex `exec` processes and returns one structured result per task.

`start_codex_session` and `continue_codex_session` are the preferred front doors for daemonless persistent Codex sessions.

`start_codex_session_async` starts a persistent Codex session and returns a `session.id` immediately while Codex keeps working.

`send_codex_session_prompt` queues an additional prompt onto an active or idle Codex session. It returns immediately by default and can also wait for completion.

`steer_codex_session` inserts a high-priority steering prompt into a persistent Codex session. By default it runs after the active turn; `interrupt_current: true` cancels the active turn and runs the steering turn next.

`get_codex_session` and `wait_codex_session` inspect or wait for long-running Codex sessions and queued turns.

`run_agent` launches one Codex `exec` process and waits for it. It uses the same bounded queue as async jobs and remains available for lower-level/manual control.

`run_agents` launches multiple Codex `exec` processes concurrently with a bounded `max_parallel` setting and the global queue.

`run_agents_aggregate` launches multiple agents and returns both raw agent results and a deterministic aggregation object.

`start_agent_run` starts one queued Codex run and returns a `job.id` immediately.

`start_agents_run` starts a queued parallel Codex run and returns a `job.id` immediately.

`get_agent_run`, `wait_agent_run`, and `cancel_agent_run` inspect, wait for, or cancel async jobs.

`start_session`, `send_session_prompt`, `get_session`, `list_sessions`, and `cancel_session` manage daemonless persistent Codex sessions using Codex's own resumable thread ids. They are compatibility aliases behind the intuitive session tools.

`codex_status` reports the resolved Codex binary, server working directory, Claude project directory, default model, default reasoning effort, feature sets, and version probe.

`codex_doctor` runs installation and safety diagnostics without invoking a model.

Each agent accepts model, reasoning effort, sandbox, full-access bypass, project directory, timeout, isolated Codex home, and output-size controls. Pass `project_dir` when Claude Code wants Codex to inspect the same repository or subdirectory Claude is currently working in. If `project_dir` is omitted, the server uses `CLAUDE_PROJECT_DIR` when Claude Code provides it. Omit model to use Codex's configured default or the plugin's optional configured default model.

Prefer `start_agent_run` or `start_agents_run` for work that may run longer than a normal MCP request. The async job API keeps Claude responsive, supports cancellation, and avoids request failures caused by long-running Codex subprocesses.

Async job snapshots expose partial stdout/stderr and parsed event summaries through `get_agent_run` while work is still running.

When a client supports MCP progress tokens, `ask_codex`, `ask_codex_parallel`, `start_codex_session`, `continue_codex_session`, `start_codex_session_async`, `send_codex_session_prompt`, `steer_codex_session`, `wait_codex_session`, `run_agent`, `run_agents`, `run_agents_aggregate`, `start_session`, `send_session_prompt`, `start_agent_run`, `start_agents_run`, `get_agent_run`, `wait_agent_run`, and `cancel_agent_run` send progress notifications. SDK clients should pass an `onprogress` handler and enable timeout reset on progress for long waits.

## License

MIT
