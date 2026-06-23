import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type PluginInstallDiagnostics = {
  entrypoint?: string;
  pluginRoot?: string;
  pluginRootRealpath?: string;
  pluginRootIsSymlink?: boolean;
  installedEntry?: {
    key: string;
    installPath: string;
    version?: string;
    gitCommitSha?: string;
  };
  marketplacePath?: string;
  marketplaceRealpath?: string;
  devSymlinkExpected: boolean;
  staleDevInstall: boolean;
  inUseMarkers: Array<{ pid?: number; alive?: boolean; path: string }>;
  warning?: string;
  error?: string;
};

type InstalledPluginEntry = {
  installPath?: string;
  version?: string;
  gitCommitSha?: string;
};

function safeRealpath(targetPath: string | undefined): string | undefined {
  if (!targetPath) return undefined;
  try {
    return realpathSync(targetPath);
  } catch {
    return undefined;
  }
}

function safeLstat(targetPath: string | undefined): ReturnType<typeof lstatSync> | undefined {
  if (!targetPath) return undefined;
  try {
    return lstatSync(targetPath);
  } catch {
    return undefined;
  }
}

function pluginRootFromEntrypoint(entrypoint: string | undefined): string | undefined {
  if (!entrypoint) return undefined;
  const resolved = path.resolve(entrypoint);
  const dir = path.dirname(resolved);
  return path.basename(dir) === "dist" ? path.dirname(dir) : dir;
}

function processAlive(pid: number | undefined): boolean | undefined {
  if (!pid || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" ? true : false;
  }
}

function inUseMarkers(pluginRoot: string | undefined): Array<{ pid?: number; alive?: boolean; path: string }> {
  if (!pluginRoot) return [];
  const markerDir = path.join(pluginRoot, ".in_use");
  try {
    return readdirSync(markerDir).map((name) => {
      const markerPath = path.join(markerDir, name);
      let pid = Number(name);
      try {
        const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { pid?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
      } catch {
        // Marker filename is enough for stale/live diagnostics.
      }
      return { pid: Number.isFinite(pid) ? pid : undefined, alive: processAlive(pid), path: markerPath };
    });
  } catch {
    return [];
  }
}

function readInstalledEntry(
  claudeHome: string,
  pluginRoot: string | undefined,
): PluginInstallDiagnostics["installedEntry"] | undefined {
  let data: { plugins?: Record<string, InstalledPluginEntry[]> };
  try {
    data = JSON.parse(readFileSync(path.join(claudeHome, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return undefined;
  }

  const pluginRootRealpath = safeRealpath(pluginRoot);
  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    if (!key.startsWith("codex-subagents@")) continue;
    for (const entry of entries) {
      if (!entry.installPath) continue;
      const installRealpath = safeRealpath(entry.installPath);
      if (entry.installPath === pluginRoot || installRealpath === pluginRootRealpath) {
        return {
          key,
          installPath: entry.installPath,
          version: entry.version,
          gitCommitSha: entry.gitCommitSha,
        };
      }
    }
  }
  return undefined;
}

export function pluginInstallDiagnostics(options: {
  entrypoint?: string;
  claudeHome?: string;
} = {}): PluginInstallDiagnostics {
  try {
    const entrypoint = options.entrypoint ?? process.argv[1];
    const claudeHome = path.resolve(options.claudeHome ?? path.join(os.homedir(), ".claude"));
    const pluginRoot = pluginRootFromEntrypoint(entrypoint);
    const pluginRootRealpath = safeRealpath(pluginRoot);
    const pluginRootStat = safeLstat(pluginRoot);
    const installedEntry = readInstalledEntry(claudeHome, pluginRoot);
    const marketplacePath = installedEntry?.key.includes("@codex-subagents-local")
      ? path.join(claudeHome, "plugins", "marketplaces", "codex-subagents-local", "plugins", "codex-subagents")
      : undefined;
    const marketplaceRealpath = safeRealpath(marketplacePath);
    const devSymlinkExpected = installedEntry?.gitCommitSha === "dev-symlink";
    const staleDevInstall = Boolean(
      devSymlinkExpected &&
        installedEntry?.installPath &&
        marketplaceRealpath &&
        safeRealpath(installedEntry.installPath) !== marketplaceRealpath,
    );
    return {
      entrypoint,
      pluginRoot,
      pluginRootRealpath,
      pluginRootIsSymlink: pluginRootStat?.isSymbolicLink(),
      installedEntry,
      marketplacePath,
      marketplaceRealpath,
      devSymlinkExpected,
      staleDevInstall,
      inUseMarkers: inUseMarkers(pluginRoot),
      warning: staleDevInstall
        ? "Claude is running a copied codex-subagents dev install instead of the repository symlink. Run npm run dev:link after active sessions close."
        : undefined,
    };
  } catch (error) {
    return {
      devSymlinkExpected: false,
      staleDevInstall: false,
      inUseMarkers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
