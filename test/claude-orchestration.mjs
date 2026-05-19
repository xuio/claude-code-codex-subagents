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

const prompt = `Validate the codex-subagents Claude Code plugin from inside Claude Code. Use only the codex-subagents MCP tools. Use this exact fake Codex binary for every Codex tool call: ${fakeCodex}. Use this exact project_dir for every agent tool call: ${projectDir}.

Perform exactly these checks:
1. Call codex_status with codex_bin set to the fake Codex binary. Verify ok is true and binary.source is explicit.
2. Call run_agent with prompt "claude-inside-single RUN_COMMAND_EVENT", project_dir, codex_bin, model_preset "spark", reasoning_effort "low", timeout_ms 60000. Verify ok true, sandbox read-only, cwd equals project_dir, model is gpt-5.3-codex-spark, and command event parsing includes command "rg example".
3. Call run_agents with two agents named alpha and beta, prompts "claude-inside-alpha DELAY_MS=40" and "claude-inside-beta DELAY_MS=40", project_dir on each agent, codex_bin at the shared level, max_parallel 2. Verify ok true and two successful agents are returned with cwd equal to project_dir.
4. Call run_agent with prompt "claude-inside-nested", project_dir, codex_bin, model_preset "spark", codex_subagents containing one custom agent named "ui_spark" with description "Fast focused UI iteration.", developer_instructions "Stay scoped and concise.", model_preset "spark", reasoning_effort "medium", sandbox "read-only"; subagent_tasks containing one task for agent "ui_spark" with name "toolbar" and prompt "Inspect the toolbar."; subagent_runtime max_threads 4 and max_depth 2. Verify ok true, model is gpt-5.3-codex-spark, codexSubagents.customAgents includes ui_spark, requestedTasks is 1, and tempCodexHomeUsed is true.

Return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "checks": {"status": boolean, "single": boolean, "parallel": boolean, "nested": boolean}, "details": {"statusSource": string, "singleModel": string, "parallelCount": number, "nestedTempHome": boolean}}`;

const { version, binary } = await resolveClaudeCodeBinary();
console.log(`Using Claude Code for orchestration ${version}: ${binary}`);

const result = spawnSync(
  binary,
  [
    "--plugin-dir",
    ".",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "local",
    "--allowedTools",
    [
      "mcp__plugin_codex-subagents_codex-subagents__codex_status",
      "mcp__plugin_codex-subagents_codex-subagents__run_agent",
      "mcp__plugin_codex-subagents_codex-subagents__run_agents",
    ].join(","),
    "--model",
    process.env.CLAUDE_ORCHESTRATION_MODEL ?? "claude-haiku-4-5-20251001",
    "--effort",
    process.env.CLAUDE_ORCHESTRATION_EFFORT ?? "low",
    "--max-budget-usd",
    process.env.CLAUDE_ORCHESTRATION_MAX_BUDGET_USD ?? "0.80",
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
  throw new Error(`Claude orchestration command failed (${result.status}):\n${output}`);
}

const envelope = JSON.parse(result.stdout);
assert(envelope.subtype === "success", "Claude orchestration should complete successfully", envelope);
assert(envelope.is_error === false, "Claude orchestration should not report an error", envelope);
assert(
  Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
  "Claude orchestration should not hit permission denials",
  envelope.permission_denials,
);

const validation = extractJsonResult(envelope.result);
assert(validation.ok === true, "Claude should report overall success", validation);
assert(validation.checks?.status === true, "Claude should validate codex_status", validation);
assert(validation.checks?.single === true, "Claude should validate run_agent", validation);
assert(validation.checks?.parallel === true, "Claude should validate run_agents", validation);
assert(validation.checks?.nested === true, "Claude should validate nested Spark subagents", validation);
assert(validation.details?.statusSource === "explicit", "codex_status should use explicit fake binary", validation);
assert(
  validation.details?.singleModel === "gpt-5.3-codex-spark",
  "single run should use Spark preset",
  validation,
);
assert(validation.details?.parallelCount === 2, "parallel run should return two agents", validation);
assert(validation.details?.nestedTempHome === true, "nested run should use temp Codex home", validation);

console.log(
  `Claude orchestration passed in ${envelope.duration_ms}ms, cost $${envelope.total_cost_usd}`,
);
