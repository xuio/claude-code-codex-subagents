const brokenStdioCodes = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

export type OrphanWatchdogState = {
  orphanSinceMs?: number;
  shouldExit: boolean;
};

export function isBrokenStdioError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === "string" && brokenStdioCodes.has(value.code)) return true;
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  return (
    message.includes("broken pipe") ||
    message.includes("channel closed") ||
    message.includes("socket closed") ||
    message.includes("stream has been destroyed") ||
    message.includes("write after end")
  );
}

export function isOrphanedParentPid(parentPid: number): boolean {
  return parentPid <= 1;
}

export function updateOrphanWatchdogState(options: {
  parentPid: number;
  nowMs: number;
  previousOrphanSinceMs?: number;
  graceMs: number;
}): OrphanWatchdogState {
  if (!isOrphanedParentPid(options.parentPid)) {
    return { shouldExit: false };
  }

  const orphanSinceMs = options.previousOrphanSinceMs ?? options.nowMs;
  return {
    orphanSinceMs,
    shouldExit: options.nowMs - orphanSinceMs >= options.graceMs,
  };
}
