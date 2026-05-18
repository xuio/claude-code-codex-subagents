#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function argAfter(flag, args) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli fake-0.1.0\n");
  process.exit(0);
}

if (args[0] !== "exec") {
  process.stderr.write(`unexpected command: ${args.join(" ")}\n`);
  process.exit(64);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  prompt += chunk;
}

if (prompt.includes("IGNORE_SIGTERM")) {
  process.on("SIGTERM", () => {});
}

if (process.env.FAKE_CODEX_RECORD_DIR) {
  mkdirSync(process.env.FAKE_CODEX_RECORD_DIR, { recursive: true });
  const agentDir = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "agents") : undefined;
  const agentFiles =
    agentDir && existsSync(agentDir)
      ? Object.fromEntries(
          readdirSync(agentDir)
            .filter((file) => file.endsWith(".toml"))
            .map((file) => [file, readFileSync(join(agentDir, file), "utf8")]),
        )
      : {};
  const configPath = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "config.toml") : undefined;
  appendFileSync(
    join(process.env.FAKE_CODEX_RECORD_DIR, "calls.jsonl"),
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      prompt,
      at: Date.now(),
      codexHome: process.env.CODEX_HOME,
      codexConfig: configPath && existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
      agentFiles,
    })}\n`,
  );
}

const stdoutMatch = prompt.match(/BIG_STDOUT_CHARS=(\d+)/);
if (stdoutMatch) {
  process.stdout.write("x".repeat(Number(stdoutMatch[1])));
}

const stderrMatch = prompt.match(/BIG_STDERR_CHARS=(\d+)/);
if (stderrMatch) {
  process.stderr.write("e".repeat(Number(stderrMatch[1])));
}

if (prompt.includes("MALFORMED_JSONL")) {
  process.stdout.write("this is not json\n");
}

if (prompt.includes("HANG_FOREVER")) {
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}

const delayMatch = prompt.match(/DELAY_MS=(\d+)/);
if (delayMatch) {
  await new Promise((resolve) => setTimeout(resolve, Number(delayMatch[1])));
}

emit({ type: "thread.started", thread_id: `fake-${process.pid}` });
emit({ type: "turn.started" });

if (prompt.includes("RUN_COMMAND_EVENT")) {
  emit({
    type: "item.completed",
    item: {
      id: "item_command",
      type: "command_execution",
      command: "rg example",
      status: "completed",
    },
  });
}

const finalMessage = `fake codex result for: ${prompt.trim()}`;
emit({
  type: "item.completed",
  item: {
    id: "item_final",
    type: "agent_message",
    text: finalMessage,
  },
});
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
  },
});

const outputPath = argAfter("--output-last-message", args);
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, finalMessage);
}

if (prompt.includes("EXIT_7")) {
  process.stderr.write("requested failure\n");
  process.exit(7);
}

process.exit(0);
