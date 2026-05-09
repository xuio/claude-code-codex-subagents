# Claude Code Codex Subagents

[![CI](https://github.com/xuio/claude-code-codex-subagents/actions/workflows/ci.yml/badge.svg)](https://github.com/xuio/claude-code-codex-subagents/actions/workflows/ci.yml)

Claude Code plugin that exposes OpenAI Codex agents through a daemonless stdio MCP server.

The plugin lets Claude Code launch one Codex agent or several Codex agents in parallel. It is designed for read-only delegation by default: codebase exploration, review, planning, risk checks, documentation mapping, and other sidecar work where Claude should collect independent Codex results without giving those agents write access.

## Defaults

- Codex binary: prefers `/Applications/Codex.app/Contents/Resources/codex` when the Codex desktop app is installed, then falls back to configured overrides and `codex` on `PATH`.
- Sandbox: `read-only`.
- Approvals: non-interactive `approval_policy="never"`.
- Service tier: omitted by default so Codex uses its normal account/default service tier. Pass `service_tier` only when you explicitly want one.
- Transport: stdio MCP, launched by Claude Code for the active session. No daemon is required.
- Prompt delivery: stdin, not command-line arguments.
- Codex home: uses the user's Codex home by default; pass `isolated_codex_home: true` to use a temporary Codex home with auth but without inherited `config.toml` MCP servers.

Optional environment overrides:

- `CODEX_SUBAGENTS_CODEX_BIN`: explicit Codex CLI path.
- `CODEX_SUBAGENTS_DEFAULT_MODEL`: model to use when a tool call omits `model`.
- `CODEX_SUBAGENTS_DEFAULT_REASONING_EFFORT`: `low`, `medium`, `high`, or `xhigh`. `minimal` is ignored as a default and falls back to `medium`.

## Spark And Nested Subagents

Use `model_preset: "spark"` to launch a top-level Codex agent with `gpt-5.3-codex-spark`. Exact `model` still wins when both are provided.

Spark does not support `reasoning_summary`; the plugin rejects `model_preset: "spark"` with `reasoning_summary` values other than `none` before starting Codex.

`reasoning_effort: "minimal"` is also rejected before starting Codex because the current Codex CLI auto-attaches `web_search`, which the API does not allow with minimal reasoning. Use `low` or higher.

To let a Codex agent spawn its own Codex subagents, pass:

- `codex_subagents`: custom Codex agent definitions with `name`, `description`, `developer_instructions`, optional `model` or `model_preset`, reasoning effort, sandbox, MCP servers, skills config, and extra config.
- `subagent_tasks`: the specific built-in or custom subagents the parent Codex run should spawn and wait for.
- `subagent_runtime`: runtime limits such as `max_threads`, `max_depth`, and `job_max_runtime_seconds`.

Custom subagents are passed to Codex as `agents.<name>...` config overrides and also materialized in a temporary Codex home for the duration of one run. The target project is not modified, and the default sandbox remains `read-only`.

## Installation

```sh
git clone <repo-url>
cd claude-code-codex-subagents
npm install
npm run build
claude --plugin-dir .
```

The plugin manifest points Claude Code at `dist/index.js`, so run `npm run build` after changing TypeScript source. The built file is committed so the plugin can be loaded directly from a clone.

## Development

```sh
npm install
npm run build
npm test
npm run test:comprehensive
npm run validate:plugin
npm run test:claude-desktop
```

`test:ci` is the GitHub-safe suite. It uses the fake Codex binary and does not require Claude Code, the Codex desktop app, or live model credentials.

`test:comprehensive` runs the TypeScript build, unit tests, stdio MCP smoke test, reliability matrix, Codex desktop runtime probe, Claude plugin validation, and desktop-shipped Claude Code CLI plugin/auth checks. The runtime probe validates local Codex capabilities without invoking a model.

`test:claude-orchestration` is an opt-in live Claude Code test. It loads the plugin inside Claude Code, lets Claude call the plugin MCP tools, and uses the fake Codex binary so no Codex model tokens are spent. It is kept out of `test:comprehensive` because it does spend Claude tokens.

`test:claude-real-codex` is the full opt-in live path: Claude Code loads the plugin and calls real Codex through the desktop app binary, including one single agent, one parallel run, and one nested Spark subagent run. It spends both Claude and Codex tokens, so it is intentionally not part of the default suite.

`test:claude-autodiscovery` is an opt-in live Claude Code test for automatic tool selection. It gives Claude a natural "ask Codex" request, uses the installed plugin and fake Codex binary, and verifies that Claude chooses the Codex MCP tool without being told the exact tool name.

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

`run_agent` launches one Codex `exec` process.

`run_agents` launches multiple Codex `exec` processes concurrently with a bounded `max_parallel` setting.

`codex_status` reports the resolved Codex binary, server working directory, Claude project directory, default model, default reasoning effort, and version probe.

Each agent accepts model, reasoning effort, sandbox, project directory, timeout, isolated Codex home, and output-size controls. Pass `project_dir` when Claude Code wants Codex to inspect the same repository or subdirectory Claude is currently working in. If `project_dir` is omitted, the server uses `CLAUDE_PROJECT_DIR` when Claude Code provides it. Omit model to use Codex's configured default or the plugin's optional configured default model.

## License

MIT
