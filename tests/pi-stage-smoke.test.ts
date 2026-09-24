import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * [T05-RED] Staged Pi host/package ABI smoke before private-release activation.
 *
 * Intended code-facing contract (no production change here):
 * - `smokeStagedPiRuntime({ piExecutable, stageDir, timeoutMs? }): Promise<{ commands: string[] }>`
 *   exported from `src/lib/pi-stage-smoke.ts`.
 * - `stageDir` is the isolated Pi agent dir produced by `stageVerifiedPiTarball`
 *   (`agentDir/stage-xxx/pi-agent`, private child of agentDir) with a `workspace`
 *   sibling under the same stageRoot. The smoke runs the real Pi CLI through
 *   `spawn` with `shell: false` and *only* sandbox `HOME`/`XDG_*`/`npm-cache`/
 *   `TMP*`/`PI_CODING_AGENT_DIR`/`PATH` derived from stageRoot — never the real
 *   user HOME nor inherited secrets/auth.
 * - Launches `pi --mode rpc --no-session --no-approve --offline --no-context-files`,
 *   sends the real Pi RPC requests `{ id, type: "get_state" | "get_commands" }`
 *   (one line-delimited JSON object per request, no LLM prompts, no auth), parses
 *   bounded line-delimited JSON responses shaped as the producer emits them
 *   (`{ type: "response", id, command: "get_state" | "get_commands", success: true,
 *   data: { ... } }` with commands at `data.commands: [{ name, source }]`), and
 *   rejects (`pi-stage-smoke: ...`) on a `{ type: "extension_error", ... }` record,
 *   malformed output, duplicate command names, id/command mismatch, or a missing
 *   required public command in `goal`, `subagents`, `permission-system`,
 *   `websearch`, `jorgex:header`. RPC stdout stays strict NDJSON; stderr stays
 *   bounded diagnostics where ONLY the exact known pi-web-access warning line
 *   (trimmed of CRLF) is tolerated — any other non-JSON stderr text or any JSON
 *   `extension_error` record still rejects. Stops the child safely including the
 *   process group on timeout and after success.
 *
 * Fixture notes:
 * - All paths live in an `os.tmpdir()` sandbox (never real HOME). The fake Pi is
 *   a Node script (`#!process.execPath`, chmod 755) that records its argv/env/cwd/
 *   stdin to a sibling `.capture.json` file, so the test observes isolation without
 *   the smoke forwarding a capture path. It parses the two stdin request ids/types
 *   and emits matching real RPC envelopes (never bare `{ name }` lines, which Pi
 *   RPC does not emit); invalid/missing/duplicate cases live inside
 *   `response.data.commands`, the malformed case is a `not-json` line, and the
 *   extension-error case is a `{ type: "extension_error", ... }` record. Command
 *   sources are synthetic `"fake-test"`; no real Pi CLI, no npm network, no LLM.
 * - The hang fake collects stdin, records the capture, spawns a grandchild that
 *   inherits the parent's process group (`detached: false`, stdio ignore) and
 *   records its pid, then hangs. A correct implementation kills its owned Pi
 *   process group (e.g. `process.kill(-piPid, "SIGTERM")` on POSIX) on timeout;
 *   killing only the parent would leak the same-group grandchild and fail the
 *   leak assertion. Detached escapes (separate groups) are out of scope:
 *   production must not scan /proc or kill unrelated processes.
 * - Symlinked Pi CLI (the real npm/global install shape: a `pi` symlink pointing
 *   at the package CLI file outside the stage) is permitted only when realpath
 *   resolves to a regular executable file; the target may live outside the stage.
 *   Broken, directory, or non-executable targets fail closed before any child
 *   spawn (no capture file is ever written).
 * - Real Pi 0.87.1 / pi-web-access@0.31 emits one human-readable diagnostic on
 *   stderr while RPC stdout stays JSON:
 *   `[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.`
 *   The stderr-warning fakes emit exactly that line (CRLF-terminated, to lock the
 *   trim); any other stderr text or stderr `extension_error` JSON must reject.
 * - Real native Pi 0.87.1 success against the current verified stage stays a manual
 *   environment gate (e.g. `JORGEX_PI_BIN`), not mandatory CI.
 */

type SmokeInput = {
  piExecutable: string;
  stageDir: string;
  timeoutMs?: number;
};

type SmokeResult = {
  commands: string[];
};

type PiStageSmokeModule = {
  smokeStagedPiRuntime(input: SmokeInput): Promise<SmokeResult>;
};

const smokeSpecifier = new URL("../src/lib/pi-stage-smoke.js", import.meta.url).href;

