# Release Notes

## v0.3.0

`v0.3.0` focuses on making Codex subagents feel native to Claude.

Highlights:

- Default tool surface is now `codex_task`, `codex_task_group`, and
  `codex_followup`.
- `codex_task` always returns a `session_id` for follow-up, wait, or steering.
- Power-user knobs moved under `advanced`; routine calls use `description`,
  `prompt`, `project_dir`, `reasoning`, `subagent_type`, and `full_access`.
- Diagnostics are resources by default: `codex://usage`, `codex://status`, and
  `codex://doctor`.
- Debug and legacy tools are hidden unless explicitly enabled by environment.

## v0.2.0

`v0.2.0` is the first public-ready release candidate for
`claude-code-codex-subagents`.

Highlights:

- Daemonless Claude Code MCP plugin for launching OpenAI Codex agents.
- Read-only Codex delegation by default.
- Codex desktop app binary preferred automatically when installed.
- Front-door tools for one agent, parallel agents, aggregation, persistent
  sessions, async sessions, live steering, recovery, and diagnostics.
- Codex Spark preset support.
- Nested Codex subagent definitions and task requests.
- App-server persistent sessions with recoverable metadata and live steering.
- Backpressure, progress notifications, response compaction, output artifacts,
  diagnostics bundles, and verbose logging.
- Local install/update script for development and user installs.
- GitHub-friendly README, docs, issue templates, PR template, and wiki source.

Recommended install/update:

```sh
git clone https://github.com/xuio/claude-code-codex-subagents.git
cd claude-code-codex-subagents
npm run install:local
```

Recommended verification:

```sh
npm run test:ci
npm run check:dist
npm run test:codex-runtime
npm run test:real-matrix
```

Live Claude/Codex validation remains opt-in because it spends tokens:

```sh
npm run test:claude-orchestration
npm run test:claude-real-codex
npm run test:claude-real-session
```
