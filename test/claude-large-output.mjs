import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const projectDir = root;
const claudeCodeRoot = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code",
);

function compareVersions(a, b) {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function resolveClaudeCodeBinary() {
  if (process.env.CLAUDE_ORCHESTRATION_BIN) {
    return { version: "override", binary: process.env.CLAUDE_ORCHESTRATION_BIN };
  }

  const entries = await readdir(claudeCodeRoot, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const binary = path.join(
      claudeCodeRoot,
      entry.name,
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
    try {
      const info = await stat(binary);
      if (info.isFile()) candidates.push({ version: entry.name, binary });
    } catch {
      // Ignore incomplete desktop app installs.
    }
  }

  candidates.sort((a, b) => compareVersions(a.version, b.version));
  const resolved = candidates.at(-1);
  if (!resolved) {
    throw new Error(`No Claude Code desktop CLI found under ${claudeCodeRoot}`);
  }
  return resolved;
}

function extractJsonResult(rawResult) {
  const trimmed = rawResult.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

const prompt = `Validate that the installed codex-subagents plugin handles oversized Codex output without surfacing a Claude tool-result overflow error. Use only the codex-subagents MCP tools. Use this exact fake Codex binary: ${fakeCodex}. Use this exact project_dir: ${projectDir}.

Call run_agent with prompt "CLAUDE_LARGE_OUTPUT BIG_FINAL_CHARS=80000 BIG_STDOUT_CHARS=80000 BIG_STDERR_CHARS=80000", project_dir, codex_bin, reasoning_effort "low", timeout_ms 60000.

Verify the tool result says agent.ok true and agent.mcpResponse.compacted true. Return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "compacted": boolean}.`;

const { version, binary } = await resolveClaudeCodeBinary();
console.log(`Using Claude Code for large-output validation ${version}: ${binary}`);

const result = spawnSync(
  binary,
  [
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "mcp__plugin_codex-subagents_codex-subagents__run_agent",
    "--model",
    process.env.CLAUDE_ORCHESTRATION_MODEL ?? "claude-haiku-4-5-20251001",
    "--effort",
    process.env.CLAUDE_ORCHESTRATION_EFFORT ?? "low",
    "--max-budget-usd",
    process.env.CLAUDE_ORCHESTRATION_MAX_BUDGET_USD ?? "0.50",
    "--no-session-persistence",
    "--output-format",
    "json",
    "-p",
    prompt,
  ],
  {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    },
    maxBuffer: 16 * 1024 * 1024,
  },
);

const output = [result.stdout, result.stderr].filter(Boolean).join("");
if (result.status !== 0) {
  throw new Error(`Claude large-output command failed (${result.status}):\n${output}`);
}
if (output.includes("exceeds maximum allowed tokens")) {
  throw new Error(`Claude reported a tool-result overflow:\n${output}`);
}

const envelope = JSON.parse(result.stdout);
assert(envelope.subtype === "success", "Claude large-output validation should complete successfully", envelope);
assert(envelope.is_error === false, "Claude large-output validation should not report an error", envelope);
assert(
  Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
  "Claude large-output validation should not hit permission denials",
  envelope.permission_denials,
);

const validation = extractJsonResult(envelope.result);
assert(validation.ok === true, "Claude should report the Codex run succeeded", validation);
assert(validation.compacted === true, "Claude should observe MCP response compaction", validation);

console.log(
  `Claude large-output validation passed in ${envelope.duration_ms}ms, cost $${envelope.total_cost_usd}`,
);
