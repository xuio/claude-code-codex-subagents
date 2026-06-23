import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginInstallDiagnostics } from "../src/install-diagnostics.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin install diagnostics", () => {
  it("flags dev-symlink installs that drifted into copied cache directories", async () => {
    const claudeHome = await tempDir("codex-subagents-claude-home-");
    const repo = await tempDir("codex-subagents-repo-");
    const installPath = path.join(claudeHome, "plugins/cache/codex-subagents-local/codex-subagents/0.3.0");
    const marketplacePath = path.join(claudeHome, "plugins/marketplaces/codex-subagents-local/plugins/codex-subagents");

    await mkdir(path.join(installPath, "dist"), { recursive: true });
    await mkdir(path.dirname(marketplacePath), { recursive: true });
    await symlink(repo, marketplacePath, "dir");
    await writeFile(path.join(installPath, "dist/index.js"), "");
    await mkdir(path.join(installPath, ".in_use"), { recursive: true });
    await writeFile(path.join(installPath, ".in_use", String(process.pid)), JSON.stringify({ pid: process.pid }));
    await mkdir(path.join(claudeHome, "plugins"), { recursive: true });
    await writeFile(
      path.join(claudeHome, "plugins/installed_plugins.json"),
      `${JSON.stringify({
        version: 2,
        plugins: {
          "codex-subagents@codex-subagents-local": [
            {
              scope: "user",
              installPath,
              version: "0.3.0",
              gitCommitSha: "dev-symlink",
            },
          ],
        },
      })}\n`,
    );

    const diagnostics = pluginInstallDiagnostics({
      entrypoint: path.join(installPath, "dist/index.js"),
      claudeHome,
    });

    expect(diagnostics.devSymlinkExpected).toBe(true);
    expect(diagnostics.staleDevInstall).toBe(true);
    expect(diagnostics.marketplaceRealpath).toBe(repo);
    expect(diagnostics.pluginRootRealpath).toBe(installPath);
    expect(diagnostics.inUseMarkers).toEqual([
      expect.objectContaining({ pid: process.pid, alive: true }),
    ]);
    expect(diagnostics.warning).toContain("copied codex-subagents dev install");
  });

  it("accepts cache paths that resolve to the marketplace repo symlink", async () => {
    const claudeHome = await tempDir("codex-subagents-claude-home-");
    const repo = await tempDir("codex-subagents-repo-");
    const installPath = path.join(claudeHome, "plugins/cache/codex-subagents-local/codex-subagents/0.3.0");
    const marketplacePath = path.join(claudeHome, "plugins/marketplaces/codex-subagents-local/plugins/codex-subagents");

    await mkdir(path.dirname(installPath), { recursive: true });
    await mkdir(path.dirname(marketplacePath), { recursive: true });
    await symlink(repo, installPath, "dir");
    await symlink(repo, marketplacePath, "dir");
    await mkdir(path.join(claudeHome, "plugins"), { recursive: true });
    await writeFile(
      path.join(claudeHome, "plugins/installed_plugins.json"),
      `${JSON.stringify({
        version: 2,
        plugins: {
          "codex-subagents@codex-subagents-local": [
            {
              scope: "user",
              installPath,
              version: "0.3.0",
              gitCommitSha: "dev-symlink",
            },
          ],
        },
      })}\n`,
    );

    const diagnostics = pluginInstallDiagnostics({
      entrypoint: path.join(installPath, "dist/index.js"),
      claudeHome,
    });

    expect(diagnostics.devSymlinkExpected).toBe(true);
    expect(diagnostics.staleDevInstall).toBe(false);
    expect(diagnostics.pluginRootRealpath).toBe(repo);
    expect(diagnostics.warning).toBeUndefined();
  });
});
