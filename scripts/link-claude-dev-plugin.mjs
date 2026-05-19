import { lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claudeHome = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");
const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const marketplace = "codex-subagents-local";
const pluginName = manifest.name;
const version = manifest.version;
const installedPluginsPath = path.join(claudeHome, "plugins", "installed_plugins.json");
const marketplacePluginPath = path.join(
  claudeHome,
  "plugins",
  "marketplaces",
  marketplace,
  "plugins",
  pluginName,
);
const installPath = path.join(claudeHome, "plugins", "cache", marketplace, pluginName, version);

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function resolvedPath(targetPath) {
  try {
    return await realpath(targetPath);
  } catch {
    return null;
  }
}

function backupPath(targetPath) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${targetPath}.backup-${stamp}`;
}

async function replaceWithSymlink(linkPath, targetPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  const currentTarget = await resolvedPath(linkPath);
  if (currentTarget === targetPath) return { path: linkPath, changed: false };

  if (await pathExists(linkPath)) {
    const backup = backupPath(linkPath);
    await rename(linkPath, backup);
    console.log(`Moved existing ${linkPath} to ${backup}`);
  }

  await symlink(targetPath, linkPath, "dir");
  return { path: linkPath, changed: true };
}

async function ensureInstalledPluginsEntry() {
  await mkdir(path.dirname(installedPluginsPath), { recursive: true });
  let data = { version: 2, plugins: {} };
  if (await pathExists(installedPluginsPath)) {
    data = JSON.parse(await readFile(installedPluginsPath, "utf8"));
  }

  data.version = data.version ?? 2;
  data.plugins = data.plugins ?? {};

  const key = `${pluginName}@${marketplace}`;
  const entries = Array.isArray(data.plugins[key]) ? data.plugins[key] : [];
  const existing = entries.find((entry) => entry.scope === "user" && entry.version === version);
  const now = new Date().toISOString();
  const entry = {
    scope: "user",
    installPath,
    version,
    installedAt: existing?.installedAt ?? now,
    lastUpdated: now,
    gitCommitSha: "dev-symlink",
  };

  data.plugins[key] = [entry, ...entries.filter((candidate) => candidate !== existing)];
  await writeFile(installedPluginsPath, `${JSON.stringify(data, null, 2)}\n`);
  return entry;
}

const marketplaceLink = await replaceWithSymlink(marketplacePluginPath, root);
const cacheLink = await replaceWithSymlink(installPath, root);
const entry = await ensureInstalledPluginsEntry();

console.log(`Marketplace plugin path: ${marketplaceLink.path} -> ${root}`);
console.log(`Installed plugin path: ${cacheLink.path} -> ${root}`);
console.log(`Installed plugin entry: ${entry.installPath}`);
console.log("Claude Code CLI and Claude Desktop CLI share this ~/.claude plugin install.");
