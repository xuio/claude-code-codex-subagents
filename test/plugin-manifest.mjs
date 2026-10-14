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
const marketplace = JSON.parse(await readFile(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
const mcp = JSON.parse(await readFile(path.join(root, ".claude-plugin/mcp.json"), "utf8"));

assert(manifest.name === "codex-subagents", "plugin manifest name should stay stable", manifest);
assert(manifest.version === packageJson.version, "plugin manifest version must match package.json", {
  manifest: manifest.version,
  package: packageJson.version,
});
assert(manifest.mcpServers === "./.claude-plugin/mcp.json", "plugin manifest should point at the MCP config", manifest);
assert(manifest.skills === "./skills", "plugin manifest should point at the skills directory", manifest);
assert(marketplace.name === "codex-subagents", "marketplace name must match the README install id", marketplace);
assert(marketplace.owner?.name, "marketplace must declare its owner", marketplace);
assert(marketplace.plugins?.length === 1, "marketplace should contain one plugin", marketplace);
const entry = marketplace.plugins[0];
assert(entry.name === manifest.name, "marketplace entry must match the plugin name", entry);
assert(entry.source === "./", "marketplace source must include the entire plugin at the repository root", entry);
assert(entry.strict === true, "plugin.json must remain authoritative for component wiring", entry);
assert(entry.version === undefined, "plugin version should be defined only in plugin.json", entry);

const server = mcp.mcpServers?.["codex-subagents"];
assert(server?.command === "node", "MCP command should invoke Node explicitly", mcp);
assert(
  Array.isArray(server?.args) && server.args[0] === "${CLAUDE_PLUGIN_ROOT}/dist/index.js",
  "MCP args should use CLAUDE_PLUGIN_ROOT dist entry",
  mcp,
);

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
