import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const fakeCodex = path.join(root, "test/fixtures/fake-codex.mjs");

for (const enabled of [[], ["max"], ["ultra"], ["max", "ultra"]]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-flags-"));
  const client = new Client({ name: "reasoning-flags", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      CODEX_SUBAGENTS_CODEX_BIN: fakeCodex,
      CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(dir, "sessions.json"),
      CODEX_SUBAGENTS_LOG_LEVEL: "silent",
      CODEX_SUBAGENTS_ENABLE_LEGACY_TOOLS: "1",
      CODEX_SUBAGENTS_ENABLE_MAX_REASONING: enabled.includes("max") ? "1" : "0",
      CODEX_SUBAGENTS_ENABLE_ULTRA_REASONING: enabled.includes("ultra") ? "1" : "0",
      FAKE_CODEX_RECORD_DIR: dir,
    },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const legacy = tools.find((tool) => tool.name === "run_agent");
    const advertised = legacy.inputSchema.properties.reasoning_effort.enum;
    const usage = await client.readResource({ uri: "codex://usage" });
    const usageText = usage.contents.map((content) => content.text ?? "").join("\n");
    for (const effort of ["max", "ultra"]) {
      const isEnabled = enabled.includes(effort);
      assert.equal(advertised.includes(effort), isEnabled, `${effort} schema visibility`);
      assert.equal(usageText.includes(effort === "max" ? "Max reasoning" : "Ultra reasoning"), isEnabled);
      const callsBefore = await readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "");
      const result = await client.callTool({
        name: "codex_task",
        arguments: {
          description: `Hidden reasoning ${effort}`,
          prompt: "Check reasoning settings.",
          project_dir: dir,
          advanced: { model: "astra", reasoning: effort, include_diagnostics: true },
        },
      }, CallToolResultSchema);
      assert.equal(Boolean(result.isError), !isEnabled, `${effort} native request gate`);
      const callsAfter = await readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "");
      if (isEnabled) {
        assert.equal(result.structuredContent.diagnostics.reasoning_effort, effort);
        const calls = callsAfter.trim().split("\n").map((line) => JSON.parse(line));
        assert(calls.some((call) => call.method === "turn/start" && call.effort === effort));
      } else {
        assert.equal(callsAfter, callsBefore, "Disabled reasoning must not spawn Codex");
      }
    }
    if (enabled.includes("ultra")) {
      const rejected = await client.callTool({
        name: "codex_task",
        arguments: {
          description: "Luna Ultra validation",
          prompt: "Should not start.",
          project_dir: dir,
          advanced: { model: "luna", reasoning: "ultra" },
        },
      }, CallToolResultSchema);
      assert(rejected.isError);
      assert(rejected.content.some((content) => content.text?.includes("not supported by gpt-6-luna")));
    }
  } finally {
    await transport.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("Hidden reasoning flag checks passed");
