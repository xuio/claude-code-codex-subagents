import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-marketplace-package-"));
const pluginRoot = path.join(temporary, "marketplace");
const projectDir = path.join(temporary, "project");
const client = new Client({ name: "marketplace-package", version: "0.1.0" });
let transport;

try {
  // A marketplace download has the committed bundle, not the developer's dependencies.
  for (const name of [".claude-plugin", "dist", "skills", "package.json", "LICENSE"]) {
    await cp(path.join(root, name), path.join(pluginRoot, name), { recursive: true });
  }
  assert.equal(await stat(path.join(pluginRoot, "node_modules")).catch(() => undefined), undefined);
  const marketplace = JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin/marketplace.json"), "utf8"));
  const entry = marketplace.plugins[0];
  const installRoot = path.resolve(pluginRoot, entry.source);
  assert.equal(installRoot, pluginRoot);
  const manifest = JSON.parse(await readFile(path.join(installRoot, ".claude-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(path.join(installRoot, manifest.mcpServers), "utf8"));
  const server = mcp.mcpServers["codex-subagents"];
  assert.equal(server.command, "node");
  assert.equal(manifest.name, entry.name);
  await mkdir(projectDir);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: server.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installRoot)),
    cwd: projectDir,
    env: {
      PATH: process.env.PATH ?? "",
      CODEX_SUBAGENTS_CODEX_BIN: path.join(root, "test/fixtures/fake-codex.mjs"),
      CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(temporary, "sessions.json"),
      CODEX_SUBAGENTS_LOG_LEVEL: "silent",
    },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, manifest.version);
  const { tools } = await client.listTools();
  for (const name of ["codex_task", "codex_task_group", "codex_followup", "codex_wait_any"]) {
    assert(tools.some((tool) => tool.name === name), `Packaged plugin must expose ${name}`);
  }
  const result = await client.callTool({
    name: "codex_task",
    arguments: {
      description: "Marketplace package verification",
      prompt: "Verify the packaged server.",
      project_dir: projectDir,
      advanced: { model: "sol", include_diagnostics: true },
    },
  }, CallToolResultSchema);
  assert.equal(result.structuredContent?.ok, true);
  assert.equal(result.structuredContent?.diagnostics?.model, "gpt-6.1-sol");
  assert.equal(result.structuredContent?.diagnostics?.sandbox, "read-only");
  console.log("Marketplace package works without npm install or node_modules");
} finally {
  await transport?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