async function loadSmoke(): Promise<PiStageSmokeModule> {
  const mod = (await import(/* @vite-ignore */ smokeSpecifier)) as Partial<PiStageSmokeModule>;
  expect(
    mod.smokeStagedPiRuntime,
    "smokeStagedPiRuntime must be exported from src/lib/pi-stage-smoke.ts",
  ).toBeTypeOf("function");
  return mod as PiStageSmokeModule;
}

const REQUIRED_COMMANDS = ["goal", "subagents", "permission-system", "websearch", "jorgex:header"] as const;

const EXPECTED_ARGV = ["--mode", "rpc", "--no-session", "--no-approve", "--offline", "--no-context-files"] as const;

type FakeMode =
  | "valid"
  | "missing"
  | "extension_error"
  | "malformed"
  | "duplicate"
  | "hang"
  | "valid_with_known_stderr_warning"
  | "unexpected_stderr_text"
  | "stderr_extension_error";

const KNOWN_STDERR_WARNING =
  "[pi-web-access] Dynamic tool activation requires Pi 0.86.1 or newer; web tools remain eagerly available.";

type StageTopology = {
  sandbox: string;
  agentDir: string;
  stageRoot: string;
  stageDir: string;
  workspace: string;
};

type FakePi = {
  piExecutable: string;
  capturePath: string;
  grandchildPath: string;
};

const sandboxes: string[] = [];

