# Security Policy

This plugin launches Codex from Claude Code through a local stdio MCP server. The default execution mode is intentionally conservative:

- Codex runs with `--sandbox read-only`.
- Codex uses non-interactive `approval_policy="never"`.
- Prompts are sent over stdin instead of command-line arguments.
- Custom nested subagents are written to a temporary Codex home and cleaned up after the run.

Full local access is available only when a tool call explicitly sets `dangerously_bypass_approvals_and_sandbox: true`. That passes Codex's `--dangerously-bypass-approvals-and-sandbox` flag, bypassing all sandboxing and approval prompts for that process. Do not enable it for routine review or exploration.

## Reporting A Vulnerability

Please report security issues through GitHub Security Advisories for this repository. If advisories are not available, open an issue with a minimal description and avoid posting secrets, tokens, private logs, or sensitive project contents.

## Handling Secrets

Do not include API keys, OAuth tokens, local auth files, Claude/Codex account output, `.env` files, or machine-specific private paths in issues or pull requests. The test suite uses a fake Codex binary for portable CI coverage.
