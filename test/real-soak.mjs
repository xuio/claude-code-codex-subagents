#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const rounds = Number(process.env.CODEX_SUBAGENTS_REAL_SOAK_ROUNDS ?? "3");
if (!Number.isInteger(rounds) || rounds < 1) {
  throw new Error("CODEX_SUBAGENTS_REAL_SOAK_ROUNDS must be a positive integer.");
}

const includeRealCodexEveryRound = process.env.CODEX_SUBAGENTS_REAL_SOAK_FULL === "1";
const scenarios = [
  {
    name: "real app-server steering",
    command: [process.execPath, "test/real-app-server-steering.mjs"],
    run: () => true,
  },
  {
    name: "real Claude persistent session",
    command: [process.execPath, "test/claude-real-session.mjs"],
    run: () => true,
  },
  {
    name: "real Claude to real Codex",
    command: [process.execPath, "test/claude-real-codex.mjs"],
    run: (round) => includeRealCodexEveryRound || round === 1 || round === rounds,
  },
];

const summary = [];
const started = performance.now();

for (let round = 1; round <= rounds; round += 1) {
  console.log(`\n=== Real soak round ${round}/${rounds} ===`);
  for (const scenario of scenarios) {
    if (!scenario.run(round)) continue;
    const scenarioStarted = performance.now();
    console.log(`\n--- ${scenario.name} ---`);
    const [command, ...args] = scenario.command;
    const result = spawnSync(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_SUBAGENTS_REAL_SOAK_ROUND: String(round),
        CODEX_SUBAGENTS_SESSION_STATE_FILE: path.join(os.tmpdir(), `codex-subagents-real-soak-${process.pid}-${round}.sessions.json`),
      },
    });
    const durationMs = Math.round(performance.now() - scenarioStarted);
    summary.push({
      round,
      scenario: scenario.name,
      status: result.status,
      signal: result.signal,
      durationMs,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error("\nReal soak failed:");
      console.error(JSON.stringify(summary, null, 2));
      process.exit(result.status ?? 1);
    }
  }
}

console.log("\nReal soak passed:");
console.log(JSON.stringify({
  rounds,
  includeRealCodexEveryRound,
  durationMs: Math.round(performance.now() - started),
  runs: summary,
}, null, 2));
