# Changelog

## 0.3.0

- Refactored the default Claude-facing MCP surface to three native tools: `codex_task`, `codex_task_group`, and `codex_followup`.
- Made every `codex_task` result return a `session_id` so Claude can continue or steer Codex context naturally.
- Moved uncommon settings under `advanced` and replaced the default full-access flag with `full_access`.
- Hid debug and legacy tools by default; diagnostics are now available through `codex://usage`, `codex://status`, and `codex://doctor`.
- Updated the Claude skill, README, wiki, and validation scripts for the native follow-up flow.

## 0.2.0

- Refreshed the README into a shorter onboarding page.
- Added usage, architecture, development, and troubleshooting docs.
- Added GitHub issue templates and a pull request template.
- Added a local install/update script and wiki publishing script.
- Documented known limitations and release notes.
- Tightened Claude tool-selection guidance for sessions, steering, aggregation, and async jobs.

## 0.1.1

- Compacted large MCP tool responses so successful long Codex runs do not surface as Claude Code tool-result overflow errors.

## 0.1.0

- Initial Claude Code plugin for launching Codex agents through a daemonless stdio MCP server.
- Added read-only defaults, non-interactive approvals, Codex desktop binary resolution, and per-call `project_dir`.
- Added explicit full-access mode via `dangerously_bypass_approvals_and_sandbox`.
- Added verbose default stderr logging for raw MCP JSON-RPC traffic, progress, queue/job/session lifecycle, and Codex process communication.
- Added single-agent, parallel-agent, Spark preset, and nested Codex subagent support.
- Added unit, MCP smoke, reliability, runtime, desktop Claude Code, and opt-in live Claude/Codex validation scripts.
