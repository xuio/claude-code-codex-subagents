# Quick Start

Requirements:

- Node.js 20 or newer
- Claude Code
- Codex CLI, preferably the Codex desktop app

Install and run locally:

```sh
git clone https://github.com/xuio/claude-code-codex-subagents.git
cd claude-code-codex-subagents
npm run install:local
claude --plugin-dir .
```

Ask Claude:

```text
Use Codex to review this repository read-only. Focus on reliability risks and missing tests.
```

For local development against Claude's installed plugin cache:

```sh
npm run dev:link
npm run dev:watch
```

`dev:link` symlinks Claude's plugin install back to the repository, so Claude Code
CLI and the Claude Desktop bundled Claude Code binary load the same working tree
after `dist/index.js` is rebuilt.

To update an existing local install:

```sh
npm run update:local
```

## Defaults

- Codex binary: Codex desktop app binary when available.
- Sandbox: `read-only`.
- Approvals: `approval_policy="never"`.
- Sessions: Codex app-server by default, exec fallback when allowed.
- Logging: verbose JSONL on stderr.
- Full access: explicit per-call opt-in with `dangerously_bypass_approvals_and_sandbox`.
