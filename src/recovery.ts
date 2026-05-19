import type { AgentRunResult } from "./runner.js";

export interface RecoveryHint {
  recoverable: boolean;
  reason: string;
  recommendedAction: string;
  recommendedTool?: string;
  retryAfterMs?: number;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recoveryForError(error: unknown, context = "tool_call"): RecoveryHint {
  const message = messageFor(error);
  const lower = message.toLowerCase();

  if (lower.includes("cancelled") || lower.includes("aborted")) {
    return {
      recoverable: false,
      reason: "request_cancelled",
      recommendedAction: "The request was cancelled. Start a new run only if the cancellation was accidental.",
    };
  }

  if (lower.includes("unknown session_id")) {
    return {
      recoverable: false,
      reason: "unknown_session",
      recommendedAction: "Call codex_sessions or start a new Codex session.",
      recommendedTool: "codex_sessions",
    };
  }

  if (lower.includes("unknown job_id")) {
    return {
      recoverable: false,
      reason: "unknown_job",
      recommendedAction: "Start a new persistent Codex session for long-running work.",
      recommendedTool: "codex_session_start",
    };
  }

  if (lower.includes("queue is full") || lower.includes("backpressure") || lower.includes("too many queued")) {
    return {
      recoverable: true,
      reason: "backpressure",
      recommendedAction: "Reduce max_parallel or wait briefly, then retry. Inspect codex_status for queue/session limits.",
      recommendedTool: "codex_status",
      retryAfterMs: 2_000,
    };
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      recoverable: true,
      reason: "timeout",
      recommendedAction: "Inspect the current job or session, then retry with a larger timeout if it is still needed.",
      retryAfterMs: 1_000,
    };
  }

  if (lower.includes("app-server") || lower.includes("app server")) {
    return {
      recoverable: true,
      reason: "app_server_unavailable",
      recommendedAction: "Retry once. If it repeats, use codex_status or force CODEX_SUBAGENTS_SESSION_PROTOCOL=exec.",
      recommendedTool: "codex_status",
      retryAfterMs: 1_000,
    };
  }

  if (lower.includes("validation") || lower.includes("reasoning_effort") || lower.includes("reasoning_summary")) {
    return {
      recoverable: false,
      reason: "invalid_request",
      recommendedAction: "Adjust the model/reasoning settings and retry. Do not use minimal reasoning or Spark with reasoning summaries.",
    };
  }

  return {
    recoverable: true,
    reason: context,
    recommendedAction: "Retry once if the failure looks transient; otherwise call codex_doctor and inspect the verbose logs.",
    recommendedTool: "codex_doctor",
    retryAfterMs: 1_000,
  };
}

export function recoveryForAgentResult(result: Pick<AgentRunResult, "ok" | "status" | "timeoutReason" | "validationError">): RecoveryHint | undefined {
  if (result.ok) return undefined;

  if (result.validationError) {
    return {
      recoverable: false,
      reason: "invalid_request",
      recommendedAction: result.validationError,
    };
  }

  if (result.status === "timeout") {
    return {
      recoverable: true,
      reason: result.timeoutReason ?? "timeout",
      recommendedAction: "Retry with a larger timeout, start a Codex session for long-running work, or split the task into smaller independent prompts.",
      recommendedTool: "codex_session_start",
      retryAfterMs: 1_000,
    };
  }

  if (result.status === "cancelled") {
    return {
      recoverable: false,
      reason: "cancelled",
      recommendedAction: "The Codex run was cancelled. Start a fresh run only if more work is needed.",
    };
  }

  return {
    recoverable: true,
    reason: "codex_failed",
    recommendedAction: "Inspect stderr/eventSummary.errors. Retry with codex_doctor context if the failure appears environmental.",
    recommendedTool: "codex_doctor",
  };
}

export function recoveryForWait(
  kind: "agent_job" | "codex_session",
  timeoutReason: "wait_timeout" | "wait_cancelled" | undefined,
): RecoveryHint | undefined {
  if (!timeoutReason) return undefined;
  if (timeoutReason === "wait_cancelled") {
    return {
      recoverable: true,
      reason: "wait_cancelled",
      recommendedAction:
        kind === "codex_session"
          ? "The wait request was cancelled, but the session may still be running. Inspect it before deciding whether to cancel it."
          : "The wait request was cancelled, but the job may still be running. Inspect it before deciding whether to cancel it.",
      recommendedTool: kind === "codex_session" ? "codex_session_status" : "codex_status",
    };
  }
  return {
    recoverable: true,
    reason: "wait_timeout",
    recommendedAction:
      kind === "codex_session"
        ? "Call codex_session_status to inspect progress or codex_session_wait again with a larger timeout."
        : "Call codex_status to inspect queue state, then retry or switch to codex_session_start for long-running work.",
    recommendedTool: kind === "codex_session" ? "codex_session_status" : "codex_status",
    retryAfterMs: 1_000,
  };
}
