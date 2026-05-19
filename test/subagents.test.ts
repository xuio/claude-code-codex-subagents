import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSubagentPromptPrefix,
  codexSubagentConfigOverrides,
  modelForPreset,
  prepareSubagents,
  serializeCodexSubagent,
} from "../src/subagents.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Codex subagent helpers", () => {
  it("maps the spark preset to the Codex Spark model", () => {
    expect(modelForPreset("spark")).toBe("gpt-5.3-codex-spark");
    expect(modelForPreset("codex")).toBe("gpt-5.3-codex");
  });

  it("serializes complete custom agent definitions as Codex TOML", () => {
    const toml = serializeCodexSubagent({
      name: "ui_spark",
      description: "Fast focused UI iteration.",
      developerInstructions: "Stay scoped and return concise diffs.",
      nicknameCandidates: ["Spark One", "Spark Two"],
      modelPreset: "spark",
      reasoningEffort: "medium",
      sandbox: "read-only",
      mcpServers: {
        docs: {
          url: "https://developers.openai.com/mcp",
        },
      },
      skillsConfig: {
        playwright: {
          enabled: true,
        },
      },
      extraConfig: {
        model_verbosity: "low",
      },
    });

    expect(toml).toContain('name = "ui_spark"');
    expect(toml).toContain('model = "gpt-5.3-codex-spark"');
    expect(toml).toContain('model_reasoning_effort = "medium"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain("[mcp_servers.docs]");
    expect(toml).toContain('url = "https://developers.openai.com/mcp"');
    expect(toml).toContain("[skills.config.playwright]");
    expect(toml).toContain("enabled = true");
    expect(toml).toContain('model_verbosity = "low"');
  });

  it("keeps secret-bearing nested subagent config out of Codex argv overrides", () => {
    const overrides = codexSubagentConfigOverrides([
      {
        name: "ui_spark",
        description: "Fast focused UI iteration.",
        developerInstructions: "Stay scoped and return concise diffs.",
        nicknameCandidates: ["Spark One", "Spark Two"],
        modelPreset: "spark",
        reasoningEffort: "medium",
        sandbox: "read-only",
        mcpServers: {
          docs: {
            command: "node",
            args: ["server.mjs"],
            env: {
              API_KEY: "raw-nested-secret-canary",
            },
          },
        },
        skillsConfig: {
          playwright: {
            enabled: true,
          },
        },
        extraConfig: {
          model_verbosity: "low",
        },
      },
    ]);

    expect(overrides).toContain('agents.ui_spark.description="Fast focused UI iteration."');
    expect(overrides).toContain(
      'agents.ui_spark.developer_instructions="Stay scoped and return concise diffs."',
    );
    expect(overrides).toContain('agents.ui_spark.model="gpt-5.3-codex-spark"');
    expect(overrides).toContain('agents.ui_spark.model_reasoning_effort="medium"');
    expect(overrides).toContain('agents.ui_spark.sandbox_mode="read-only"');
    expect(overrides.join("\n")).not.toContain("mcp_servers");
    expect(overrides.join("\n")).not.toContain("skills.config");
    expect(overrides.join("\n")).not.toContain("model_verbosity");
    expect(overrides.join("\n")).not.toContain("raw-nested-secret-canary");
  });

  it("builds prompt instructions for requested subagent tasks", () => {
    const prompt = buildSubagentPromptPrefix(
      [
        {
          name: "ui_spark",
          description: "Fast focused UI iteration.",
          developerInstructions: "Stay scoped.",
          modelPreset: "spark",
        },
      ],
      [{ agent: "ui_spark", name: "header", prompt: "Inspect the header UI." }],
    );

    expect(prompt).toContain("Custom agents available: ui_spark");
    expect(prompt).toContain("Spawn ui_spark as header: Inspect the header UI.");
  });

  it("creates and cleans a temporary Codex home for custom agents", async () => {
    const codexHome = await tempDir("codex-subagents-real-home-");
    const prepared = await prepareSubagents({
      definitions: [
        {
          name: "review_spark",
          description: "Fast review.",
          developerInstructions: "Review only.",
          modelPreset: "spark",
        },
      ],
      env: { CODEX_HOME: codexHome },
    });

    expect(prepared.tempCodexHome).toBeTruthy();
    expect(prepared.env.CODEX_HOME).toBe(prepared.tempCodexHome);
    const files = await readFile(
      path.join(prepared.tempCodexHome!, "agents", "01-review_spark.toml"),
      "utf8",
    );
    expect(files).toContain('model = "gpt-5.3-codex-spark"');

    await prepared.cleanup();
    await expect(stat(prepared.tempCodexHome!)).rejects.toThrow();
  });

  it("requires parent full-access approval before preparing danger-full-access subagents", async () => {
    const definition = {
      name: "unsafe",
      description: "Needs unrestricted access.",
      developerInstructions: "Run local commands.",
      sandbox: "danger-full-access",
    };

    await expect(prepareSubagents({ definitions: [definition] })).rejects.toThrow(
      /without the parent full-access bypass flag/,
    );

    const prepared = await prepareSubagents({
      definitions: [definition],
      allowDangerFullAccess: true,
    });
    expect(prepared.tempCodexHome).toBeTruthy();
    await prepared.cleanup();
  });
});
