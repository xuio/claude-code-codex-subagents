import { describe, expect, it } from "vitest";
import {
  defaultMilestoneDetectionState,
  detectMilestones,
  maxSessionMilestones,
  type MilestoneDetectionState,
} from "../src/sessions.js";
import type { AgentRunPartial } from "../src/runner.js";

function partial(overrides: Partial<AgentRunPartial> = {}): AgentRunPartial {
  return {
    status: "running",
    durationMs: 1,
    cwd: "/tmp/project",
    stdoutTail: "",
    stderrTail: "",
    eventSummary: {
      counts: {},
      commands: [],
      errors: [],
      ...overrides.eventSummary,
    },
    ...overrides,
  };
}

describe("session milestone detection", () => {
  it("detects command starts and completion transitions", () => {
    let state: MilestoneDetectionState = defaultMilestoneDetectionState();
    const first = detectMilestones(
      partial({
        eventSummary: {
          counts: {},
          commands: [{ command: "rg Auth src", status: "inProgress" }],
          errors: [],
        },
      }),
      state,
      "turn-1",
    );
    state = first.nextState;

    expect(first.milestones).toEqual([
      { kind: "command_started", command: "rg Auth src", turn_id: "turn-1" },
    ]);

    const second = detectMilestones(
      partial({
        eventSummary: {
          counts: {},
          commands: [{ command: "rg Auth src", status: "completed" }],
          errors: [],
        },
      }),
      state,
      "turn-1",
    );

    expect(second.milestones).toEqual([
      { kind: "command_completed", command: "rg Auth src", turn_id: "turn-1" },
    ]);
  });

  it("emits agent messages only when completed item count grows", () => {
    let state: MilestoneDetectionState = defaultMilestoneDetectionState();
    const deltaOnly = detectMilestones(
      partial({
        lastAgentMessage: "partial token delta",
        eventSummary: {
          counts: { "item/agentMessage/delta": 1 },
          commands: [],
          errors: [],
          lastAgentMessage: "partial token delta",
        },
      }),
      state,
      "turn-2",
    );
    state = deltaOnly.nextState;

    expect(deltaOnly.milestones).toEqual([]);

    const completed = detectMilestones(
      partial({
        lastAgentMessage: "Found the auth handler.",
        eventSummary: {
          counts: { "item/agentMessage/delta": 10, "item/completed": 1 },
          commands: [],
          errors: [],
          lastAgentMessage: "Found the auth handler.",
        },
      }),
      state,
      "turn-2",
    );
    state = completed.nextState;

    expect(completed.milestones).toEqual([
      { kind: "agent_message", text: "Found the auth handler.", turn_id: "turn-2" },
    ]);

    const duplicate = detectMilestones(
      partial({
        lastAgentMessage: "Found the auth handler.",
        eventSummary: {
          counts: { "item/agentMessage/delta": 11, "item/completed": 1 },
          commands: [],
          errors: [],
          lastAgentMessage: "Found the auth handler.",
        },
      }),
      state,
      "turn-2",
    );

    expect(duplicate.milestones).toEqual([]);
  });

  it("detects new errors and clamps the configured ring size", () => {
    const result = detectMilestones(
      partial({
        eventSummary: {
          counts: {},
          commands: [],
          errors: ["Authorization: Bearer sk-proj-abc12345678901234567890 failed"],
        },
      }),
      defaultMilestoneDetectionState(),
      "turn-3",
    );

    expect(result.milestones).toEqual([
      {
        kind: "error",
        error: "Authorization: Bearer sk-proj-abc12345678901234567890 failed",
        turn_id: "turn-3",
      },
    ]);
    expect(maxSessionMilestones({ CODEX_SUBAGENTS_MAX_SESSION_MILESTONES: "2" } as NodeJS.ProcessEnv)).toBe(10);
    expect(maxSessionMilestones({ CODEX_SUBAGENTS_MAX_SESSION_MILESTONES: "999" } as NodeJS.ProcessEnv)).toBe(500);
  });
});
