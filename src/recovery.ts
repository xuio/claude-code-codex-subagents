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
      recommendedAction: "Use the session_id returned by codex_task or codex_task_group, or start a new codex_task.",
      recommendedTool: "codex_task",
    };
  }

  if (lower.includes("unknown job_id")) {
    return {
      recoverable: false,
      reason: "unknown_job",
      recommendedAction: "Start a new codex_task with background true for long-running work.",
      recommendedTool: "codex_task",
    };
  }

  if (lower.includes("queue is full") || lower.includes("backpressure") || lower.includes("too many queued")) {
    return {
      recoverable: true,
      reason: "backpressure",
      recommendedAction: "Reduce max_parallel or wait briefly, then retry. Inspect codex://status for queue/session limits.",
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
      recommendedAction: "Retry once. If it repeats, inspect codex://status or force CODEX_SUBAGENTS_SESSION_PROTOCOL=exec.",
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
    recommendedAction: "Retry once if the failure looks transient; otherwise inspect codex://doctor and the verbose logs.",
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
      recommendedAction: "Retry with a larger timeout, use codex_task with background true for long-running work, or split the task into smaller independent prompts.",
      recommendedTool: "codex_task",
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
    recommendedAction: "Inspect diagnostics.event_summary.errors and stderr_tail. Retry after checking codex://doctor if the failure appears environmental.",
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
          ? "The wait request was cancelled, but the session may still be running. Use codex_followup mode wait before deciding whether to start new work."
          : "The wait request was cancelled, but the job may still be running. Inspect codex://status before deciding whether to start new work.",
      recommendedTool: kind === "codex_session" ? "codex_followup" : undefined,
    };
  }
  return {
    recoverable: true,
    reason: "wait_timeout",
      recommendedAction:
        kind === "codex_session"
        ? "Use codex_followup mode wait again with a larger timeout, or mode steer if the active work should be redirected."
        : "Inspect codex://status for queue state, then retry or switch to codex_task with background true for long-running work.",
    recommendedTool: kind === "codex_session" ? "codex_followup" : undefined,
    retryAfterMs: 1_000,
  };
}
