import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { planDetectedBinCommand } from "./detect.js";

export interface PiStageSmokeInput {
  piExecutable: string;
  stageDir: string;
  timeoutMs?: number;
}

export interface PiStageSmokeResult {
  commands: string[];
}

const REQUIRED_COMMANDS = ["goal", "subagents", "permission-system", "websearch", "jorgex:header"] as const;
const EXPECTED_ARGV = ["--mode", "rpc", "--no-session", "--no-approve", "--offline", "--no-context-files"] as const;
const KNOWN_STDERR_WARNING =
  "[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.";
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 200;
const READY_GRACE_MS = 250;
const TASKKILL_TIMEOUT_MS = 2_000;

function fail(message: string): never {
  throw new Error(`pi-stage-smoke: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function assertPiExecutable(piExecutable: string): string {
  const absolute = path.resolve(piExecutable);
  const linkStat = lstatOrNull(absolute);
  if (linkStat === null) {
    fail(`piExecutable must exist: ${piExecutable}`);
  }
  if (linkStat.isSymbolicLink()) {
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      fail(`piExecutable symlink is broken: ${piExecutable}`);
    }
    let targetStat: fs.Stats;
    try {
      targetStat = fs.statSync(real);
    } catch {
      fail(`piExecutable symlink target is missing: ${piExecutable}`);
    }
    if (!targetStat.isFile()) {
      fail(`piExecutable symlink must resolve to a regular file: ${piExecutable}`);
    }
    if (process.platform !== "win32") {
      try {
        fs.accessSync(real, fs.constants.X_OK);
      } catch {
        fail(`piExecutable symlink target is not executable: ${piExecutable}`);
      }
    }
    return absolute;
  }
  if (!linkStat.isFile()) {
    fail(`piExecutable must be a regular file: ${piExecutable}`);
  }
  if (process.platform !== "win32") {
    try {
      fs.accessSync(absolute, fs.constants.X_OK);
    } catch {
      fail(`piExecutable is not executable: ${piExecutable}`);
    }
  }
  return absolute;
}

function assertRealDir(p: string, label: string): string {
  const resolved = path.resolve(p);
  const st = lstatOrNull(resolved);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${p}`);
  }
  return resolved;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function runtimePath(piExecutable: string): string {
  const entries =
    process.platform === "win32"
      ? [
          path.dirname(piExecutable),
          path.dirname(process.execPath),
          process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : null,
        ]
      : [path.dirname(piExecutable), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(entries.filter((entry): entry is string => entry !== null))].join(path.delimiter);
}

function buildSandboxEnv(stageRoot: string, stageDir: string, piExecutable: string): Record<string, string> {
  const home = path.join(stageRoot, "home");
  const appdata = path.join(stageRoot, "appdata");
  const localappdata = path.join(stageRoot, "localappdata");
  const xdgConfig = path.join(stageRoot, "xdg-config");
  const xdgData = path.join(stageRoot, "xdg-data");
  const xdgCache = path.join(stageRoot, "xdg-cache");
  const temporary = path.join(stageRoot, "tmp");
  const npmCache = path.join(stageRoot, "npm-cache");
  for (const dir of [home, appdata, localappdata, xdgConfig, xdgData, xdgCache, temporary, npmCache]) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      fail(`cannot prepare isolated stage dir: ${dir}`);
    }
  }
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    npm_config_cache: npmCache,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PI_CODING_AGENT_DIR: stageDir,
    PI_OFFLINE: "1",
    PATH: runtimePath(piExecutable),
  };
  if (process.platform === "win32") {
    const allow = ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "OS"] as const;
    for (const key of allow) {
      const value = process.env[key];
      if (typeof value === "string" && value !== "" && env[key] === undefined) {
        env[key] = value;
      }
    }
  }
  return env;
}

function groupAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function destroyChild(child: ChildProcess): void {
  try {
    child.stdin?.destroy();
  } catch {
    // Ignore teardown errors.
  }
  try {
    child.stdout?.destroy();
  } catch {
    // Ignore teardown errors.
  }
  try {
    child.stderr?.destroy();
  } catch {
    // Ignore teardown errors.
  }
  try {
    child.unref();
  } catch {
    // Ignore teardown errors.
  }
}

async function stopOwned(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    destroyChild(child);
    return;
  }
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
      spawnSync(taskkill, ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        timeout: TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      // Fall through to SIGKILL below.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    destroyChild(child);
    return;
  }
  if (!groupAlive(pid)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    destroyChild(child);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already exited; fall through to SIGKILL check.
  }
  await sleep(KILL_GRACE_MS);
  if (!groupAlive(pid)) {
    destroyChild(child);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already exited.
  }
  await sleep(KILL_GRACE_MS);
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  destroyChild(child);
}

type ParsedOutcome =
  | { kind: "pending" }
  | { kind: "ready"; commands: string[] }
  | { kind: "failed"; message: string };

