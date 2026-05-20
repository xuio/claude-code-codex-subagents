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
  if (process.env.FAKE_CODEX_VERSION_HANG === "1") {
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  }
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
  let threadName = null;
  let threadArchived = false;
  let activeTimer = undefined;

  function modeText() {
    return `${process.env.FAKE_CODEX_APP_SERVER_MODE ?? ""} ${activePrompt}`;
  }

  function hasMode(name) {
    return modeText().split(/[,\s]+/).includes(name) || activePrompt.includes(name);
  }

  function numberMode(name, fallback = 0) {
    const match = modeText().match(new RegExp(`${name}=(\\d+)`));
    return match ? Number(match[1]) : fallback;
  }

  function send(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (hasMode("APP_PARTIAL_LINES") && line.length > 4) {
      const splitAt = Math.max(1, Math.floor(line.length / 2));
      process.stdout.write(line.slice(0, splitAt));
      process.stdout.write(line.slice(splitAt));
      return;
    }
    process.stdout.write(line);
  }

  process.once("SIGTERM", () => {
    recordCall({ protocol: "app-server", method: "process/sigterm", threadId, turnId: activeTurn });
    process.exit(143);
  });

  function sendTurnCompleted(turnId, status = "completed") {
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status,
          error: status === "completed" ? null : { message: `fake ${status}` },
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: 1,
        },
      },
    });
  }

  function finishTurn() {
    if (!activeTurn) return;
    const turnId = activeTurn;
    const exitAfterTurn = hasMode("APP_EXIT_AFTER_TURN");
    let finalMessage = `fake app-server result for: ${activePrompt.trim()}${
      activeSteers.length ? ` | steers: ${activeSteers.join(" | ")}` : ""
    }`;
    if (activePrompt.includes("JSON_FINAL=review_findings")) {
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
    const largeStreamChars = numberMode("APP_LARGE_STREAM_CHARS");
    if (largeStreamChars > 0) {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "item_large", delta: "x".repeat(largeStreamChars) },
      });
    }
    const unterminatedStreamChars = numberMode("APP_UNTERMINATED_STDOUT_CHARS");
    if (unterminatedStreamChars > 0) {
      process.stdout.write("u".repeat(unterminatedStreamChars));
    }
    if (activePrompt.includes("RUN_COMMAND_EVENT")) {
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "commandExecution",
            id: "item_command",
            command: "rg example",
            status: "completed",
          },
        },
      });
    }
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
    if (hasMode("APP_NO_TURN_COMPLETED")) return;
    sendTurnCompleted(turnId);
    if (hasMode("APP_DUPLICATE_COMPLETED")) sendTurnCompleted(turnId);
    activeTurn = undefined;
    activePrompt = "";
    activeSteers = [];
    if (exitAfterTurn) setTimeout(() => process.exit(0), 1);
  }

  function handleRequest(request) {
    const { id, method, params } = request;
    if (id && !method) {
      recordCall({ protocol: "app-server", method: "client/response", response: request, threadId, turnId: activeTurn });
      return;
    }
    if (method === "initialize") {
      if (hasMode("INITIALIZE_ERROR")) {
        send({ id, error: { code: -32000, message: "fake initialize error" } });
        return;
      }
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
      if (hasMode("THREAD_START_ERROR")) {
        send({ id, error: { code: -32000, message: "fake thread start error" } });
        return;
      }
      threadId = `fake-thread-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      threadName = null;
      threadArchived = false;
      recordCall({
        protocol: "app-server",
        method,
        threadId,
        cwd: params?.cwd ?? process.cwd(),
        threadSource: params?.threadSource ?? null,
        serviceName: params?.serviceName ?? null,
      });
      if (hasMode("THREAD_START_NO_ID")) {
        send({ id, result: { thread: {}, cwd: params?.cwd ?? process.cwd() } });
        return;
      }
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
            name: threadName,
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
    if (method === "thread/name/set") {
      threadName = typeof params?.name === "string" ? params.name : null;
      recordCall({ protocol: "app-server", method, threadId: params?.threadId ?? threadId, name: threadName });
      if (hasMode("THREAD_NAME_SET_ERROR")) {
        send({ id, error: { code: -32000, message: "fake thread name set error" } });
        return;
      }
      send({ id, result: {} });
      return;
    }
    if (method === "thread/archive") {
      threadArchived = true;
      recordCall({ protocol: "app-server", method, threadId: params?.threadId ?? threadId });
      if (hasMode("THREAD_ARCHIVE_ERROR")) {
        send({ id, error: { code: -32000, message: "fake thread archive error" } });
        return;
      }
      send({ id, result: {} });
      return;
    }
    if (method === "thread/resume") {
      if (hasMode("THREAD_RESUME_ERROR")) {
        send({ id, error: { code: -32000, message: "fake thread resume error" } });
        return;
      }
      threadId = params?.threadId ?? threadId;
      recordCall({ protocol: "app-server", method, threadId, cwd: params?.cwd ?? process.cwd() });
      const sendResume = () => send({
        id,
        result: {
          thread: {
            id: threadId,
            sessionId: threadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "fake",
            createdAt: Math.floor(Date.now() / 1000),
            updatedAt: Math.floor(Date.now() / 1000),
            status: { type: "idle" },
            path: null,
            cwd: params?.cwd ?? process.cwd(),
            cliVersion: "fake",
            source: "vscode",
            threadSource: "subagent",
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
      const sendStarted = () =>
        send({ method: "thread/started", params: { thread: { id: threadId, cwd: params?.cwd ?? process.cwd(), turns: [] } } });
      const resumeDelayMs = numberMode("THREAD_RESUME_DELAY_MS");
      if (resumeDelayMs > 0) {
        setTimeout(() => {
          sendResume();
          sendStarted();
        }, resumeDelayMs);
      } else {
        sendResume();
        sendStarted();
      }
      return;
    }
    if (method === "turn/start") {
      activeTurn = `fake-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activePrompt = params?.input?.find?.((item) => item.type === "text")?.text ?? "";
      activeSteers = [];
      if (hasMode("TURN_START_ERROR")) {
        send({ id, error: { code: -32000, message: "fake turn start error" } });
        activeTurn = undefined;
        activePrompt = "";
        return;
      }
      recordCall({
        protocol: "app-server",
        method,
        prompt: activePrompt,
        threadId,
        turnId: activeTurn,
        outputSchema: params?.outputSchema,
      });
      if (hasMode("TURN_START_NO_RESPONSE")) {
        return;
      }
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
      if (hasMode("APP_SERVER_REQUEST")) {
        send({
          id: `fake-server-request-${Date.now()}`,
          method: "requestApproval",
          params: { threadId, turnId: activeTurn, reason: "fake approval request" },
        });
      }
      if (hasMode("APP_MALFORMED_JSON")) {
        process.stdout.write("this is not app-server json\n");
      }
      if (hasMode("APP_SERVER_ERROR")) {
        send({ method: "error", params: { message: "fake app-server error", threadId, turnId: activeTurn } });
      }
      const stderrChars = numberMode("APP_STDERR_CHARS");
      if (stderrChars > 0) {
        process.stderr.write("e".repeat(stderrChars));
      }
      const progressAfterMs = numberMode("APP_PROGRESS_AFTER_MS");
      if (progressAfterMs > 0) {
        setTimeout(() => {
          if (!activeTurn) return;
          send({
            method: "item/agentMessage/delta",
            params: { threadId, turnId: activeTurn, itemId: "item_progress", delta: "progress " },
          });
        }, progressAfterMs);
      }
      if (hasMode("APP_COMPLETE_INLINE")) {
        finishTurn();
        return;
      }
      if (hasMode("APP_EXIT_DURING_TURN")) {
        setTimeout(() => process.exit(2), 5);
        return;
      }
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
      if (steering.includes("APP_TURN_STEER_ERROR") || hasMode("APP_TURN_STEER_ERROR")) {
        send({ id, error: { code: -32000, message: "fake steer error" } });
        return;
      }
      activeSteers.push(steering);
      recordCall({ protocol: "app-server", method, prompt: steering, threadId, turnId: activeTurn });
      send({ id, result: { turnId: activeTurn } });
      return;
    }
    if (method === "turn/interrupt") {
      recordCall({ protocol: "app-server", method, threadId, turnId: activeTurn });
      if (hasMode("APP_TURN_INTERRUPT_ERROR")) {
        send({ id, error: { code: -32000, message: "fake interrupt error" } });
        return;
      }
      if (activeTimer) clearTimeout(activeTimer);
      const interrupted = activeTurn;
      activeTurn = undefined;
      send({ id, result: {} });
      if (hasMode("APP_IGNORE_INTERRUPT_COMPLETION")) return;
      if (interrupted) {
        sendTurnCompleted(interrupted, "interrupted");
      }
      return;
    }
    if (method === "thread/read") {
      recordCall({ protocol: "app-server", method, threadId, includeTurns: Boolean(params?.includeTurns) });
      if (hasMode("THREAD_READ_ERROR")) {
        send({ id, error: { code: -32000, message: "fake thread read error" } });
        return;
      }
      send({ id, result: { thread: { id: threadId, name: threadName, archived: threadArchived, turns: [] } } });
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

recordCall({ protocol: "exec", prompt });

if (prompt.includes("IGNORE_SIGTERM")) {
  process.on("SIGTERM", () => {
    recordCall({ protocol: "exec", method: "process/sigterm", prompt });
  });
} else {
  process.once("SIGTERM", () => {
    recordCall({ protocol: "exec", method: "process/sigterm", prompt });
    process.exit(143);
  });
}

const stdoutMatch = prompt.match(/BIG_STDOUT_CHARS=(\d+)/);
if (stdoutMatch) {
  process.stdout.write("x".repeat(Number(stdoutMatch[1])));
}

const unterminatedStdoutMatch = prompt.match(/UNTERMINATED_STDOUT_CHARS=(\d+)/);
if (unterminatedStdoutMatch) {
  await new Promise((resolve) => process.stdout.write("u".repeat(Number(unterminatedStdoutMatch[1])), resolve));
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
