import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recoveryForAgentResult, recoveryForError } from "./recovery.js";
import { redactJsonValue, redactSensitiveText } from "./redaction.js";
import {
  compactAgentResultForMcp,
  compactSessionSnapshotForMcp,
} from "./response.js";
import type { AgentRunResult } from "./runner.js";

export function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  const fullText = JSON.stringify(value, null, 2);
  const text =
    fullText.length <= 4_000
      ? fullText
      : JSON.stringify(
          {
            ok: Boolean(value.ok ?? !isError),
            isError,
            note:
              "MCP text content was shortened to keep Claude responsive; use structuredContent for the compacted result.",
            keys: Object.keys(value),
          },
          null,
          2,
        );
  return {
    structuredContent: value,
    isError,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function errorResult(error: unknown, context = "tool_call"): CallToolResult {
  const recovery = recoveryForError(error, context);
  return jsonResult(
    {
      ok: false,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      recovery: redactJsonValue(recovery),
      suggested_next_action: recovery.recommendedAction,
    },
    true,
  );
}

export function agentResultResponse(result: Parameters<typeof compactAgentResultForMcp>[0]): CallToolResult {
  const recovery = recoveryForAgentResult(result);
  return jsonResult(
    {
      agent: compactAgentResultForMcp(result),
      recovery,
      suggested_next_action: recovery?.recommendedAction,
    },
    !result.ok,
  );
}

export function firstUsefulLine(text: string | undefined, fallback: string): string {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length <= 500 ? line : `${line.slice(0, 500)}...`;
}

export function stringifyResultValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function summarizeResultValue(value: unknown, fallbackText: string, fallback: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const summary = (value as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) return firstUsefulLine(summary, fallback);
  }
  if (typeof value === "string" && !value.trim() && fallbackText.trim()) {
    return firstUsefulLine(fallbackText, fallback);
  }
  return firstUsefulLine(stringifyResultValue(value, fallbackText), fallback);
}

export function agentFallbackErrorText(
  agent: {
    validationError?: unknown;
    eventSummary?: { errors?: unknown[] };
    stderr?: unknown;
  },
  recovery?: { recommendedAction?: string },
): string | undefined {
  const validationError = typeof agent.validationError === "string" ? agent.validationError.trim() : "";
  if (validationError) return validationError;

  const eventError = agent.eventSummary?.errors?.find(
    (error): error is string => typeof error === "string" && error.trim().length > 0,
  );
  if (eventError) return eventError.trim();

  const stderr = typeof agent.stderr === "string" ? agent.stderr.trim() : "";
  if (stderr) return stderr;

  const recoveryAction = recovery?.recommendedAction?.trim();
  return recoveryAction || undefined;
}

export function visibleAgentAnswer(
  agent: ReturnType<typeof compactAgentResultForMcp>,
  recovery?: { recommendedAction?: string },
): string {
  const resultValue = agent.structuredOutput ?? agent.finalMessage;
  const answer = stringifyResultValue(resultValue, agent.finalMessage);
  const structuredOutputError = typeof agent.structuredOutputError === "string" ? agent.structuredOutputError : undefined;
  if (agent.ok && agent.structuredOutput !== undefined && !structuredOutputError) {
    const summary = summarizeResultValue(agent.structuredOutput, agent.finalMessage, "").trim();
    return summary && summary !== answer ? `${summary}\n\n${answer}` : answer;
  }
  if (!agent.ok && structuredOutputError) {
    return answer
      ? `${answer}\n\nStructured output parse failed: ${structuredOutputError}`
      : `Codex task ${agent.status}: Structured output parse failed: ${structuredOutputError}`;
  }

  const fallbackReason = !agent.ok && !answer ? agentFallbackErrorText(agent, recovery) : undefined;
  if (fallbackReason) return `Codex task ${agent.status}: ${fallbackReason}`;
  return answer;
}

function agentCommands(agent: ReturnType<typeof compactAgentResultForMcp>): Array<{ command?: string; status?: string }> {
  return agent.eventSummary.commands.map((command) => ({ ...command }));
}

export function suggestedActionForAgent(
  result: { ok: boolean; status: string },
  recovery?: { recommendedAction?: string },
): string | undefined {
  if (recovery?.recommendedAction) return recovery.recommendedAction;
  if (result.ok) return undefined;
  return "Inspect the Codex result details and retry only if the failure looks transient.";
}

export function nativeTextResult(value: Record<string, unknown>, isError = false, textOverride?: string): CallToolResult {
  const text =
    typeof textOverride === "string" && textOverride.trim()
      ? textOverride
      : typeof value.result === "string" && value.result.trim()
        ? value.result
        : typeof value.summary === "string"
          ? value.summary
          : JSON.stringify(value, null, 2);
  return {
    structuredContent: value,
    isError,
    content: [{ type: "text", text }],
  };
}

