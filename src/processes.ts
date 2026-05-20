import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSensitiveText } from "./redaction.js";

const execFileAsync = promisify(execFile);
const staleCpuThresholdPct = 25;

export type PluginProcessSnapshot = {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  cpuPct: number;
  elapsed: string;
  command: string;
};

export type PluginProcessDiagnostics = {
  supported: boolean;
  currentPid: number;
  pluginProcesses: PluginProcessSnapshot[];
  staleSuspects: PluginProcessSnapshot[];
  highCpuStaleSuspects: PluginProcessSnapshot[];
  error?: string;
};

function sanitizeCommand(command: string): string {
  const redacted = redactSensitiveText(command);
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 500)}...`;
}

export function parsePsProcessLine(line: string): PluginProcessSnapshot | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([0-9.]+)\s+(\S+)\s+(.+)$/);
  if (!match) return undefined;
  const [, pid, ppid, pgid, stat, cpuPct, elapsed, command] = match;
  if (!pid || !ppid || !pgid || !stat || !cpuPct || !elapsed || !command) return undefined;
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    pgid: Number(pgid),
    stat,
    cpuPct: Number(cpuPct),
    elapsed,
    command: sanitizeCommand(command),
  };
}

function isPluginProcess(command: string): boolean {
  return command.includes("codex-subagents") && command.includes("dist/index.js");
}

export function pluginProcessDiagnosticsFromSnapshots(
  snapshots: PluginProcessSnapshot[],
  currentPid = process.pid,
): PluginProcessDiagnostics {
  const pluginProcesses = snapshots.filter((snapshot) => isPluginProcess(snapshot.command));
  const staleSuspects = pluginProcesses.filter((snapshot) => snapshot.pid !== currentPid && snapshot.ppid === 1);
  return {
    supported: true,
    currentPid,
    pluginProcesses,
    staleSuspects,
    highCpuStaleSuspects: staleSuspects.filter((snapshot) => snapshot.cpuPct >= staleCpuThresholdPct),
  };
}

export async function detectPluginProcesses(): Promise<PluginProcessDiagnostics> {
  if (process.platform === "win32") {
    return {
      supported: false,
      currentPid: process.pid,
      pluginProcesses: [],
      staleSuspects: [],
      highCpuStaleSuspects: [],
      error: "process scan is not implemented on Windows",
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,%cpu=,etime=,command="],
      { timeout: 1_000, maxBuffer: 1_000_000, encoding: "utf8" },
    );
    const snapshots = stdout
      .split("\n")
      .map((line) => parsePsProcessLine(line))
      .filter((snapshot): snapshot is PluginProcessSnapshot => Boolean(snapshot));
    return pluginProcessDiagnosticsFromSnapshots(snapshots);
  } catch (error) {
    return {
      supported: false,
      currentPid: process.pid,
      pluginProcesses: [],
      staleSuspects: [],
      highCpuStaleSuspects: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
