import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { errorForLog, logger } from "./logging.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function progressNotificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CODEX_SUBAGENTS_ENABLE_PROGRESS_NOTIFICATIONS?.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw ?? "");
}

function progressSendTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_PROGRESS_SEND_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1_000;
  return Math.max(25, Math.min(Math.floor(parsed), 10_000));
}

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`Progress notification timed out after ${ms}ms`)), ms);
    timer.unref();
  });
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([promise, timeoutPromise(timeoutMs)]);
}

export type ProgressOptions = { progress?: number; total?: number; reserveFinal?: boolean; force?: boolean };

function progressMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_PROGRESS_MIN_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed < 0) return 250;
  return Math.max(0, Math.min(Math.floor(parsed), 5_000));
}

export function createProgressReporter(
  extra: ToolExtra | undefined,
  options: { sendTimeoutMs?: number; minIntervalMs?: number; enabled?: boolean } = {},
) {
  const progressToken = extra?._meta?.progressToken;
  const enabled = options.enabled ?? progressNotificationsEnabled();
  const sendTimeoutMs = options.sendTimeoutMs ?? progressSendTimeoutMs();
  const minIntervalMs = options.minIntervalMs ?? progressMinIntervalMs();
  let progress = 0;
  let pending = Promise.resolve();
  let disabled = false;
  let failures = 0;
  let lastSentAt = 0;
  let throttleTimer: NodeJS.Timeout | undefined;
  let pendingThrottled:
    | {
        message: string;
        progressOptions: ProgressOptions;
      }
    | undefined;

  function queueSend(message: string, progressOptions: ProgressOptions = {}) {
    if (!enabled || progressToken === undefined || !extra) return;
    pending = pending
      .catch(() => {})
      .then(async () => {
        if (disabled) return;
        const requested = progressOptions.progress ?? progress + 1;
        const unclamped = Math.max(progress + 1, requested);
        const next =
          progressOptions.total === undefined
            ? unclamped
            : Math.min(
                unclamped,
                progressOptions.reserveFinal && progressOptions.progress === undefined
                  ? Math.max(0, progressOptions.total - 1)
                  : progressOptions.total,
              );
        if (next <= progress) return;
        progress = next;
        lastSentAt = Date.now();
        await bounded(
          extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              ...(progressOptions.total === undefined ? {} : { total: progressOptions.total }),
              message,
            },
          }),
          sendTimeoutMs,
        );
        failures = 0;
        logger.rawDebug("mcp.notification.sent", {
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(progressOptions.total === undefined ? {} : { total: progressOptions.total }),
            message,
          },
        });
      })
      .catch((error) => {
        failures += 1;
        if (failures >= 2) disabled = true;
        logger.error("mcp.notification.failed", { disabled, error: errorForLog(error) });
      });
  }

  function scheduleThrottledSend(): void {
    if (throttleTimer || !pendingThrottled) return;
    const elapsed = Date.now() - lastSentAt;
    const delay = Math.max(0, minIntervalMs - elapsed);
    throttleTimer = setTimeout(() => {
      throttleTimer = undefined;
      const next = pendingThrottled;
      pendingThrottled = undefined;
      if (next) queueSend(next.message, next.progressOptions);
    }, delay);
    throttleTimer.unref();
  }

  async function send(message: string, progressOptions: ProgressOptions = {}) {
    logger.rawDebug("mcp.progress", {
      hasProgressToken: progressToken !== undefined,
      enabled,
      message,
      options: progressOptions,
    });
    if (!enabled || progressToken === undefined || !extra || disabled) return;

    const elapsed = Date.now() - lastSentAt;
    if (progressOptions.force || minIntervalMs === 0 || lastSentAt === 0 || elapsed >= minIntervalMs) {
      if (progressOptions.force && throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = undefined;
        pendingThrottled = undefined;
      }
      queueSend(message, progressOptions);
    } else {
      pendingThrottled = { message, progressOptions };
      scheduleThrottledSend();
    }

    await bounded(pending, sendTimeoutMs + 25).catch(() => {});
  }

  async function flush() {
    if (!enabled || progressToken === undefined || !extra) return;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = undefined;
    }
    if (pendingThrottled) {
      const next = pendingThrottled;
      pendingThrottled = undefined;
      queueSend(next.message, next.progressOptions);
    }
    await bounded(pending, sendTimeoutMs + 25).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { send, flush };
}

export type ProgressReporter = ReturnType<typeof createProgressReporter>;