afterEach(() => {
  delete process.env["JORGEX_SMOKE_SENTINEL"];
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isStrictChild(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function buildStageTopology(): StageTopology {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-smoke-"));
  sandboxes.push(sandbox);
  const agentDir = path.join(sandbox, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const stageRoot = fs.mkdtempSync(path.join(agentDir, "stage-"));
  try {
    fs.chmodSync(stageRoot, 0o700);
  } catch {
    // Best-effort on tmp; isolation assertions below are authoritative.
  }
  const stageDir = path.join(stageRoot, "pi-agent");
  const workspace = path.join(stageRoot, "workspace");
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { sandbox, agentDir, stageRoot, stageDir, workspace };
}

function fakeScriptBody(mode: FakeMode): string {
  if (mode === "hang") {
    return `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
process.stdin.resume();
function snapshotEnv() {
  return {
    HOME: process.env.HOME ?? "",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "",
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? "",
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TMP: process.env.TMP ?? "",
    TEMP: process.env.TEMP ?? "",
    npm_config_cache: process.env.npm_config_cache ?? "",
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "",
    PATH: process.env.PATH ?? "",
    JORGEX_SMOKE_SENTINEL: process.env.JORGEX_SMOKE_SENTINEL ?? "",
    NPM_TOKEN: process.env.NPM_TOKEN ?? "",
    GH_TOKEN: process.env.GH_TOKEN ?? ""
  };
}
function writeCapture(stdin) {
  const payload = { pid: process.pid, args: process.argv.slice(2), env: snapshotEnv(), cwd: process.cwd(), stdin };
  try { fs.writeFileSync(capturePath, JSON.stringify(payload)); } catch {}
}
setTimeout(() => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  writeCapture(stdin);
  try {
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], { detached: false, stdio: "ignore" });
    g.unref();
    try { fs.writeFileSync(capturePath + ".grandchild", String(g.pid)); } catch {}
  } catch {}
}, 120);
setInterval(() => {}, 1000);
`;
  }
  return `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
process.stdin.resume();
function snapshotEnv() {
  return {
    HOME: process.env.HOME ?? "",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "",
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? "",
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TMP: process.env.TMP ?? "",
    TEMP: process.env.TEMP ?? "",
    npm_config_cache: process.env.npm_config_cache ?? "",
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "",
    PATH: process.env.PATH ?? "",
    JORGEX_SMOKE_SENTINEL: process.env.JORGEX_SMOKE_SENTINEL ?? "",
    NPM_TOKEN: process.env.NPM_TOKEN ?? "",
    GH_TOKEN: process.env.GH_TOKEN ?? ""
  };
}
const MODE = ${JSON.stringify(mode)};
const REQUIRED = ${JSON.stringify([...REQUIRED_COMMANDS])};
setTimeout(() => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const payload = { pid: process.pid, args: process.argv.slice(2), env: snapshotEnv(), cwd: process.cwd(), stdin };
  try { fs.writeFileSync(capturePath, JSON.stringify(payload)); } catch {}
  const lines = stdin.split("\\n").map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) { try { parsed.push(JSON.parse(line)); } catch {} }
  const findId = (t) => {
    const req = parsed.find((p) => p && p.type === t && typeof p.id !== "undefined");
    return req ? req.id : (t === "get_state" ? 1 : 2);
  };
  const stateId = findId("get_state");
  const commandsId = findId("get_commands");
  const withSource = (names) => names.map((name) => ({ name, source: "fake-test" }));
  const stateLine = JSON.stringify({ type: "response", id: stateId, command: "get_state", success: true, data: { ok: true } });
  const commandsLine = (names) => JSON.stringify({ type: "response", id: commandsId, command: "get_commands", success: true, data: { commands: withSource(names) } });
  const stderrWarningLine = ${JSON.stringify(KNOWN_STDERR_WARNING + "\r\n")};
  let out = "";
  let errOut = "";
  if (MODE === "valid") out = stateLine + "\\n" + commandsLine(REQUIRED) + "\\n";
  else if (MODE === "missing") out = stateLine + "\\n" + commandsLine(REQUIRED.filter((n) => n !== "websearch")) + "\\n";
  else if (MODE === "duplicate") out = stateLine + "\\n" + commandsLine([...REQUIRED, "goal"]) + "\\n";
  else if (MODE === "extension_error") out = stateLine + "\\n" + JSON.stringify({ type: "extension_error", id: commandsId, command: "get_commands", success: false, error: { message: "boom" } }) + "\\n";
  else if (MODE === "malformed") out = "not-json\\n" + stateLine + "\\n" + commandsLine(REQUIRED) + "\\n";
  else if (MODE === "valid_with_known_stderr_warning") { out = stateLine + "\\n" + commandsLine(REQUIRED) + "\\n"; errOut = stderrWarningLine; }
  else if (MODE === "unexpected_stderr_text") { out = stateLine + "\\n" + commandsLine(REQUIRED) + "\\n"; errOut = "[pi-web-access] unexpected diagnostic boom\\n"; }
  else if (MODE === "stderr_extension_error") { out = stateLine + "\\n" + commandsLine(REQUIRED) + "\\n"; errOut = JSON.stringify({ type: "extension_error", id: commandsId, command: "get_commands", success: false, error: { message: "boom" } }) + "\\n"; }
  // Stderr first so the diagnostic is already buffered when stdout completes;
  // otherwise a valid-stdout-first race could settle success before stderr lands.
  process.stderr.write(errOut, () => process.stdout.write(out, () => process.exit(0)));
}, 120);
`;
}

function writeFakePi(topology: StageTopology, mode: FakeMode): FakePi {
  const binDir = path.join(topology.stageRoot, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const isWindows = process.platform === "win32";
  const base = path.join(binDir, `fake-pi-${mode}`);
  if (isWindows) {
    const mjs = `${base}.mjs`;
    const cmd = `${base}.cmd`;
    const body = `import fs from "node:fs";\nimport { spawn } from "node:child_process";\nconst capturePath = process.argv[1] + ".capture.json";\n${fakeScriptBody(mode)}`;
    fs.writeFileSync(mjs, body, "utf8");
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0\\${path.basename(mjs)}" %*\r\n`, "utf8");
    const capturePath = `${mjs}.capture.json`;
    return { piExecutable: cmd, capturePath, grandchildPath: `${capturePath}.grandchild` };
  }
  const bin = base;
  const body = `#!${process.execPath}\nimport fs from "node:fs";\nimport { spawn } from "node:child_process";\nconst capturePath = process.argv[1] + ".capture.json";\n${fakeScriptBody(mode)}`;
  fs.writeFileSync(bin, body, "utf8");
  fs.chmodSync(bin, 0o755);
  const capturePath = `${bin}.capture.json`;
  return { piExecutable: bin, capturePath, grandchildPath: `${capturePath}.grandchild` };
}

function writeExternalFakeExecutable(mode: FakeMode): string {
  // Global provider binaries intentionally live outside the stage, so the
  // symlink success case resolves its target here rather than under stageRoot.
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-smoke-ext-"));
  sandboxes.push(externalDir);
  const target = path.join(externalDir, `fake-pi-${mode}-target`);
  const body = `#!${process.execPath}\nimport fs from "node:fs";\nimport { spawn } from "node:child_process";\nconst capturePath = process.argv[1] + ".capture.json";\n${fakeScriptBody(mode)}`;
  fs.writeFileSync(target, body, "utf8");
  fs.chmodSync(target, 0o755);
  return target;
}

type CapturedCall = {
  pid: number;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
};

function readCapture(capturePath: string): CapturedCall {
  const raw = fs.readFileSync(capturePath, "utf8");
  const parsed = JSON.parse(raw) as CapturedCall;
  expect(parsed.pid).toBeTypeOf("number");
  expect(parsed.args).toBeInstanceOf(Array);
  expect(parsed.env).toBeTypeOf("object");
  expect(parsed.cwd).toBeTypeOf("string");
  expect(parsed.stdin).toBeTypeOf("string");
  return parsed;
}

function expectRpcRequests(stdin: string): void {
  // The smoke sends the two read-only RPCs as line-delimited `{ id, type }`
  // requests and never an LLM prompt or auth payload.
  expect(stdin).toContain("get_state");
  expect(stdin).toContain("get_commands");
  const lines = stdin
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    parsed.push(JSON.parse(line) as Record<string, unknown>);
  }
  const states = parsed.filter((entry) => entry["type"] === "get_state");
  const commands = parsed.filter((entry) => entry["type"] === "get_commands");
  expect(states.length).toBeGreaterThanOrEqual(1);
  expect(commands.length).toBeGreaterThanOrEqual(1);
  const stateId = (states[0] as Record<string, unknown>)["id"];
  const commandsId = (commands[0] as Record<string, unknown>)["id"];
  expect(stateId).toBeDefined();
  expect(commandsId).toBeDefined();
  expect(stateId).not.toBe(commandsId);
  const lowered = stdin.toLowerCase();
  expect(lowered).not.toContain("prompt");
  expect(lowered).not.toContain("llm");
  expect(lowered).not.toContain("auth");
}

function expectSandboxIsolation(captured: CapturedCall, topology: StageTopology, sentinel: string): void {
  expect(captured.args).toEqual([...EXPECTED_ARGV]);
  expect(captured.env["PI_CODING_AGENT_DIR"]).toBe(topology.stageDir);
  expect(captured.cwd).toBe(topology.workspace);

  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "npm_config_cache"] as const) {
    const value = captured.env[key];
    expect(value, `${key} must be stage-isolated`).toBeTypeOf("string");
    expect(value).not.toBe("");
    expect(isStrictChild(topology.stageRoot, value as string), `${key} must live under the stage root`).toBe(true);
  }
  const tmp = captured.env["TMPDIR"] ?? captured.env["TMP"] ?? captured.env["TEMP"] ?? "";
  expect(tmp).not.toBe("");
  expect(isStrictChild(topology.stageRoot, tmp), "TMP must live under the stage root").toBe(true);

  const realHome = process.env["HOME"] ?? "__no_home__";
  expect(captured.env["HOME"]).not.toBe(realHome);
  expect(isStrictChild(topology.stageRoot, captured.cwd), "cwd must live under the stage root").toBe(true);

  expect(captured.env["PATH"]).toBeTypeOf("string");
  expect(captured.env["PATH"]).not.toBe("");
  // The sandbox PATH must be constructed from the stage, never inherited verbatim.
  // It must at least route the current node directory like the stage runtime does.
  expect(captured.env["PATH"]).toContain(path.dirname(process.execPath));
  expect(captured.env["PATH"]).not.toBe(process.env["PATH"] ?? "__no_path__");

  // No inherited secrets/auth reach the staged Pi process.
  expect(captured.env["JORGEX_SMOKE_SENTINEL"] ?? "").not.toContain(sentinel);
  expect(captured.env["JORGEX_SMOKE_SENTINEL"] ?? "").toBe("");
  expect(captured.stdin).not.toContain(sentinel);

  expectRpcRequests(captured.stdin);
}

function expectPidDead(pid: number, label: string): void {
  expect(Number.isSafeInteger(pid) && pid > 0, `${label} must record a valid pid`).toBe(true);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      alive = true;
    } else {
      expect(code, `${label} pid probe must report ESRCH when dead`).toBe("ESRCH");
    }
  }
  expect(alive, `${label} pid ${pid} must not leak`).toBe(false);
}

