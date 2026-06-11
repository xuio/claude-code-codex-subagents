import { describe, expect, it } from "vitest";
import {
  clearPluginProcessDiagnosticsCache,
  detectPluginProcesses,
  parsePsProcessLine,
  pluginProcessDiagnosticsFromSnapshots,
  type PluginProcessSnapshot,
} from "../src/processes.js";

describe("plugin process diagnostics", () => {
  it("parses ps rows and detects high-cpu orphaned plugin processes", () => {
    const stale = parsePsProcessLine(
      "62735     1 62463 R     99.3 05:09:10 node /Users/me/dev/claude-code-codex-subagents/dist/index.js",
    );
    expect(stale).toEqual({
      pid: 62735,
      ppid: 1,
      pgid: 62463,
      stat: "R",
      cpuPct: 99.3,
      elapsed: "05:09:10",
      command: "node /Users/me/dev/claude-code-codex-subagents/dist/index.js",
    });

    const active: PluginProcessSnapshot = {
      ...stale!,
      pid: 28936,
      ppid: 28927,
      pgid: 28679,
      stat: "S",
      cpuPct: 0,
      elapsed: "00:22:57",
    };
    const diagnostics = pluginProcessDiagnosticsFromSnapshots([stale!, active], 28936);
    expect(diagnostics.staleSuspects.map((process) => process.pid)).toEqual([62735]);
    expect(diagnostics.highCpuStaleSuspects.map((process) => process.pid)).toEqual([62735]);
  });

  it("ignores unrelated node processes", () => {
    const unrelated = parsePsProcessLine("123 1 123 S 80.0 00:00:10 node /tmp/other/dist/index.js");
    expect(unrelated).toBeDefined();
    expect(pluginProcessDiagnosticsFromSnapshots([unrelated!], 999).pluginProcesses).toEqual([]);
  });

  it("detects plugin commands even when the launcher is not literal node", () => {
    const wrapped = parsePsProcessLine(
      "456 1 456 R 55.0 00:00:10 bun /opt/plugins/codex-subagents/dist/index.js",
    );
    expect(wrapped).toBeDefined();
    const diagnostics = pluginProcessDiagnosticsFromSnapshots([wrapped!], 999);
    expect(diagnostics.highCpuStaleSuspects.map((process) => process.pid)).toEqual([456]);
  });

  it("caches process scans for the configured ttl", async () => {
    clearPluginProcessDiagnosticsCache();
    let scans = 0;
    const makeResult = async () => {
      scans += 1;
      return pluginProcessDiagnosticsFromSnapshots([], scans);
    };

    const first = await detectPluginProcesses({ now: 1_000, ttlMs: 30_000, scan: makeResult });
    const second = await detectPluginProcesses({ now: 2_000, ttlMs: 30_000, scan: makeResult });
    const third = await detectPluginProcesses({ now: 31_001, ttlMs: 30_000, scan: makeResult });

    expect(first.currentPid).toBe(1);
    expect(second.currentPid).toBe(1);
    expect(third.currentPid).toBe(2);
    expect(scans).toBe(2);
    clearPluginProcessDiagnosticsCache();
  });
});
