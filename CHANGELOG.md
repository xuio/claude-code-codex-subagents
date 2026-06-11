# Changelog

## 0.3.0

- Refactored the default Claude-facing MCP surface to three native tools: `codex_task`, `codex_task_group`, and `codex_followup`.
- Added `codex_wait_any` for native-style collection of whichever background Codex session finishes first.
- Made `codex_task` return a `session_id` for background, retained, or failed runs so Claude can continue, steer, wait, or cancel Codex context naturally.
- Moved uncommon settings under `advanced` and replaced the default full-access flag with `full_access`.
- Hid debug and legacy tools by default; diagnostics are now available through `codex://usage`, `codex://status`, and `codex://doctor`.
- Switched persistent sessions to the Codex app-server protocol by default, with live steering, session notifications, and best-effort Codex Desktop thread archiving when sessions are cancelled or pruned.
- Added native cancellation through `codex_followup` mode `cancel`, including partial output preservation.
- Closed successful one-shot app-server sessions that were not returned to Claude, bounded retained turn history, and routed app-server turns through the shared concurrency queue.
- Slimmed advertised native tool schemas, simplified persona/model guidance, and removed duplicate group response text from structured MCP payloads.
- Made the plugin manifest invoke Node explicitly for portable startup.
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
