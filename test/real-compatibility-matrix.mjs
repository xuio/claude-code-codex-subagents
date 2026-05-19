import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

async function executableExists(candidate) {
  if (!candidate) return undefined;
  try {
    await access(candidate);
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}

async function which(command) {
  try {
    const { stdout } = await execFileAsync("which", [command], { encoding: "utf8" });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function codexCandidates() {
  const candidates = [
    process.env.CLAUDE_REAL_CODEX_BIN,
    process.env.CODEX_SUBAGENTS_CODEX_BIN,
    "/Applications/Codex.app/Contents/Resources/codex",
    await which("codex"),
  ];
  const resolved = [];
  for (const candidate of candidates) {
    const real = await executableExists(candidate);
    if (real && !resolved.includes(real)) resolved.push(real);
  }
  return resolved;
}

async function checkContract(codexBin) {
  const out = await mkdtemp(path.join(os.tmpdir(), "codex-real-matrix-schema-"));
  try {
    await execFileAsync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", out], {
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const name of [
      "v2/ThreadStartParams.json",
      "v2/TurnStartParams.json",
      "v2/TurnSteerParams.json",
      "v2/TurnInterruptParams.json",
      "v2/TurnCompletedNotification.json",
    ]) {
      await access(path.join(out, name));
    }
    const turnSteer = JSON.parse(await readFile(path.join(out, "v2/TurnSteerParams.json"), "utf8"));
    assert(
      ["threadId", "expectedTurnId", "input"].every((field) => turnSteer.required?.includes(field)),
      "turn/steer schema lost a required field",
      { codexBin, required: turnSteer.required },
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function checkMcpStatus(codexBin) {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-real-matrix-project-"));
  const client = new Client({ name: "codex-real-matrix", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: path.join(root, "dist/index.js"),
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      CLAUDE_PROJECT_DIR: projectDir,
      CODEX_SUBAGENTS_LOG_PROFILE: "production",
    },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const status = await client.callTool(
      {
        name: "codex_status",
        arguments: { codex_bin: codexBin },
      },
      CallToolResultSchema,
      { timeout: 20_000, resetTimeoutOnProgress: true },
    );
    assert(status.structuredContent?.ok, "codex_status should pass for candidate", {
      codexBin,
      status: status.structuredContent,
    });
    assert(
      status.structuredContent?.binary?.source === "explicit",
      "codex_status should use the candidate as an explicit binary",
      status.structuredContent,
    );
  } finally {
    await transport.close().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  }
}

const candidates = await codexCandidates();
assert(candidates.length > 0, "No Codex binary candidates found for real compatibility matrix");

const results = [];
for (const codexBin of candidates) {
  const { stdout } = await execFileAsync(codexBin, ["--version"], { encoding: "utf8" });
  assert(stdout.includes("codex-cli"), "candidate should report a Codex CLI version", { codexBin, stdout });
  await checkContract(codexBin);
  await checkMcpStatus(codexBin);
  results.push({ codexBin, version: stdout.trim() });
}

console.log(JSON.stringify({ ok: true, candidates: results }, null, 2));
