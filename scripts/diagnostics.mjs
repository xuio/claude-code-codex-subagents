import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(new URL("..", import.meta.url).pathname);

async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout ?? 15_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString().trim(),
      stderr: error.stderr?.toString().trim(),
      error: error.message,
    };
  }
}

async function which(command) {
  const result = await run("which", [command], { timeout: 5_000 });
  return result.ok && result.stdout ? result.stdout : undefined;
}

async function codexProbe(candidate) {
  if (!candidate) return undefined;
  const version = await run(candidate, ["--version"], { timeout: 10_000 });
  const help = await run(candidate, ["app-server", "--help"], { timeout: 10_000 });
  return {
    path: candidate,
    realpath: version.ok ? await realpath(candidate).catch(() => undefined) : undefined,
    version,
    appServerHelpAvailable: help.ok && help.stdout.includes("generate-json-schema"),
  };
}

const bundleDir = path.join(os.tmpdir(), `codex-subagents-diagnostics-${Date.now().toString(36)}`);
await mkdir(bundleDir, { recursive: true });

const desktopCodex = "/Applications/Codex.app/Contents/Resources/codex";
const pathCodex = await which("codex");
const pathClaude = await which("claude");
const packageJson = JSON.parse((await run("node", ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"])).stdout);

const diagnostics = {
  generatedAt: new Date().toISOString(),
  root,
  package: {
    name: packageJson.name,
    version: packageJson.version,
  },
  platform: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
  },
  environment: {
    presentKeys: Object.keys(process.env)
      .filter((key) => key.startsWith("CODEX_SUBAGENTS_") || key === "CLAUDE_PROJECT_DIR" || key === "CODEX_HOME")
      .sort(),
  },
  git: {
    status: await run("git", ["status", "--short", "--branch"]),
    recentCommits: await run("git", ["log", "--oneline", "-5"]),
    remotes: await run("git", ["remote", "-v"]),
  },
  binaries: {
    codexDesktop: await codexProbe(desktopCodex),
    codexPath: await codexProbe(pathCodex),
    claudePath: pathClaude
      ? {
          path: pathClaude,
          version: await run(pathClaude, ["--version"], { timeout: 10_000 }),
        }
      : undefined,
  },
  build: await run("npm", ["run", "build"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }),
};

const diagnosticsPath = path.join(bundleDir, "diagnostics.json");
await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2), "utf8");

console.log(JSON.stringify({ ok: true, diagnosticsPath, bundleDir }, null, 2));
