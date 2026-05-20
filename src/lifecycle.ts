import type { ChildProcess } from "node:child_process";
import { errorForLog, logger } from "./logging.js";

type CleanupHandler = (reason: string) => void | Promise<void>;

const trackedChildren = new Map<ChildProcess, { label: string; id?: string }>();
const cleanupHandlers = new Set<CleanupHandler>();
let cleanupPromise: Promise<void> | undefined;

export function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null) return;

  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Direct-child signaling below is still attempted.
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore kill races; the close event decides the final state.
  }
}

export function trackChildProcess(
  child: ChildProcess,
  meta: { label: string; id?: string },
): () => void {
  trackedChildren.set(child, meta);
  const untrack = () => trackedChildren.delete(child);
  child.once("close", untrack);
  child.once("error", untrack);
  return untrack;
}

export function registerCleanupHandler(handler: CleanupHandler): () => void {
  cleanupHandlers.add(handler);
  return () => cleanupHandlers.delete(handler);
}

export function lifecycleStats(): { trackedChildren: number; cleanupHandlers: number; cleanupInProgress: boolean } {
  return {
    trackedChildren: trackedChildren.size,
    cleanupHandlers: cleanupHandlers.size,
    cleanupInProgress: Boolean(cleanupPromise),
  };
}

export async function cleanupRuntime(reason: string, graceMs = 2_500): Promise<void> {
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = (async () => {
    logger.warn("lifecycle.cleanup.start", {
      reason,
      trackedChildren: trackedChildren.size,
      cleanupHandlers: cleanupHandlers.size,
    });

    await Promise.allSettled(
      [...cleanupHandlers].map(async (handler) => {
        try {
          await handler(reason);
        } catch (error) {
          logger.error("lifecycle.cleanup.handler_failed", { reason, error: errorForLog(error) });
        }
      }),
    );

    for (const [child, meta] of trackedChildren) {
      logger.warn("lifecycle.child.terminate", { reason, signal: "SIGTERM", ...meta, pid: child.pid });
      killChildProcess(child, "SIGTERM");
    }

    const waitMs = Math.max(50, Math.min(graceMs, 60_000));
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    for (const [child, meta] of trackedChildren) {
      logger.warn("lifecycle.child.force_terminate", { reason, signal: "SIGKILL", ...meta, pid: child.pid });
      killChildProcess(child, "SIGKILL");
    }

    logger.warn("lifecycle.cleanup.finish", { reason, remainingChildren: trackedChildren.size });
  })();

  return cleanupPromise;
}
