# Implementation And Test Plan

## Architecture

1. Package a Claude Code plugin with `.claude-plugin/plugin.json`, `.claude-plugin/mcp.json`, and a plugin skill.
2. Run a stdio MCP server from `dist/index.js`; Claude Code owns the server lifecycle, so there is no background daemon.
3. Resolve the Codex binary in this order:
   - per-call `codex_bin`
   - `CODEX_SUBAGENTS_CODEX_BIN`
   - Codex desktop app bundled binary
   - `CODEX_BIN`
   - `codex` on `PATH`
4. Launch Codex with `codex exec --json --sandbox read-only -c approval_policy="never"`.
5. Send the prompt through stdin with `codex exec -` so prompts do not appear in process lists.
6. Accept `project_dir` per agent so Claude Code can run Codex in the same project directory Claude is currently using.
7. Support `model_preset: "spark"` as a stable shorthand for `gpt-5.3-codex-spark`.
8. Support nested Codex subagents by passing custom agent definitions as `agents.<name>...` config overrides, writing compatibility TOML files to a temporary Codex home, setting `CODEX_HOME` only for that child process, and prepending explicit spawn instructions to the parent prompt.
9. For parallel delegation, spawn independent `codex exec` children with a bounded concurrency limiter and return one structured result per agent.

## End-To-End Test Plan

1. Unit test command construction, default read-only sandboxing, reasoning effort config, binary resolution, and timeout handling with a fake Codex binary.
2. MCP smoke test the built server with the MCP TypeScript client and fake Codex binary.
3. Validate the Claude Code plugin manifest with `claude plugin validate .`.
4. Use `npm run test:claude-desktop` to validate and load the plugin with the Claude Code binary shipped inside the Claude desktop app.
5. Start Claude Code locally with `claude --plugin-dir .`.
6. In Claude Code, run `codex_status` and verify the binary resolves to `/Applications/Codex.app/Contents/Resources/codex` when the Codex desktop app is installed.
7. Ask Claude to launch one Codex agent in read-only mode against this repo and confirm it returns a concise result without modifying files.
8. Ask Claude to launch three parallel read-only Codex agents with distinct prompts and confirm all results are returned in one MCP response.
9. Run `npm run test:reliability` to cover default `CLAUDE_PROJECT_DIR`, explicit project dirs, failures, timeouts, invalid project dirs, parallelism, mixed parallel failures, Spark presets, custom subagent config overrides, temporary Codex home cleanup, and nested spawn prompts.
10. Run `npm run test:codex-runtime` to verify the installed Codex desktop binary supports the required `exec` flags, `multi_agent`, and the `gpt-5.3-codex` plus `gpt-5.3-codex-spark` model slugs without invoking a model.
11. Run a smoke test that passes `model_preset: "spark"`, `codex_subagents`, `subagent_tasks`, and `subagent_runtime`, then confirm the fake Codex process receives the temporary custom agent TOML and `agents.<name>...` config overrides.
12. Try an agent prompt that asks Codex to write a file and confirm the read-only sandbox prevents writes.
