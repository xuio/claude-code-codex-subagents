import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const modelPresets = ["default", "codex", "spark"] as const;
export type ModelPreset = (typeof modelPresets)[number];

export interface CodexSubagentDefinition {
  name: string;
  description: string;
  developerInstructions: string;
  nicknameCandidates?: string[];
  model?: string;
  modelPreset?: ModelPreset;
  reasoningEffort?: string;
  sandbox?: string;
  mcpServers?: Record<string, unknown>;
  skillsConfig?: Record<string, unknown>;
  extraConfig?: Record<string, unknown>;
}

export interface SubagentTask {
  agent: string;
  prompt: string;
  name?: string;
}

export interface SubagentRuntimeOptions {
  maxThreads?: number;
  maxDepth?: number;
  jobMaxRuntimeSeconds?: number;
}

export interface PreparedSubagents {
  env: NodeJS.ProcessEnv;
  tempCodexHome?: string;
  names: string[];
  promptPrefix: string;
  cleanup: () => Promise<void>;
}

export function modelForPreset(preset?: ModelPreset): string | undefined {
  switch (preset) {
    case "codex":
      return "gpt-5.3-codex";
    case "spark":
      return "gpt-5.3-codex-spark";
    default:
      return undefined;
  }
}

function sanitizeAgentFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialize non-finite number to TOML`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value === null || value === undefined) {
    throw new Error("Cannot serialize null or undefined values to TOML");
  }
  throw new Error(`Unsupported TOML scalar value: ${JSON.stringify(value)}`);
}

function appendTomlTable(lines: string[], table: string, values: Record<string, unknown>): void {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return;

  lines.push("", `[${table}]`);
  for (const [key, value] of entries) {
    if (Array.isArray(value) || typeof value !== "object") {
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
      continue;
    }
    if (value === null) continue;
    appendTomlTable(lines, `${table}.${tomlKey(key)}`, value as Record<string, unknown>);
  }
}

export function serializeCodexSubagent(definition: CodexSubagentDefinition): string {
  const lines = [
    `name = ${tomlValue(definition.name)}`,
    `description = ${tomlValue(definition.description)}`,
    `developer_instructions = ${tomlValue(definition.developerInstructions)}`,
  ];

  if (definition.nicknameCandidates?.length) {
    lines.push(`nickname_candidates = ${tomlValue(definition.nicknameCandidates)}`);
  }

  const model = definition.model?.trim() || modelForPreset(definition.modelPreset);
  if (model) lines.push(`model = ${tomlValue(model)}`);
  if (definition.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlValue(definition.reasoningEffort)}`);
  }
  if (definition.sandbox) lines.push(`sandbox_mode = ${tomlValue(definition.sandbox)}`);

  for (const [key, value] of Object.entries(definition.extraConfig ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) || typeof value !== "object") {
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
  }

  appendTomlTable(lines, "mcp_servers", definition.mcpServers ?? {});
  appendTomlTable(lines, "skills.config", definition.skillsConfig ?? {});

  for (const [key, value] of Object.entries(definition.extraConfig ?? {})) {
    if (value && !Array.isArray(value) && typeof value === "object") {
      appendTomlTable(lines, tomlKey(key), value as Record<string, unknown>);
    }
  }

  return `${lines.join("\n")}\n`;
}

function tomlPathSegment(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function appendConfigOverride(
  overrides: string[],
  pathPrefix: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value) || typeof value !== "object") {
    overrides.push(`${pathPrefix}=${tomlValue(value)}`);
    return;
  }

  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    appendConfigOverride(overrides, `${pathPrefix}.${tomlPathSegment(key)}`, childValue);
  }
}

