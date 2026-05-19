import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CODEX_SUBAGENTS_CODEX_BIN: path.join(root, "test/fixtures/fake-codex.mjs"),
    },
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  const allowedStatuses = options.allowedStatuses ?? [0];
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(" ")}\n${output}`,
    );
  }
  return output;
}

function summarizeAuthStatus(output) {
  try {
    const parsed = JSON.parse(output);
    return {
      loggedIn: parsed.loggedIn,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
      subscriptionType: parsed.subscriptionType,
    };
  } catch {
    return { raw: output.trim() ? "[non-json auth status output]" : "[empty auth status output]" };
  }
}

const { version, binary } = await resolveClaudeCodeBinary();
console.log(`Using Claude Code desktop CLI ${version}: ${binary}`);

console.log(run(binary, ["--version"]).trim());

const validationOutput = run(binary, ["plugin", "validate", "."]);
if (!validationOutput.includes("Validation passed")) {
  throw new Error(`Plugin validation did not pass:\n${validationOutput}`);
}
console.log("Embedded CLI plugin validation passed");

const pluginListOutput = run(binary, ["--plugin-dir", ".", "plugin", "list"]);
if (!pluginListOutput.includes("codex-subagents@inline")) {
  throw new Error(`Plugin was not loaded as a session plugin:\n${pluginListOutput}`);
}
console.log("Embedded CLI session plugin load passed");

const authOutput = run(binary, ["auth", "status"], { allowedStatuses: [0, 1] });
console.log(`Embedded CLI auth status: ${JSON.stringify(summarizeAuthStatus(authOutput), null, 2)}`);