describe("[T05-RED] staged Pi host/package ABI smoke before activation", () => {
  it("returns the required public commands through an isolated rpc launch with no leaks", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "valid");
    const sentinel = `jx-sentinel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    process.env["JORGEX_SMOKE_SENTINEL"] = sentinel;

    const result = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    });

    expect([...result.commands].sort()).toEqual([...REQUIRED_COMMANDS].sort());

    const captured = readCapture(fake.capturePath);
    expectSandboxIsolation(captured, topology, sentinel);
    expectPidDead(captured.pid, "smoke child");
    expect(fs.existsSync(fake.grandchildPath)).toBe(false);
  });

  it("fails closed when a required public command is missing", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "missing");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-missing-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });

  it("fails closed on extension_error", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "extension_error");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-ext-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });

  it("fails closed on malformed line-delimited JSON", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "malformed");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-malformed-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });

  it("fails closed on duplicate command names", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "duplicate");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-dup-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });

  it("fails closed on timeout and stops the whole process group with no leaks", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "hang");
    const sentinel = `jx-sentinel-hang-${Date.now()}`;
    process.env["JORGEX_SMOKE_SENTINEL"] = sentinel;

    const startedAt = Date.now();
    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 400,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const elapsed = Date.now() - startedAt;
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
    expect(elapsed).toBeLessThan(5000);

    const captured = readCapture(fake.capturePath);
    expectSandboxIsolation(captured, topology, sentinel);
    expectPidDead(captured.pid, "timed-out smoke child");
    if (fs.existsSync(fake.grandchildPath)) {
      const grandchildPid = Number(fs.readFileSync(fake.grandchildPath, "utf8").trim());
      expectPidDead(grandchildPid, "timed-out smoke grandchild");
    } else {
      // The hang fake always records a grandchild when it starts; its absence
      // means the fake never started and the timeout did not exercise group kill.
      expect.unreachable("hang fake must record a grandchild pid to prove group termination");
    }
  });

  it.skipIf(process.platform === "win32")("accepts a symlinked Pi CLI resolving to a regular executable file outside the stage", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const target = writeExternalFakeExecutable("valid");
    const linkPath = path.join(topology.stageRoot, "pi-link");
    fs.symlinkSync(target, linkPath);
    const linkCapture = `${linkPath}.capture.json`;
    const sentinel = `jx-sentinel-link-${Date.now()}`;
    process.env["JORGEX_SMOKE_SENTINEL"] = sentinel;

    const result = await smokeStagedPiRuntime({
      piExecutable: linkPath,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    });

    expect([...result.commands].sort()).toEqual([...REQUIRED_COMMANDS].sort());

    const captured = readCapture(linkCapture);
    expectSandboxIsolation(captured, topology, sentinel);
    expectPidDead(captured.pid, "smoke child via symlink");
    expect(fs.existsSync(`${linkCapture}.grandchild`)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fails closed on a broken Pi CLI symlink before any child spawn", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const linkPath = path.join(topology.stageRoot, "pi-broken-link");
    fs.symlinkSync(path.join(topology.stageRoot, "no-such-pi-target"), linkPath);
    const linkCapture = `${linkPath}.capture.json`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: linkPath,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
    expect(fs.existsSync(linkCapture)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fails closed on a Pi CLI symlink resolving to a directory before any child spawn", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const dirTarget = path.join(topology.stageRoot, "pi-dir-target");
    fs.mkdirSync(dirTarget, { recursive: true });
    const linkPath = path.join(topology.stageRoot, "pi-dir-link");
    fs.symlinkSync(dirTarget, linkPath);
    const linkCapture = `${linkPath}.capture.json`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: linkPath,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
    expect(fs.existsSync(linkCapture)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fails closed on a Pi CLI symlink resolving to a non-executable file before any child spawn", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const plain = path.join(topology.stageRoot, "pi-plain");
    fs.writeFileSync(plain, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(plain, 0o644);
    const linkPath = path.join(topology.stageRoot, "pi-noexec-link");
    fs.symlinkSync(plain, linkPath);
    const linkCapture = `${linkPath}.capture.json`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: linkPath,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
    expect(fs.existsSync(linkCapture)).toBe(false);
  });

  it("accepts valid RPC stdout with the known pi-web-access stderr warning", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "valid_with_known_stderr_warning");
    const sentinel = `jx-sentinel-stderr-known-${Date.now()}`;
    process.env["JORGEX_SMOKE_SENTINEL"] = sentinel;

    const result = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    });

    expect([...result.commands].sort()).toEqual([...REQUIRED_COMMANDS].sort());

    const captured = readCapture(fake.capturePath);
    expectSandboxIsolation(captured, topology, sentinel);
    expectPidDead(captured.pid, "smoke child");
    expect(fs.existsSync(fake.grandchildPath)).toBe(false);
  });

  it("fails closed on unexpected stderr text alongside valid RPC stdout", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "unexpected_stderr_text");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-stderr-unexpected-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });

  it("fails closed on an extension_error JSON record on stderr", async () => {
    const { smokeStagedPiRuntime } = await loadSmoke();
    const topology = buildStageTopology();
    const fake = writeFakePi(topology, "stderr_extension_error");
    process.env["JORGEX_SMOKE_SENTINEL"] = `jx-sentinel-stderr-ext-${Date.now()}`;

    const failure = await smokeStagedPiRuntime({
      piExecutable: fake.piExecutable,
      stageDir: topology.stageDir,
      timeoutMs: 5000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-stage-smoke:/);
  });
});
