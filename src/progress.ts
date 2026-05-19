import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { errorForLog, logger } from "./logging.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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

export type ProgressOptions = { progress?: number; total?: number; reserveFinal?: boolean };

export function createProgressReporter(extra: ToolExtra | undefined, options: { sendTimeoutMs?: number } = {}) {
  const progressToken = extra?._meta?.progressToken;
  const sendTimeoutMs = options.sendTimeoutMs ?? progressSendTimeoutMs();
  let progress = 0;
  let pending = Promise.resolve();
  let disabled = false;
  let failures = 0;

  async function send(message: string, progressOptions: ProgressOptions = {}) {
    logger.rawDebug("mcp.progress", {
      hasProgressToken: progressToken !== undefined,
      message,
      options: progressOptions,
    });
    if (progressToken === undefined || !extra || disabled) return;

    pending = pending
      .catch(() => {})
      .then(async () => {
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

    await bounded(pending, sendTimeoutMs + 25).catch(() => {});
  }

  async function flush() {
    if (progressToken === undefined || !extra) return;
    await bounded(pending, sendTimeoutMs + 25).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { send, flush };
}

export type ProgressReporter = ReturnType<typeof createProgressReporter>;
