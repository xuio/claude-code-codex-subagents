export const defaultBlockingWaitTimeoutMs = 300_000;
export const hardMaxBlockingWaitTimeoutMs = 300_000;
export const defaultProgressBlockingWaitTimeoutMs = 1_200_000;
export const hardMaxProgressBlockingWaitTimeoutMs = 1_200_000;
export const minBlockingWaitTimeoutMs = 25;

export type BlockingWaitTimeout = {
  requestedMs: number;
  effectiveMs: number;
  capped: boolean;
};

export function configuredMaxBlockingWaitMs(
  env: NodeJS.ProcessEnv = process.env,
  options: { progress?: boolean } = {},
): number {
  const envKey = options.progress
    ? "CODEX_SUBAGENTS_MAX_PROGRESS_BLOCKING_WAIT_MS"
    : "CODEX_SUBAGENTS_MAX_BLOCKING_WAIT_MS";
  const fallback = options.progress ? defaultProgressBlockingWaitTimeoutMs : defaultBlockingWaitTimeoutMs;
  const hardMax = options.progress ? hardMaxProgressBlockingWaitTimeoutMs : hardMaxBlockingWaitTimeoutMs;
  const parsed = Number(env[envKey]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(minBlockingWaitTimeoutMs, Math.min(Math.floor(parsed), hardMax));
}

export function capBlockingWaitTimeout(
  requestedMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { progress?: boolean } = {},
): BlockingWaitTimeout {
  const configuredMax = configuredMaxBlockingWaitMs(env, options);
  const requested = requestedMs ?? configuredMax;
  const normalized = Math.max(1, Math.floor(requested));
  const effective = Math.min(normalized, configuredMax);
  return {
    requestedMs: normalized,
    effectiveMs: effective,
    capped: effective < normalized,
  };
}
