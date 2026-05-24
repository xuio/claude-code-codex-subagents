import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run") || process.env.CLAUDE_DEV_LINK_DRY_RUN === "1";
const claudeHome = path.resolve(process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude"));
const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const marketplace = "codex-subagents-local";
const pluginName = manifest.name;
const version = manifest.version;
const backupStamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const installedPluginsPath = path.join(claudeHome, "plugins", "installed_plugins.json");
const backupRoot = path.join(claudeHome, "backups", `codex-subagents-legacy-${backupStamp}`);
const desktopConfigPath =
  process.env.CLAUDE_DESKTOP_CONFIG ??
  path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const marketplacePluginPath = path.join(
  claudeHome,
  "plugins",
  "marketplaces",
  marketplace,
  "plugins",
  pluginName,
);
const installPath = path.join(claudeHome, "plugins", "cache", marketplace, pluginName, version);

function assertSafePath(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved === claudeHome || !resolved.startsWith(`${claudeHome}${path.sep}`)) {
    throw new Error(`Refusing to modify path outside CLAUDE_HOME: ${targetPath}`);
  }
}

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
  return `${targetPath}.backup-${backupStamp}`;
}

async function replaceWithSymlink(linkPath, targetPath) {
  assertSafePath(linkPath);
  const currentTarget = await resolvedPath(linkPath);
  if (currentTarget === targetPath) return { path: linkPath, changed: false };

  if (dryRun) {
    return { path: linkPath, changed: true, dryRun: true };
  }

  await mkdir(path.dirname(linkPath), { recursive: true });
  const tempLink = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  let backup = null;
  if (await pathExists(linkPath)) {
    backup = backupPath(linkPath);
    await rename(linkPath, backup);
    console.log(`Moved existing ${linkPath} to ${backup}`);
  }

  try {
    await symlink(targetPath, tempLink, "dir");
    await rename(tempLink, linkPath);
    return { path: linkPath, changed: true };
  } catch (error) {
    await rm(tempLink, { recursive: true, force: true }).catch(() => {});
    if (backup) await rename(backup, linkPath).catch(() => {});
    throw error;
  }
}

async function ensureInstalledPluginsEntry() {
  assertSafePath(installedPluginsPath);
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
  if (!dryRun) {
    await mkdir(path.dirname(installedPluginsPath), { recursive: true });
    await writeFile(installedPluginsPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  return entry;
}

function legacyBackupName(targetPath) {
  return targetPath
    .slice(claudeHome.length)
    .replace(/^[/\\]+/, "")
    .replace(/[/:\\]+/g, "__");
}

async function moveLegacyPath(targetPath) {
  assertSafePath(targetPath);
  if (!(await pathExists(targetPath))) return false;
  if (dryRun) return true;

  await mkdir(backupRoot, { recursive: true });
  await rename(targetPath, path.join(backupRoot, `${legacyBackupName(targetPath)}.old`));
  return true;
}

async function removeLegacyClaudeDesktopServer() {
  if (!(await pathExists(desktopConfigPath))) return false;

  const data = JSON.parse(await readFile(desktopConfigPath, "utf8"));
  const serverConfig = data.mcpServers?.[pluginName];
  if (!serverConfig) return false;

  const command = typeof serverConfig.command === "string" ? serverConfig.command : "";
  const isLegacyCodexSubagents =
    command === path.join(root, "dist", "index.js") ||
    command.endsWith("/claude-code-codex-subagents/dist/index.js") ||
    command.includes("codex-subagents");
  if (!isLegacyCodexSubagents) return false;

  if (!dryRun) {
    await mkdir(backupRoot, { recursive: true });
    await copyFile(desktopConfigPath, path.join(backupRoot, "claude_desktop_config.json.before"));
    delete data.mcpServers[pluginName];
    await writeFile(desktopConfigPath, `${JSON.stringify(data, null, 2)}\n`);
  }
  return true;
}

async function cleanupLegacyInstallSurfaces() {
  const removed = [];
  for (const targetPath of [
    path.join(claudeHome, "plugins", pluginName),
    path.join(claudeHome, "commands", `${pluginName}.md`),
    path.join(claudeHome, "plugins", "data", `${pluginName}-inline`),
  ]) {
    if (await moveLegacyPath(targetPath)) removed.push(targetPath);
  }
  if (await removeLegacyClaudeDesktopServer()) removed.push(desktopConfigPath);
  return removed;
}

const marketplaceLink = await replaceWithSymlink(marketplacePluginPath, root);
const cacheLink = await replaceWithSymlink(installPath, root);
const entry = await ensureInstalledPluginsEntry();
const removedLegacyPaths = await cleanupLegacyInstallSurfaces();

console.log(`Marketplace plugin path: ${marketplaceLink.path} -> ${root}`);
console.log(`Installed plugin path: ${cacheLink.path} -> ${root}`);
console.log(`Installed plugin entry: ${entry.installPath}`);
if (removedLegacyPaths.length > 0) {
  console.log(`Removed legacy Codex subagents install surfaces: ${removedLegacyPaths.join(", ")}`);
  if (!dryRun) console.log(`Legacy backups: ${backupRoot}`);
}
if (dryRun) console.log("Dry run only; no Claude plugin files were modified.");
console.log("Claude Code CLI and Claude Desktop CLI share this ~/.claude plugin install.");
