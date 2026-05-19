import { access, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details ? `\n${JSON.stringify(details, null, 2)}` : ""}`);
  }
}

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(root, ".claude-plugin/mcp.json"), "utf8"));

assert(manifest.name === "codex-subagents", "plugin manifest name should stay stable", manifest);
assert(manifest.version === packageJson.version, "plugin manifest version must match package.json", {
  manifest: manifest.version,
  package: packageJson.version,
});
assert(manifest.mcpServers === "./.claude-plugin/mcp.json", "plugin manifest should point at the MCP config", manifest);
assert(manifest.skills === "./skills", "plugin manifest should point at the skills directory", manifest);

const server = mcp.mcpServers?.["codex-subagents"];
assert(server?.command === "${CLAUDE_PLUGIN_ROOT}/dist/index.js", "MCP command should use CLAUDE_PLUGIN_ROOT dist entry", mcp);

const distPath = path.join(root, "dist/index.js");
await access(distPath);
const distStat = await stat(distPath);
assert(distStat.isFile(), "dist/index.js should be a file");
assert((distStat.mode & 0o111) !== 0, "dist/index.js should be executable");

const skillsStat = await stat(path.join(root, "skills"));
assert(skillsStat.isDirectory(), "skills directory should exist");
await access(path.join(root, "skills/codex-subagents/SKILL.md"));

const pluginRootStat = await lstat(path.join(root, ".claude-plugin"));
assert(pluginRootStat.isDirectory(), ".claude-plugin should be a directory");

console.log("Plugin manifest wiring test passed");
