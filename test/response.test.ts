import { describe, expect, it } from "vitest";
import { compactAgentResultForMcp, compactAgentResultsForMcp, compactSessionSnapshotForMcp } from "../src/response.js";
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

  it("redacts bearer and colon-form secrets in command previews", () => {
    const compact = compactAgentResultForMcp(
      agent({
        commandPreview: [
          "/bin/codex",
          "exec",
          "Authorization: Bearer secretbearertoken1234567890",
          "password: raw-password-canary",
        ],
      }),
    );

    expect(compact.commandPreview.join(" ")).not.toContain("secretbearertoken1234567890");
    expect(compact.commandPreview.join(" ")).not.toContain("raw-password-canary");
  });

  it("compacts session turn prompts in MCP snapshots", () => {
    const prompt = "p".repeat(100_000);
    const compact = compactSessionSnapshotForMcp({
      id: "session-test",
      activeTurn: { id: "turn-active", prompt },
      queuedTurns: [{ id: "turn-queued", prompt }],
      recentTurns: Array.from({ length: 30 }, (_, index) => ({ id: `turn-${index}`, prompt })),
    } as {
      id: string;
      lastResult?: unknown;
      partial?: unknown;
      activeTurn?: unknown;
      queuedTurns?: unknown[];
      recentTurns?: unknown[];
    });

    expect((compact.activeTurn as { prompt: string }).prompt.length).toBeLessThan(3_000);
    expect((compact.activeTurn as { promptOmittedChars: number }).promptOmittedChars).toBeGreaterThan(90_000);
    expect((compact.queuedTurns as unknown[])).toHaveLength(1);
    expect((compact.recentTurns as unknown[])).toHaveLength(20);
    expect(JSON.stringify(compact).length).toBeLessThan(60_000);
  });

  it("reports idle instead of active when a session has no running turn", () => {
    const compact = compactSessionSnapshotForMcp({
      id: "session-idle",
      status: "active",
      active: false,
    } as {
      id: string;
      status: string;
      active: boolean;
      lastResult?: unknown;
      partial?: unknown;
    });

    expect(compact.status).toBe("idle");
  });
});
