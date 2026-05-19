import { describe, expect, it } from "vitest";
import { compactAgentResultForMcp, compactAgentResultsForMcp } from "../src/response.js";
import type { AgentRunResult } from "../src/runner.js";

function agent(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: true,
    status: "completed",
    durationMs: 1,
    codexBinary: { path: "/bin/codex", source: "explicit" },
    cwd: "/tmp/project",
    reasoningEffort: "medium",
    sandbox: "read-only",
    dangerouslyBypassApprovalsAndSandbox: false,
    exitCode: 0,
    signal: null,
    finalMessage: "done",
    stderr: "",
    stdoutTail: "",
    truncated: {
      stdoutChars: 0,
      stderrChars: 0,
      finalMessageChars: 0,
    },
    eventSummary: {
      counts: {},
      commands: [],
      errors: [],
      lastAgentMessage: "done",
    },
    commandPreview: ["/bin/codex", "exec"],
    codexSubagents: {
      customAgents: [],
      requestedTasks: 0,
      tempCodexHomeUsed: false,
    },
    ...overrides,
  };
}

describe("MCP response compaction", () => {
  it("keeps single-agent tool responses below Claude overflow territory", () => {
    const compact = compactAgentResultForMcp(
      agent({
        finalMessage: "f".repeat(80_000),
        stdoutTail: "o".repeat(80_000),
        stderr: "e".repeat(80_000),
        eventSummary: {
          counts: { "item.completed": 1 },
          commands: [],
          errors: [],
          lastAgentMessage: "f".repeat(80_000),
        },
      }),
    );

    expect(compact.finalMessage.length).toBeLessThan(13_000);
    expect(compact.stdoutTail.length).toBeLessThan(2_500);
    expect(compact.stderr.length).toBeLessThan(2_500);
    expect(compact.eventSummary.lastAgentMessage?.length).toBeLessThan(2_000);
    expect(compact.mcpResponse.compacted).toBe(true);
    expect(JSON.stringify({ agent: compact }).length).toBeLessThan(25_000);
  });

  it("shrinks per-agent messages for parallel tool responses", () => {
    const compact = compactAgentResultsForMcp(
      Array.from({ length: 6 }, (_, index) =>
        agent({
          name: `agent-${index + 1}`,
          finalMessage: "f".repeat(80_000),
          stdoutTail: "o".repeat(20_000),
          stderr: "e".repeat(20_000),
        }),
      ),
    );

    expect(JSON.stringify({ agents: compact }).length).toBeLessThan(45_000);
    expect(compact.every((result) => result.mcpResponse.compacted)).toBe(true);
  });

  it("caps huge shallow structured objects", () => {
    const compact = compactAgentResultForMcp(
      agent({
        structuredOutput: Object.fromEntries(
          Array.from({ length: 10_000 }, (_, index) => [`key_${index}`, `value_${index}`]),
        ),
      }),
    );

    expect(Object.keys(compact.structuredOutput as Record<string, unknown>).length).toBeLessThan(100);
    expect((compact.structuredOutput as Record<string, unknown>).__truncatedObjectKeys).toBe(
      "[truncated 9920 object keys]",
    );
    expect(JSON.stringify({ agent: compact }).length).toBeLessThan(30_000);
  });
});