function nativeErrorPayload(error: unknown, context = "tool_call"): Record<string, unknown> {
  const recovery = recoveryForError(error, context);
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  const result = recovery.recommendedAction
    ? `${message}\n\nNext: ${recovery.recommendedAction}`
    : message;
  return {
    ok: false,
    summary: `Codex task failed: ${firstUsefulLine(message, "unknown error")}`,
    result,
    error: {
      message,
      recoverable: recovery.recoverable,
      kind: recovery.reason,
      retry_after_ms: recovery.retryAfterMs,
    },
    hint: recovery.recommendedAction,
  };
}

export function nativeErrorResult(error: unknown, context = "tool_call"): CallToolResult {
  return nativeTextResult(nativeErrorPayload(error, context), true);
}

function diagnosticsForAgent(agent: ReturnType<typeof compactAgentResultForMcp>): Record<string, unknown> {
  return {
    duration_ms: agent.durationMs,
    cwd: agent.cwd,
    model: agent.model,
    reasoning_effort: agent.reasoningEffort,
    sandbox: agent.sandbox,
    compacted: agent.mcpResponse.compacted,
    artifact_paths: agent.outputArtifacts,
    event_summary: agent.eventSummary,
    stderr_tail: agent.stderr || undefined,
    stdout_tail: agent.stdoutTail || undefined,
    structured_output_error: agent.structuredOutputError || undefined,
    validation_error: agent.validationError || undefined,
    timeout_reason: agent.timeoutReason || undefined,
    commands: agentCommands(agent),
  };
}

export function sessionPartialMessage(session: unknown, preferredResult?: unknown): string | undefined {
  if (!session || typeof session !== "object") return undefined;
  const value = session as Record<string, unknown>;
  const partial = value.partial && typeof value.partial === "object" ? (value.partial as Record<string, unknown>) : undefined;
  const lastResult = value.lastResult && typeof value.lastResult === "object" ? (value.lastResult as Record<string, unknown>) : undefined;
  const preferred =
    preferredResult && typeof preferredResult === "object" ? (preferredResult as Record<string, unknown>) : undefined;
  return typeof partial?.lastAgentMessage === "string"
    ? partial.lastAgentMessage
    : typeof preferred?.finalMessage === "string"
      ? preferred.finalMessage
      : typeof lastResult?.finalMessage === "string"
        ? lastResult.finalMessage
        : undefined;
}

export function sessionProgressPayload(session: unknown, preferredResult?: unknown): Record<string, unknown> {
  if (!session || typeof session !== "object") return {};
  const value = session as Record<string, unknown>;
  const partialResult = sessionPartialMessage(session, preferredResult);
  const activeTurn = value.activeTurn && typeof value.activeTurn === "object" ? (value.activeTurn as Record<string, unknown>) : undefined;
  const updatedAt = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : NaN;
  const createdAt = typeof activeTurn?.createdAt === "string" ? Date.parse(activeTurn.createdAt) : NaN;
  const elapsedBase = Number.isFinite(createdAt) ? createdAt : updatedAt;
  return {
    partial_result: partialResult,
    last_event:
      typeof activeTurn?.status === "string"
        ? `${activeTurn.kind ?? "turn"}:${activeTurn.status}`
        : typeof value.status === "string"
          ? value.status
          : undefined,
    elapsed_ms: Number.isFinite(elapsedBase) ? Math.max(0, Date.now() - elapsedBase) : undefined,
    next_poll_ms: value.active ? 1_000 : undefined,
  };
}

