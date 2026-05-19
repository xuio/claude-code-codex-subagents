import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";

describe("version metadata", () => {
  it("keeps package, plugin, and MCP server version source aligned", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const pluginJson = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8")) as { version: string };

    expect(packageVersion).toBe(packageJson.version);
    expect(pluginJson.version).toBe(packageJson.version);
  });
});
