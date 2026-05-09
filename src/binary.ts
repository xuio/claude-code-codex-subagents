import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexBinarySource =
  | "explicit"
  | "plugin-config"
  | "desktop-app"
  | "CODEX_BIN"
  | "PATH";

export interface ResolvedCodexBinary {
  path: string;
  source: CodexBinarySource;
}

export interface ResolveCodexBinaryOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  existsExecutable?: (candidate: string) => boolean;
}

export function cleanOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("${")) return undefined;
  return trimmed;
}

export function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function desktopCodexCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string[] {
  if (platform !== "darwin") return [];

  const candidates: string[] = [];
  const appOverride = cleanOption(env.CODEX_DESKTOP_APP_PATH);
  if (appOverride) {
    candidates.push(
      appOverride.endsWith(".app")
        ? path.join(appOverride, "Contents", "Resources", "codex")
        : appOverride,
    );
  }

  candidates.push(
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(homedir, "Applications", "Codex.app", "Contents", "Resources", "codex"),
  );

  return candidates;
}

export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  existsExecutable: (candidate: string) => boolean = isExecutable,
): string | undefined {
  const pathEnv = env.PATH;
  if (!pathEnv) return undefined;

  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

export function resolveCodexBinary(
  options: ResolveCodexBinaryOptions = {},
): ResolvedCodexBinary {
  const env = options.env ?? process.env;
  const exists = options.existsExecutable ?? isExecutable;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();

  const explicit = cleanOption(options.explicitPath);
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`Configured Codex binary is not executable: ${explicit}`);
    }
    return { path: explicit, source: "explicit" };
  }

  const pluginConfigured = cleanOption(env.CODEX_SUBAGENTS_CODEX_BIN);
  if (pluginConfigured) {
    if (!exists(pluginConfigured)) {
      throw new Error(
        `CODEX_SUBAGENTS_CODEX_BIN is set but is not executable: ${pluginConfigured}`,
      );
    }
    return { path: pluginConfigured, source: "plugin-config" };
  }

  for (const candidate of desktopCodexCandidates(env, platform, homedir)) {
    if (exists(candidate)) return { path: candidate, source: "desktop-app" };
  }

  const envConfigured = cleanOption(env.CODEX_BIN);
  if (envConfigured) {
    if (!exists(envConfigured)) {
      throw new Error(`CODEX_BIN is set but is not executable: ${envConfigured}`);
    }
    return { path: envConfigured, source: "CODEX_BIN" };
  }

  const fromPath = findOnPath("codex", env, exists);
  if (fromPath) return { path: fromPath, source: "PATH" };

  throw new Error(
    "Could not find a Codex CLI binary. Install the Codex desktop app, install `codex` on PATH, or set CODEX_SUBAGENTS_CODEX_BIN.",
  );
}