export function nativeAgentPayload(
  result: AgentRunResult,
  context: {
    description?: string;
    prompt?: string;
    tool: string;
    session?: ReturnType<typeof compactSessionSnapshotForMcp>;
    turn?: unknown;
    includeDiagnostics?: boolean;
    includeSessionId?: boolean;
  },
): Record<string, unknown> {
  const agent = compactAgentResultForMcp(result);
  const recovery = recoveryForAgentResult(result);
  const resultValue = agent.structuredOutput ?? agent.finalMessage;
  const structuredOutputError = typeof agent.structuredOutputError === "string" ? agent.structuredOutputError : undefined;
  const visibleAnswer = visibleAgentAnswer(agent, recovery);
  const sessionId = context.session && typeof context.session === "object" ? (context.session as { id?: string }).id : undefined;
  const sessionFallbackReason =
    context.session && typeof context.session === "object"
      ? (context.session as { appServerFallbackReason?: string }).appServerFallbackReason
      : undefined;
  const hint = recovery?.recommendedAction ?? suggestedActionForAgent(agent, recovery);
  const payload: Record<string, unknown> = {
    ok: agent.ok,
    status: agent.status,
    summary: summarizeResultValue(resultValue, visibleAnswer, `Codex task ${agent.status}`),
    result: visibleAnswer,
  };
  if (agent.structuredOutput !== undefined) payload.structured = agent.structuredOutput;
  if ((context.includeSessionId || !agent.ok) && sessionId) {
    payload.session_id = sessionId;
    if (context.turn !== undefined) payload.turn = context.turn;
  }
  if (hint) payload.hint = hint;
  if (recovery) {
    payload.error = {
      message: structuredOutputError
        ? `Structured output parse failed: ${structuredOutputError}`
        : agentFallbackErrorText(agent, recovery) ?? `Codex task ${agent.status}`,
      recoverable: recovery.recoverable,
      kind: recovery.reason,
      retry_after_ms: recovery.retryAfterMs,
    };
  }
  if (context.includeDiagnostics) {
    payload.diagnostics = {
      ...diagnosticsForAgent(agent),
      session: context.session,
      ...sessionProgressPayload(context.session),
      app_server_fallback_reason: sessionFallbackReason || undefined,
    };
  }
  return payload;
}

export function nativeAgentResponse(
  result: AgentRunResult,
  context: {
    description?: string;
    prompt?: string;
    tool: string;
    session?: ReturnType<typeof compactSessionSnapshotForMcp>;
    turn?: unknown;
    includeDiagnostics?: boolean;
    includeSessionId?: boolean;
  },
): CallToolResult {
  return nativeTextResult(nativeAgentPayload(result, context), !result.ok);
}

export type NativeTaskGroupRun = {
  result?: AgentRunResult;
  error?: unknown;
  session?: { id?: string };
  task: { name?: string; description?: string; prompt?: string; keep_session?: boolean; advanced?: unknown };
};

export function nativeTaskGroupResponse(
  runs: NativeTaskGroupRun[],
  options: { includeDiagnostics?: (advanced: unknown) => boolean } = {},
): CallToolResult {
  const includeDiagnostics = options.includeDiagnostics ?? (() => false);
  const normalized = runs.map((run, index) => {
    if (run.result) {
      const agent = compactAgentResultForMcp(run.result);
      const recovery = recoveryForAgentResult(run.result);
      const resultValue = agent.structuredOutput ?? agent.finalMessage;
      const answer = visibleAgentAnswer(agent, recovery);
      const item: Record<string, unknown> = {
        name: agent.name ?? run.task.name ?? run.task.description ?? `codex-task-${index + 1}`,
        ok: agent.ok,
        status: agent.status,
        summary: summarizeResultValue(resultValue, answer, `Codex task ${agent.status}`),
        result: answer,
      };
      if (agent.structuredOutput !== undefined) item.structured = agent.structuredOutput;
      if ((run.task.keep_session || !agent.ok) && run.session?.id) item.session_id = run.session.id;
      if (recovery) {
        item.error = {
          message: agentFallbackErrorText(agent, recovery) ?? `Codex task ${agent.status}`,
          recoverable: recovery.recoverable,
          kind: recovery.reason,
          retry_after_ms: recovery.retryAfterMs,
        };
      }
      if (includeDiagnostics(run.task.advanced)) item.diagnostics = diagnosticsForAgent(agent);
      return item;
    }

    const recovery = recoveryForError(run.error ?? new Error("Codex task failed before producing a result."), "codex_task_group");
    const message = redactSensitiveText(run.error instanceof Error ? run.error.message : String(run.error ?? "Codex task failed."));
    const result = recovery.recommendedAction ? `${message}\n\nNext: ${recovery.recommendedAction}` : message;
    return {
      name: run.task.name ?? run.task.description ?? `codex-task-${index + 1}`,
      ok: false,
      status: "failed",
      summary: firstUsefulLine(message, "Codex task failed before producing a result."),
      result,
      session_id: run.session?.id,
      error: {
        message,
        recoverable: recovery.recoverable,
        kind: recovery.reason,
        retry_after_ms: recovery.retryAfterMs,
      },
      diagnostics: includeDiagnostics(run.task.advanced) ? {} : undefined,
    };
  });
  const ok = normalized.every((result) => result.ok);
  const resultText = normalized.map((item) => `## ${item.name}\n${item.result || item.summary}`).join("\n\n");
  const firstFailed = normalized.find((result) => !result.ok);
  return nativeTextResult(
    {
      ok,
      status: ok ? "completed" : "failed",
      summary: `${normalized.filter((result) => result.ok).length}/${normalized.length} Codex tasks completed successfully.`,
      results: normalized,
      hint: firstFailed ? "Retry only the failed task if it is still needed." : undefined,
    },
    !ok,
    resultText,
  );
}
