import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
const claudeHome = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-claude-home-"));
const installPath = path.join(
  claudeHome,
  `plugins/cache/codex-subagents-local/codex-subagents/${manifest.version}`,
);
const marketplacePath = path.join(
  claudeHome,
  "plugins/marketplaces/codex-subagents-local/plugins/codex-subagents",
);

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

try {
  const dryRun = spawnSync("node", ["scripts/link-claude-dev-plugin.mjs", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      CLAUDE_HOME: claudeHome,
    },
  });
  const dryRunOutput = [dryRun.stdout, dryRun.stderr].filter(Boolean).join("");
  assert(dryRun.status === 0, "dev link dry run should succeed", dryRunOutput);
  assert(dryRunOutput.includes("Dry run only"), "dry run should be explicit", dryRunOutput);
  assert(!(await pathExists(path.join(claudeHome, "plugins"))), "dry run should not create plugin directories", dryRunOutput);

  for (const pass of [1, 2]) {
    const result = spawnSync("node", ["scripts/link-claude-dev-plugin.mjs"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        CLAUDE_HOME: claudeHome,
      },
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("");
    assert(result.status === 0, `dev link pass ${pass} should succeed`, output);
    assert((await realpath(installPath)) === root, "installed plugin cache should point at repo", {
      installPath,
      output,
    });
    assert((await realpath(marketplacePath)) === root, "marketplace plugin should point at repo", {
      marketplacePath,
      output,
    });
  }

  const installed = JSON.parse(
    await readFile(path.join(claudeHome, "plugins/installed_plugins.json"), "utf8"),
  );
  const entry = installed.plugins["codex-subagents@codex-subagents-local"]?.[0];
  assert(entry?.installPath === installPath, "installed plugin entry should use the cache symlink", entry);
  assert(entry?.gitCommitSha === "dev-symlink", "installed plugin entry should be marked as dev symlink", entry);

  console.log("Claude dev-link test passed");
} finally {
  await rm(claudeHome, { recursive: true, force: true });
}
