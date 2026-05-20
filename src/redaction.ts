const privateKeyPattern = new RegExp(
  [
    "-----BEGIN [A-Z ]*PRIVATE ",
    "KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE ",
    "KEY-----",
  ].join(""),
  "g",
);

const SECRET_PATTERNS: RegExp[] = [
  /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{12,})\b/gi,
  /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)=([^\s"'`]+)\b/gi,
  /\b(?:api[_-]?key|token|secret|password|private[_-]?key|authorization)\s*[:=]\s*([^\s"'`]+)\b/gi,
  privateKeyPattern,
];

const SENSITIVE_ENV_KEY =
  /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PRIVATE[_-]?KEY|COOKIE|CREDENTIAL|AUTH|BEARER|WEBHOOK|(^|[_-])TOKEN$|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|OAUTH[_-]?TOKEN|SESSION[_-]?(KEY|TOKEN|SECRET|COOKIE)|DATABASE[_-]?(URL|URI)|APPLICATION[_-]?CREDENTIALS|KUBECONFIG)/i;
const SENSITIVE_ENV_DENYLIST = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "DATABASE_URL",
  "DATABASE_URI",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "MONGO_URL",
  "SLACK_WEBHOOK",
  "SLACK_WEBHOOK_URL",
  "KUBECONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
]);
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

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_ENV_DENYLIST.has(key.toUpperCase()) || SENSITIVE_ENV_KEY.test(key);
}

function hasSensitiveEnvValue(value: string): boolean {
  return /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/i.test(value);
}

export function redactJsonValue<T>(value: T, key = ""): T {
  if (key && isSensitiveKey(key)) return "[REDACTED]" as T;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, key)) as T;
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      redactJsonValue(child, key),
    ]),
  ) as T;
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv, forwardSensitiveEnv = false): NodeJS.ProcessEnv {
  if (forwardSensitiveEnv) return { ...env };

  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_KEYS.has(key) || (!isSensitiveKey(key) && !hasSensitiveEnvValue(value))) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
