export const defaultBlockingWaitTimeoutMs = 300_000;
export const hardMaxBlockingWaitTimeoutMs = 300_000;
export const minBlockingWaitTimeoutMs = 25;

export type BlockingWaitTimeout = {
  requestedMs: number;
  effectiveMs: number;
  capped: boolean;
};

export function configuredMaxBlockingWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultBlockingWaitTimeoutMs;
  return Math.max(minBlockingWaitTimeoutMs, Math.min(Math.floor(parsed), hardMaxBlockingWaitTimeoutMs));
}

export function capBlockingWaitTimeout(
  requestedMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BlockingWaitTimeout {
  const requested = requestedMs ?? configuredMaxBlockingWaitMs(env);
  const normalized = Math.max(1, Math.floor(requested));
  const effective = Math.min(normalized, configuredMaxBlockingWaitMs(env));
  return {
    requestedMs: normalized,
    effectiveMs: effective,
    capped: effective < normalized,
  };
}
