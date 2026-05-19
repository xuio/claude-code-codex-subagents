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

function recordCall(call) {
  if (!process.env.FAKE_CODEX_RECORD_DIR) return;
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
      at: Date.now(),
      codexHome: process.env.CODEX_HOME,
      codexConfig: configPath && existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
      hasCanaryApiKey: Boolean(process.env.CANARY_API_KEY),
      agentFiles,
      ...call,
    })}\n`,
  );
}

if (args[0] === "app-server") {
  let buffer = "";
  let threadId = `fake-thread-${process.pid}`;
  let activeTurn = undefined;
  let activePrompt = "";
  let activeSteers = [];
  let activeTimer = undefined;

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function finishTurn() {
    if (!activeTurn) return;
    const turnId = activeTurn;
    const finalMessage = `fake app-server result for: ${activePrompt.trim()}${
      activeSteers.length ? ` | steers: ${activeSteers.join(" | ")}` : ""
    }`;
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item_final", delta: finalMessage },
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "item_final", text: finalMessage, phase: "final_answer" },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "completed",
          error: null,
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: 1,
        },
      },
    });
    activeTurn = undefined;
    activePrompt = "";
    activeSteers = [];
  }

  function handleRequest(request) {
    const { id, method, params } = request;
    if (method === "initialize") {
      send({
        id,
        result: {
          userAgent: "fake codex app-server",
          codexHome: process.env.CODEX_HOME ?? "",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
      return;
    }
    if (method === "thread/start") {
      threadId = `fake-thread-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      send({
        id,
        result: {
          thread: {
            id: threadId,
            sessionId: threadId,
            forkedFromId: null,
            preview: "",
            ephemeral: Boolean(params?.ephemeral),
            modelProvider: "fake",
            createdAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
            status: { type: "idle" },
            path: null,
            cwd: params?.cwd ?? process.cwd(),
            cliVersion: "fake",
            source: "vscode",
            threadSource: params?.threadSource ?? null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: params?.model ?? "fake-model",
          modelProvider: "fake",
          serviceTier: params?.serviceTier ?? null,
          cwd: params?.cwd ?? process.cwd(),
          instructionSources: [],
          approvalPolicy: params?.approvalPolicy ?? "never",
          approvalsReviewer: "client",
          sandbox: { type: "readOnly", networkAccess: false },
          reasoningEffort: params?.config?.model_reasoning_effort ?? "medium",
        },
      });
      send({ method: "thread/started", params: { thread: { id: threadId, cwd: params?.cwd ?? process.cwd(), turns: [] } } });
      return;
    }
    if (method === "turn/start") {
      activeTurn = `fake-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activePrompt = params?.input?.find?.((item) => item.type === "text")?.text ?? "";
      activeSteers = [];
      recordCall({ protocol: "app-server", method, prompt: activePrompt, threadId, turnId: activeTurn });
      send({
        id,
        result: {
          turn: {
            id: activeTurn,
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        },
      });
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: {
            id: activeTurn,
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: Math.floor(Date.now() / 1000),
            completedAt: null,
            durationMs: null,
          },
        },
      });
      const delayMatch = activePrompt.match(/DELAY_MS=(\d+)/);
      activeTimer = setTimeout(finishTurn, delayMatch ? Number(delayMatch[1]) : 10);
      return;
    }
    if (method === "turn/steer") {
      if (!activeTurn || params?.expectedTurnId !== activeTurn) {
        send({ id, error: { code: -32000, message: "active turn mismatch" } });
        return;
      }
      const steering = params?.input?.find?.((item) => item.type === "text")?.text ?? "";
      activeSteers.push(steering);
      recordCall({ protocol: "app-server", method, prompt: steering, threadId, turnId: activeTurn });
      send({ id, result: { turnId: activeTurn } });
      return;
    }
    if (method === "turn/interrupt") {
      if (activeTimer) clearTimeout(activeTimer);
      const interrupted = activeTurn;
      activeTurn = undefined;
      send({ id, result: {} });
      if (interrupted) {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: interrupted,
              items: [],
              itemsView: "notLoaded",
              status: "interrupted",
              error: null,
              startedAt: Math.floor(Date.now() / 1000),
              completedAt: Math.floor(Date.now() / 1000),
              durationMs: 1,
            },
          },
        });
      }
      return;
    }
    if (method === "thread/read") {
      send({ id, result: { thread: { id: threadId, turns: [] } } });
      return;
    }
    send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) handleRequest(JSON.parse(line));
      newlineIndex = buffer.indexOf("\n");
    }
  });
  process.stdin.resume();
} else if (args[0] !== "exec") {
  process.stderr.write(`unexpected command: ${args.join(" ")}\n`);
  process.exit(64);
} else {

const isResume = args[1] === "resume";
function resumeSessionId(args) {
  if (!isResume) return undefined;
  if (args.includes("--last")) return `fake-last-${process.pid}`;
  const promptIndex = args.lastIndexOf("-");
  const candidate = promptIndex > 0 ? args[promptIndex - 1] : undefined;
  return candidate && !candidate.startsWith("-") ? candidate : undefined;
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  prompt += chunk;
}

if (prompt.includes("IGNORE_SIGTERM")) {
  process.on("SIGTERM", () => {});
}

recordCall({ protocol: "exec", prompt });

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

emit({ type: "thread.started", thread_id: resumeSessionId(args) ?? `fake-${process.pid}` });
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

let finalMessage = `fake codex result for: ${prompt.trim()}`;
const finalMatch = prompt.match(/BIG_FINAL_CHARS=(\d+)/);
if (finalMatch) {
  finalMessage = "f".repeat(Number(finalMatch[1]));
}
if (prompt.includes("JSON_FINAL=review_findings")) {
  finalMessage = JSON.stringify({
    summary: "fake structured review",
    findings: [
      {
        severity: "medium",
        title: "Fake finding",
        description: "Structured output was requested.",
        file: "src/example.ts",
        line: 1,
        recommendation: "Use the structured output.",
      },
    ],
  });
}
if (prompt.includes("LEAK_SECRET")) {
  const canarySecret = ["sk", "test1234567890abcdefghijklmnop"].join("-");
  finalMessage = `secret ${canarySecret} and CANARY_API_KEY=abc123secret`;
}
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
}
