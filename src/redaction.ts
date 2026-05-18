const privateKeyPattern = new RegExp(
  [
    "-----BEGIN [A-Z ]*PRIVATE ",
    "KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE ",
    "KEY-----",
  ].join(""),
  "g",
);

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)=([^\s"'`]+)\b/gi,
  privateKeyPattern,
];

const SENSITIVE_ENV_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|COOKIE|SESSION|CREDENTIAL|AUTH)/i;
const SAFE_ENV_KEYS = new Set([
  "CODEX_HOME",
  "CODEX_DESKTOP_APP_PATH",
  "CODEX_SUBAGENTS_CODEX_BIN",
  "FAKE_CODEX_RECORD_DIR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, captured) => {
      if (typeof captured === "string") return match.replace(captured, "[REDACTED]");
      return "[REDACTED]";
    });
  }
  return redacted;
}

export function redactJsonValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      redactJsonValue(child),
    ]),
  ) as T;
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv, forwardSensitiveEnv = false): NodeJS.ProcessEnv {
  if (forwardSensitiveEnv) return { ...env };

  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_KEYS.has(key) || !SENSITIVE_ENV_KEY.test(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
