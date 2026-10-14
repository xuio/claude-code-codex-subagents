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
  it("maps current model presets", () => {
    expect(modelForPreset("sol")).toBe("gpt-6.1-sol");
    expect(modelForPreset("codex")).toBe("gpt-6.1-sol");
    expect(modelForPreset("astra")).toBe("gpt-6-astra");
    expect(modelForPreset("luna")).toBe("gpt-6-luna");
    expect(modelForPreset("default")).toBeUndefined();
    expect(modelForPreset()).toBeUndefined();
  });

  it("resolves exact-model aliases consistently in nested TOML and argv", () => {
    const definition = {
      name: "review",
      description: "Review code.",
      developerInstructions: "Return findings.",
      model: " astra ",
      modelPreset: "luna" as const,
      reasoningEffort: "max",
    };
    expect(serializeCodexSubagent(definition)).toContain('model = "gpt-6-astra"');
    expect(codexSubagentConfigOverrides([definition])).toContain('agents.review.model="gpt-6-astra"');
  });

  it("serializes complete custom agent definitions as Codex TOML", () => {
    const toml = serializeCodexSubagent({
      name: "ui_sol",
      description: "Fast focused UI iteration.",
      developerInstructions: "Stay scoped and return concise diffs.",
      nicknameCandidates: ["Sol One", "Sol Two"],
      modelPreset: "sol",
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

    expect(toml).toContain('name = "ui_sol"');
    expect(toml).toContain('model = "gpt-6.1-sol"');
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
        name: "ui_sol",
        description: "Fast focused UI iteration.",
        developerInstructions: "Stay scoped and return concise diffs.",
        nicknameCandidates: ["Sol One", "Sol Two"],
        modelPreset: "sol",
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

    expect(overrides).toContain('agents.ui_sol.description="Fast focused UI iteration."');
    expect(overrides).toContain(
      'agents.ui_sol.developer_instructions="Stay scoped and return concise diffs."',
    );
    expect(overrides).toContain('agents.ui_sol.model="gpt-6.1-sol"');
    expect(overrides).toContain('agents.ui_sol.model_reasoning_effort="medium"');
    expect(overrides).toContain('agents.ui_sol.sandbox_mode="read-only"');
    expect(overrides.join("\n")).not.toContain("mcp_servers");
    expect(overrides.join("\n")).not.toContain("skills.config");
    expect(overrides.join("\n")).not.toContain("model_verbosity");
    expect(overrides.join("\n")).not.toContain("raw-nested-secret-canary");
  });

  it("builds prompt instructions for requested subagent tasks", () => {
    const prompt = buildSubagentPromptPrefix(
      [
        {
          name: "ui_sol",
          description: "Fast focused UI iteration.",
          developerInstructions: "Stay scoped.",
          modelPreset: "sol",
        },
      ],
      [{ agent: "ui_sol", name: "header", prompt: "Inspect the header UI." }],
    );

    expect(prompt).toContain("Custom agents available: ui_sol");
    expect(prompt).toContain("Spawn ui_sol as header: Inspect the header UI.");
  });

  it("creates and cleans a temporary Codex home for custom agents", async () => {
    const codexHome = await tempDir("codex-subagents-real-home-");
    const prepared = await prepareSubagents({
      definitions: [
        {
          name: "review_sol",
          description: "Fast review.",
          developerInstructions: "Review only.",
          modelPreset: "sol",
        },
      ],
      env: { CODEX_HOME: codexHome },
    });

    expect(prepared.tempCodexHome).toBeTruthy();
    expect(prepared.env.CODEX_HOME).toBe(prepared.tempCodexHome);
    const files = await readFile(
      path.join(prepared.tempCodexHome!, "agents", "01-review_sol.toml"),
      "utf8",
    );
    expect(files).toContain('model = "gpt-6.1-sol"');

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