export function codexSubagentConfigOverrides(
  definitions: CodexSubagentDefinition[] = [],
): string[] {
  const overrides: string[] = [];

  for (const definition of definitions) {
    const prefix = `agents.${tomlPathSegment(definition.name)}`;
    appendConfigOverride(overrides, `${prefix}.description`, definition.description);
    appendConfigOverride(
      overrides,
      `${prefix}.developer_instructions`,
      definition.developerInstructions,
    );
    appendConfigOverride(overrides, `${prefix}.nickname_candidates`, definition.nicknameCandidates);

    const model = definition.model?.trim() || modelForPreset(definition.modelPreset);
    appendConfigOverride(overrides, `${prefix}.model`, model);
    appendConfigOverride(
      overrides,
      `${prefix}.model_reasoning_effort`,
      definition.reasoningEffort,
    );
    appendConfigOverride(overrides, `${prefix}.sandbox_mode`, definition.sandbox);
    appendConfigOverride(overrides, `${prefix}.mcp_servers`, definition.mcpServers);
    appendConfigOverride(overrides, `${prefix}.skills.config`, definition.skillsConfig);

    for (const [key, value] of Object.entries(definition.extraConfig ?? {})) {
      appendConfigOverride(overrides, `${prefix}.${tomlPathSegment(key)}`, value);
    }
  }

  return overrides;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function linkIfPresent(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return;
  await symlink(source, destination);
}

async function prepareTempCodexHome(
  definitions: CodexSubagentDefinition[],
  env: NodeJS.ProcessEnv,
  options: { isolated?: boolean } = {},
): Promise<string> {
  const realCodexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const tempCodexHome = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-home-"));

  const links = [
    linkIfPresent(path.join(realCodexHome, "auth.json"), path.join(tempCodexHome, "auth.json")),
    linkIfPresent(path.join(realCodexHome, "AGENTS.md"), path.join(tempCodexHome, "AGENTS.md")),
    linkIfPresent(path.join(realCodexHome, "skills"), path.join(tempCodexHome, "skills")),
    linkIfPresent(path.join(realCodexHome, "rules"), path.join(tempCodexHome, "rules")),
    linkIfPresent(path.join(realCodexHome, "plugins"), path.join(tempCodexHome, "plugins")),
  ];

  if (options.isolated) {
    links.push(writeFile(path.join(tempCodexHome, "config.toml"), "# isolated codex-subagents run\n"));
  } else {
    links.push(linkIfPresent(path.join(realCodexHome, "config.toml"), path.join(tempCodexHome, "config.toml")));
  }

  await Promise.all(links);

  const agentsDir = path.join(tempCodexHome, "agents");
  await mkdir(agentsDir, { recursive: true });

  await Promise.all(
    definitions.map(async (definition, index) => {
      const fileName = `${String(index + 1).padStart(2, "0")}-${sanitizeAgentFileName(
        definition.name,
      )}.toml`;
      await writeFile(path.join(agentsDir, fileName), serializeCodexSubagent(definition), "utf8");
    }),
  );

  return tempCodexHome;
}

export function buildSubagentPromptPrefix(
  definitions: CodexSubagentDefinition[],
  tasks: SubagentTask[] = [],
): string {
  if (definitions.length === 0 && tasks.length === 0) return "";

  const lines = [
    "Codex subagent configuration for this run:",
    definitions.length
      ? `Custom agents available: ${definitions.map((definition) => definition.name).join(", ")}.`
      : "No custom agents were defined; use built-in Codex agents only.",
  ];

  for (const definition of definitions) {
    const model = definition.model?.trim() || modelForPreset(definition.modelPreset) || "inherited";
    lines.push(
      `- ${definition.name}: ${definition.description} (model: ${model}, reasoning: ${
        definition.reasoningEffort ?? "inherited"
      }, sandbox: ${definition.sandbox ?? "inherited"})`,
    );
  }

  if (tasks.length > 0) {
    lines.push(
      "",
      "You must spawn the following Codex subagents, wait for all of them, and consolidate their results:",
    );
    for (const task of tasks) {
      lines.push(`- Spawn ${task.agent}${task.name ? ` as ${task.name}` : ""}: ${task.prompt}`);
    }
  } else if (definitions.length > 0) {
    lines.push(
      "",
      "Use these custom Codex subagents when the task calls for delegation. Spawn them explicitly, wait for results, and summarize each result.",
    );
  }

  return `${lines.join("\n")}\n\n`;
}

export async function prepareSubagents(options: {
  definitions?: CodexSubagentDefinition[];
  tasks?: SubagentTask[];
  env?: NodeJS.ProcessEnv;
  isolatedCodexHome?: boolean;
}): Promise<PreparedSubagents> {
  const definitions = options.definitions ?? [];
  const tasks = options.tasks ?? [];
  const env = { ...(options.env ?? {}) };
  let tempCodexHome: string | undefined;

  if (definitions.length > 0 || options.isolatedCodexHome) {
    tempCodexHome = await prepareTempCodexHome(definitions, { ...process.env, ...env }, {
      isolated: options.isolatedCodexHome,
    });
    env.CODEX_HOME = tempCodexHome;
  }

  return {
    env,
    tempCodexHome,
    names: definitions.map((definition) => definition.name),
    promptPrefix: buildSubagentPromptPrefix(definitions, tasks),
    cleanup: async () => {
      if (tempCodexHome) await rm(tempCodexHome, { recursive: true, force: true });
    },
  };
}

export async function readPreparedAgentFiles(tempCodexHome: string): Promise<Record<string, string>> {
  const agentsDir = path.join(tempCodexHome, "agents");
  const entries = await readdirSafe(agentsDir);
  const result: Record<string, string> = {};
  await Promise.all(
    entries.map(async (entry) => {
      result[entry] = await readFile(path.join(agentsDir, entry), "utf8");
    }),
  );
  return result;
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return readdir(directory);
  } catch {
    return [];
  }
}
