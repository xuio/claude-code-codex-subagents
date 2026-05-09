import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const projectDir = await mkdtemp(path.join(os.tmpdir(), "codex-subagents-smoke-project-"));
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");
const client = new Client({ name: "codex-subagents-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "dist/index.js"),
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
    CLAUDE_PROJECT_DIR: projectDir,
  },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const status = await client.callTool(
    {
      name: "codex_status",
      arguments: {},
    },
    CallToolResultSchema,
  );
  if (!status.structuredContent?.ok) {
    throw new Error(`codex_status failed: ${JSON.stringify(status.structuredContent)}`);
  }

  const guide = await client.callTool(
    {
      name: "codex_usage_guide",
      arguments: {},
    },
    CallToolResultSchema,
  );
  if (!guide.structuredContent?.guide?.includes("Use run_agent for one delegated Codex task.")) {
    throw new Error(`codex_usage_guide failed: ${JSON.stringify(guide.structuredContent)}`);
  }

  const result = await client.callTool(
    {
      name: "run_agents",
      arguments: {
        agents: [
          { name: "alpha", prompt: "alpha DELAY_MS=20", project_dir: projectDir },
          { name: "beta", prompt: "beta DELAY_MS=20", project_dir: projectDir },
        ],
        max_parallel: 2,
      },
    },
    CallToolResultSchema,
  );

  if (!result.structuredContent?.ok) {
    throw new Error(`run_agents failed: ${JSON.stringify(result.structuredContent)}`);
  }

  const agents = result.structuredContent.agents;
  if (!Array.isArray(agents) || agents.length !== 2) {
    throw new Error(`expected two agent results: ${JSON.stringify(result.structuredContent)}`);
  }

  if (!agents.every((agent) => agent.cwd === projectDir && agent.sandbox === "read-only")) {
    throw new Error(`project_dir/read-only defaults not preserved: ${JSON.stringify(agents)}`);
  }

  const nested = await client.callTool(
    {
      name: "run_agent",
      arguments: {
        prompt: "coordinate nested fake work",
        project_dir: projectDir,
        model_preset: "spark",
        codex_subagents: [
          {
            name: "ui_spark",
            description: "Fast focused UI iteration.",
            developer_instructions: "Stay scoped and concise.",
            model_preset: "spark",
            reasoning_effort: "medium",
            sandbox: "read-only",
          },
        ],
        subagent_tasks: [{ agent: "ui_spark", prompt: "Inspect the toolbar." }],
        subagent_runtime: { max_threads: 4, max_depth: 2 },
      },
    },
    CallToolResultSchema,
  );

  const nestedAgent = nested.structuredContent?.agent;
  if (
    !nestedAgent?.ok ||
    nestedAgent.model !== "gpt-5.3-codex-spark" ||
    nestedAgent.codexSubagents?.customAgents?.[0] !== "ui_spark"
  ) {
    throw new Error(`nested subagent smoke failed: ${JSON.stringify(nested.structuredContent)}`);
  }

  console.log("MCP smoke test passed");
} finally {
  await transport.close();
  await rm(projectDir, { recursive: true, force: true });
}
