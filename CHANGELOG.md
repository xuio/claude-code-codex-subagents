# Changelog

## 0.1.0

- Initial Claude Code plugin for launching Codex agents through a daemonless stdio MCP server.
- Added read-only defaults, non-interactive approvals, Codex desktop binary resolution, and per-call `project_dir`.
- Added explicit full-access mode via `dangerously_bypass_approvals_and_sandbox`.
- Added verbose default stderr logging for raw MCP JSON-RPC traffic, progress, queue/job/session lifecycle, and Codex process communication.
- Added single-agent, parallel-agent, Spark preset, and nested Codex subagent support.
- Added unit, MCP smoke, reliability, runtime, desktop Claude Code, and opt-in live Claude/Codex validation scripts.