function validateCommandsData(value: unknown): { ok: true; names: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value)) return { ok: false, message: "get_commands data.commands must be an array" };
  const names: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || (entry["name"] as string) === "") {
      return { ok: false, message: "get_commands entry must carry a non-empty name" };
    }
    names.push(entry["name"] as string);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return { ok: false, message: `duplicate command name: ${name}` };
    seen.add(name);
  }
  const missing = [...REQUIRED_COMMANDS].filter((required) => !seen.has(required));
  if (missing.length > 0) return { ok: false, message: `missing required commands: ${missing.join(", ")}` };
  return { ok: true, names };
}

function evaluateLines(lines: unknown[], stateId: number, commandsId: number): ParsedOutcome {
  let stateSeen = false;
  let commandsNames: string[] | null = null;
  for (const entry of lines) {
    if (!isRecord(entry)) continue;
    const type = entry["type"];
    if (type === "extension_error") {
      const detail = isRecord(entry["error"]) && typeof entry["error"]["message"] === "string"
        ? (entry["error"]["message"] as string)
        : "extension error";
      const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
      return { kind: "failed", message: `extension_error: ${trimmed}` };
    }
    if (type !== "response") continue;
    const id = entry["id"];
    if (id !== stateId && id !== commandsId) continue;
    const command = entry["command"];
    const success = entry["success"];
    if (id === stateId) {
      if (command !== "get_state" || success !== true) {
        return { kind: "failed", message: "unexpected get_state response" };
      }
      if (!isRecord(entry["data"])) {
        return { kind: "failed", message: "get_state response misses data" };
      }
      stateSeen = true;
      continue;
    }
    if (command !== "get_commands" || success !== true) {
      return { kind: "failed", message: "unexpected get_commands response" };
    }
    if (!isRecord(entry["data"])) {
      return { kind: "failed", message: "get_commands response misses data" };
    }
    const checked = validateCommandsData(entry["data"]["commands"]);
    if (!checked.ok) return { kind: "failed", message: checked.message };
    commandsNames = checked.names;
  }
  if (stateSeen && commandsNames !== null) return { kind: "ready", commands: commandsNames };
  return { kind: "pending" };
}

function parseCompleteLines(buffer: string): { lines: unknown[]; malformed: string | null } {
  const lines: unknown[] = [];
  const parts = buffer.split("\n");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    try {
      lines.push(JSON.parse(trimmed) as unknown);
    } catch {
      return { lines, malformed: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed };
    }
  }
  return { lines, malformed: null };
}

function parseStderrComplete(
  buffer: string,
): { lines: unknown[]; rejected: string | null } {
  const lines: unknown[] = [];
  const parts = buffer.split("\n");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (trimmed === KNOWN_STDERR_WARNING) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { lines, rejected: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed };
    }
    lines.push(parsed);
  }
  return { lines, rejected: null };
}

function completeSlice(buffer: string, final: boolean): string {
  if (final) return buffer;
  const idx = buffer.lastIndexOf("\n");
  if (idx < 0) return "";
  return buffer.slice(0, idx + 1);
}

