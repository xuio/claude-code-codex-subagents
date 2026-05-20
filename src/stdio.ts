const brokenStdioCodes = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);

export function isBrokenStdioError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === "string" && brokenStdioCodes.has(value.code)) return true;
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  return (
    message.includes("broken pipe") ||
    message.includes("stream has been destroyed") ||
    message.includes("write after end")
  );
}
