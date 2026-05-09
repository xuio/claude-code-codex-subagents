import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const codexBin =
  process.env.CLAUDE_REAL_CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";
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
  if (process.env.CLAUDE_REAL_CODEX_CLAUDE_BIN) {
    return { version: "override", binary: process.env.CLAUDE_REAL_CODEX_CLAUDE_BIN };
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

const prompt = `Validate the codex-subagents Claude Code plugin from inside Claude Code using the real Codex binary. Use only the codex-subagents MCP tools. Use this exact real Codex binary for every Codex tool call: ${codexBin}. Use this exact project_dir for every agent tool call: ${root}.

Keep every Codex prompt small and read-only.

Perform exactly these checks:
1. Call codex_status with codex_bin set to the real Codex binary. Verify ok is true, binary.source is explicit, and version contains codex-cli.
2. Call run_agent with prompt "Real Claude-to-Codex validation. Stay read-only. Do not modify files. Reply exactly REAL_CLAUDE_SINGLE_OK", project_dir, codex_bin, model_preset "spark", reasoning_effort "low", timeout_ms 180000. Verify ok true, sandbox read-only, cwd equals project_dir, model is gpt-5.3-codex-spark, and finalMessage contains REAL_CLAUDE_SINGLE_OK.
3. Call run_agents with two agents named alpha and beta, prompts "Stay read-only. Reply exactly REAL_PARALLEL_ALPHA_OK" and "Stay read-only. Reply exactly REAL_PARALLEL_BETA_OK", project_dir on each agent, codex_bin at the shared level, model_preset "spark", reasoning_effort "low", max_parallel 2, timeout_ms 180000. Verify ok true, two successful agents are returned with cwd equal to project_dir, and their final messages contain the requested tokens.
4. Call run_agent with prompt "Real nested Codex validation. Stay read-only. Spawn the requested child subagent, wait for it, and if it returns CHILD_OK then reply exactly REAL_CLAUDE_NESTED_OK. Do not modify files.", project_dir, codex_bin, model_preset "spark", reasoning_effort "low", timeout_ms 300000, codex_subagents containing one custom agent named "ui_spark" with description "Fast focused validation agent.", developer_instructions "Stay read-only. For this validation task, reply exactly CHILD_OK and do not modify files.", model_preset "spark", reasoning_effort "low", sandbox "read-only"; subagent_tasks containing one task for agent "ui_spark" with name "child" and prompt "Reply exactly CHILD_OK. Do not modify files."; subagent_runtime max_threads 2, max_depth 1, job_max_runtime_seconds 180. Verify ok true, model is gpt-5.3-codex-spark, finalMessage contains REAL_CLAUDE_NESTED_OK, customAgents includes ui_spark, requestedTasks is 1, and tempCodexHomeUsed is true.

Return exactly one compact JSON object and no markdown. Shape: {"ok": boolean, "checks": {"status": boolean, "single": boolean, "parallel": boolean, "nested": boolean}, "details": {"statusVersion": string, "singleModel": string, "parallelCount": number, "nestedTempHome": boolean}}`;

const { version, binary } = await resolveClaudeCodeBinary();
console.log(`Using Claude Code for real Codex orchestration ${version}: ${binary}`);
console.log(`Using real Codex binary: ${codexBin}`);

const env = { ...process.env };
delete env.CODEX_SUBAGENTS_CODEX_BIN;

const result = spawnSync(
  binary,
  [
    "--plugin-dir",
    ".",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    [
      "mcp__plugin_codex-subagents_codex-subagents__codex_status",
      "mcp__plugin_codex-subagents_codex-subagents__run_agent",
      "mcp__plugin_codex-subagents_codex-subagents__run_agents",
    ].join(","),
    "--model",
    process.env.CLAUDE_REAL_CODEX_MODEL ?? "claude-haiku-4-5-20251001",
    "--effort",
    process.env.CLAUDE_REAL_CODEX_EFFORT ?? "low",
    "--max-budget-usd",
    process.env.CLAUDE_REAL_CODEX_MAX_BUDGET_USD ?? "1.50",
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
    env,
    maxBuffer: 32 * 1024 * 1024,
  },
);

const output = [result.stdout, result.stderr].filter(Boolean).join("");
if (result.status !== 0) {
  throw new Error(`Claude real Codex orchestration command failed (${result.status}):\n${output}`);
}

const envelope = JSON.parse(result.stdout);
assert(envelope.subtype === "success", "Claude real Codex orchestration should succeed", envelope);
assert(envelope.is_error === false, "Claude real Codex orchestration should not report an error", envelope);
assert(
  Array.isArray(envelope.permission_denials) && envelope.permission_denials.length === 0,
  "Claude real Codex orchestration should not hit permission denials",
  envelope.permission_denials,
);

const validation = extractJsonResult(envelope.result);
assert(validation.ok === true, "Claude should report overall success", validation);
assert(validation.checks?.status === true, "Claude should validate codex_status", validation);
assert(validation.checks?.single === true, "Claude should validate real run_agent", validation);
assert(validation.checks?.parallel === true, "Claude should validate real run_agents", validation);
assert(validation.checks?.nested === true, "Claude should validate real nested Spark subagents", validation);
assert(
  String(validation.details?.statusVersion ?? "").includes("codex-cli"),
  "codex_status should return the real Codex CLI version",
  validation,
);
assert(
  validation.details?.singleModel === "gpt-5.3-codex-spark",
  "single real run should use Spark preset",
  validation,
);
assert(validation.details?.parallelCount === 2, "parallel real run should return two agents", validation);
assert(validation.details?.nestedTempHome === true, "nested real run should use temp Codex home", validation);

console.log(
  `Claude real Codex orchestration passed in ${envelope.duration_ms}ms, Claude cost $${envelope.total_cost_usd}`,
);