export async function smokeStagedPiRuntime(input: PiStageSmokeInput): Promise<PiStageSmokeResult> {
  try {
    return await runSmoke(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pi-stage-smoke: ")) throw error;
    throw new Error(`pi-stage-smoke: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runSmoke(input: PiStageSmokeInput): Promise<PiStageSmokeResult> {
  if (!isRecord(input)) fail("input must be an object");
  const { piExecutable, stageDir, timeoutMs } = input as Record<string, unknown>;
  if (typeof piExecutable !== "string" || piExecutable === "" || !path.isAbsolute(piExecutable)) {
    fail("piExecutable must be a non-empty absolute path");
  }
  if (typeof stageDir !== "string" || stageDir === "" || !path.isAbsolute(stageDir)) {
    fail("stageDir must be a non-empty absolute path");
  }
  const piResolved = assertPiExecutable(piExecutable as string);
  const stageResolved = assertRealDir(stageDir as string, "stageDir");
  if (path.basename(stageResolved) !== "pi-agent") {
    fail("stageDir must be the staged pi-agent dir (stageRoot/pi-agent)");
  }
  const stageRoot = path.dirname(stageResolved);
  const stageRootStat = lstatOrNull(stageRoot);
  if (stageRootStat === null || !stageRootStat.isDirectory() || stageRootStat.isSymbolicLink()) {
    fail("stageRoot must be a real directory");
  }
  if (!path.basename(stageRoot).startsWith("stage-")) {
    fail("stageRoot must be a private stage- dir");
  }
  const workspace = path.join(stageRoot, "workspace");
  assertRealDir(workspace, "stage workspace");

  let timeout = DEFAULT_TIMEOUT_MS;
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      fail("timeoutMs must be a positive safe integer");
    }
    timeout = timeoutMs as number;
  }
  if (timeout > 2_147_483_647) fail("timeoutMs exceeds platform bound");

  const env = buildSandboxEnv(stageRoot, stageResolved, piResolved);
  const planned = planDetectedBinCommand(piResolved, [...EXPECTED_ARGV]);
  if (planned === null) fail("unsafe executable for Windows launch");

  const stateId = 1;
  const commandsId = 2;
  const requests = `${JSON.stringify({ id: stateId, type: "get_state" })}\n${JSON.stringify({ id: commandsId, type: "get_commands" })}\n`;

  return await new Promise<PiStageSmokeResult>((resolve, reject) => {
    let settled = false;
    let stdoutText = "";
    let stderrText = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let readyTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      readyTimer = undefined;
    };

    const settleFailure = async (message: string): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const owned = child;
      if (owned !== undefined) await stopOwned(owned);
      reject(new Error(`pi-stage-smoke: ${message}`));
    };

    const settleSuccess = async (commands: string[]): Promise<void> => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const owned = child;
      if (owned !== undefined) await stopOwned(owned);
      resolve({ commands });
    };

    const checkBuffers = (final: boolean): ParsedOutcome | { kind: "malformed"; message: string } => {
      const stdoutParts = completeSlice(stdoutText, final);
      const stderrParts = completeSlice(stderrText, final);
      if (!final && !stdoutText.includes("\n") && !stderrText.includes("\n")) {
        return { kind: "pending" };
      }
      const out = parseCompleteLines(stdoutParts);
      if (out.malformed !== null) return { kind: "malformed", message: `malformed line-delimited JSON: ${out.malformed}` };
      const err = parseStderrComplete(stderrParts);
      if (err.rejected !== null) return { kind: "malformed", message: `unexpected stderr text: ${err.rejected}` };
      return evaluateLines([...out.lines, ...err.lines], stateId, commandsId);
    };

    const scheduleReady = (): void => {
      if (settled) return;
      if (readyTimer !== undefined) {
        readyTimer.refresh();
        return;
      }
      readyTimer = setTimeout(() => {
        readyTimer = undefined;
        if (settled) return;
        const outcome = checkBuffers(false);
        if (outcome.kind === "malformed") {
          void settleFailure(outcome.message);
          return;
        }
        if (outcome.kind === "failed") {
          void settleFailure(outcome.message);
          return;
        }
        if (outcome.kind === "ready") {
          void settleSuccess(outcome.commands);
          return;
        }
        // Stdout no longer ready (should not happen without new data); wait.
      }, READY_GRACE_MS);
      if (typeof readyTimer.unref === "function") readyTimer.unref();
    };

    const cancelReady = (): void => {
      if (readyTimer !== undefined) clearTimeout(readyTimer);
      readyTimer = undefined;
    };

    const onData = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (settled) return;
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          cancelReady();
          void settleFailure("output exceeds bound");
          return;
        }
        stdoutText += chunk.toString("utf8");
      } else {
        stderrBytes += chunk.length;
        if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
          cancelReady();
          void settleFailure("output exceeds bound");
          return;
        }
        stderrText += chunk.toString("utf8");
      }
      const outcome = checkBuffers(false);
      if (outcome.kind === "malformed") {
        cancelReady();
        void settleFailure(outcome.message);
        return;
      }
      if (outcome.kind === "failed") {
        cancelReady();
        void settleFailure(outcome.message);
        return;
      }
      if (outcome.kind === "ready") {
        scheduleReady();
      } else {
        cancelReady();
      }
    };

    let spawned: ChildProcess;
    try {
      spawned = spawn(planned.command, planned.args, {
        cwd: workspace,
        env,
        shell: false,
        detached: process.platform === "win32" ? false : true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      void settleFailure(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    child = spawned;

    timeoutTimer = setTimeout(() => {
      void settleFailure(`timed out after ${timeout}ms`);
    }, timeout);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

    spawned.stdout?.on("data", (chunk: Buffer) => onData("stdout", Buffer.from(chunk)));
    spawned.stderr?.on("data", (chunk: Buffer) => onData("stderr", Buffer.from(chunk)));

    spawned.once("error", (error: Error) => {
      void settleFailure(`spawn failed: ${error.message}`);
    });

    spawned.once("close", () => {
      if (settled) return;
      const outcome = checkBuffers(true);
      if (outcome.kind === "malformed") {
        void settleFailure(outcome.message);
        return;
      }
      if (outcome.kind === "failed") {
        void settleFailure(outcome.message);
        return;
      }
      if (outcome.kind === "ready") {
        void settleSuccess(outcome.commands);
        return;
      }
      void settleFailure("incomplete rpc responses before exit");
    });

    try {
      spawned.stdin?.write(requests);
      spawned.stdin?.end();
    } catch (error) {
      void settleFailure(`stdin failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
