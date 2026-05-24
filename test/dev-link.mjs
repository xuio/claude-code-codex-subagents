import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
const desktopConfigPath = path.join(claudeHome, "Claude", "claude_desktop_config.json");
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
      CLAUDE_DESKTOP_CONFIG: desktopConfigPath,
    },
  });
  const dryRunOutput = [dryRun.stdout, dryRun.stderr].filter(Boolean).join("");
  assert(dryRun.status === 0, "dev link dry run should succeed", dryRunOutput);
  assert(dryRunOutput.includes("Dry run only"), "dry run should be explicit", dryRunOutput);
  assert(!(await pathExists(path.join(claudeHome, "plugins"))), "dry run should not create plugin directories", dryRunOutput);

  await mkdir(path.dirname(desktopConfigPath), { recursive: true });
  await writeFile(
    desktopConfigPath,
    `${JSON.stringify({
      mcpServers: {
        "codex-subagents": {
          command: path.join(root, "dist", "index.js"),
          args: [],
          env: {},
        },
        unrelated: { command: "/bin/echo" },
      },
    }, null, 2)}\n`,
  );
  await mkdir(path.join(claudeHome, "plugins", "data", "codex-subagents-inline"), { recursive: true });
  await mkdir(path.join(claudeHome, "commands"), { recursive: true });
  await writeFile(path.join(claudeHome, "commands", "codex-subagents.md"), "legacy command\n");

  for (const pass of [1, 2]) {
    const result = spawnSync("node", ["scripts/link-claude-dev-plugin.mjs"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        CLAUDE_HOME: claudeHome,
        CLAUDE_DESKTOP_CONFIG: desktopConfigPath,
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
    if (pass === 1) {
      assert(output.includes("Removed legacy Codex subagents install surfaces"), "legacy cleanup should be reported", output);
    }
  }

  const installed = JSON.parse(
    await readFile(path.join(claudeHome, "plugins/installed_plugins.json"), "utf8"),
  );
  const entry = installed.plugins["codex-subagents@codex-subagents-local"]?.[0];
  assert(entry?.installPath === installPath, "installed plugin entry should use the cache symlink", entry);
  assert(entry?.gitCommitSha === "dev-symlink", "installed plugin entry should be marked as dev symlink", entry);

  const desktopConfig = JSON.parse(await readFile(desktopConfigPath, "utf8"));
  assert(!desktopConfig.mcpServers["codex-subagents"], "direct Claude Desktop MCP server should be removed", desktopConfig);
  assert(desktopConfig.mcpServers.unrelated, "unrelated Claude Desktop MCP servers should be preserved", desktopConfig);
  assert(!(await pathExists(path.join(claudeHome, "commands", "codex-subagents.md"))), "legacy command should be moved out of active Claude paths");
  assert(
    !(await pathExists(path.join(claudeHome, "plugins", "data", "codex-subagents-inline"))),
    "legacy inline plugin data should be moved out of active Claude paths",
  );

  console.log("Claude dev-link test passed");
} finally {
  await rm(claudeHome, { recursive: true, force: true });
}
