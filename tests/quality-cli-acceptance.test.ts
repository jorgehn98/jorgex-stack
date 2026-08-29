import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const CLI_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 30_000;
const TREE_KILL_TIMEOUT_MS = 1_000;
const CLI_KILL_GRACE_MS = 250;
const WINDOWS_SHELL_METACHARACTERS = /["%&|<>^!`()\r\n]/;
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

type ProcessInvocation = {
  command: string;
  args: string[];
};

type BoundedProcessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
};

function resolveWindowsPnpmShim(): string | undefined {
  const result = spawnSync("where.exe", ["pnpm.cmd"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return undefined;

  const pnpmShim = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (
    pnpmShim === undefined
    || !fs.existsSync(pnpmShim)
    || WINDOWS_SHELL_METACHARACTERS.test(pnpmShim)
  ) {
    return undefined;
  }
  return pnpmShim;
}

function resolveBuildInvocation(): ProcessInvocation {
  const nodeDirectory = path.dirname(process.execPath);
  const corepackScript = [
    path.join(nodeDirectory, "node_modules", "corepack", "dist", "corepack.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "corepack", "dist", "corepack.js"),
  ].find((candidate) => fs.existsSync(candidate));

  if (corepackScript !== undefined) {
    return { command: process.execPath, args: [corepackScript, "pnpm", "build"] };
  }

  if (process.platform === "win32") {
    const corepackShim = path.join(nodeDirectory, "corepack.cmd");
    if (fs.existsSync(corepackShim) && !WINDOWS_SHELL_METACHARACTERS.test(corepackShim)) {
      const comspec = process.env.ComSpec
        ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      return {
        command: comspec,
        args: ["/d", "/s", "/c", `"${corepackShim}" pnpm build`],
      };
    }

    const pnpmShim = resolveWindowsPnpmShim();
    if (pnpmShim !== undefined) {
      const comspec = process.env.ComSpec
        ?? process.env.COMSPEC
        ?? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "cmd.exe");
      return {
        command: comspec,
        args: ["/d", "/s", "/c", `"${pnpmShim}" build`],
      };
    }
  } else {
    return { command: "pnpm", args: ["build"] };
  }

  throw new Error(`No se pudo resolver Corepack ni pnpm.cmd desde ${process.execPath}`);
}

async function buildDist(): Promise<void> {
  const invocation = resolveBuildInvocation();
  let result: BoundedProcessResult;
  try {
    result = await runBoundedProcess(invocation, {
      cwd: REPO_ROOT,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`pnpm build failed to start: ${errorMessage(error)}`);
  }

  if (result.error === undefined && !result.timedOut && result.status === 0) return;

  const details = [
    result.timedOut ? `timeout after ${BUILD_TIMEOUT_MS}ms` : undefined,
    result.error?.message,
    result.status === null ? undefined : `exit status: ${result.status}`,
    result.signal === null ? undefined : `signal: ${result.signal}`,
    result.stdout,
    result.stderr,
  ].filter((value): value is string => value !== undefined && value !== "");
  throw new Error(`pnpm build failed${details.length === 0 ? "" : `:\n${details.join("\n")}`}`);
}

type PlanCommand = {
  controlId: string;
  commandId: string;
  executable: string;
  argv: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
};

type QualityPlan = {
  identity: { baseSha: string; headSha: string };
  profile: "routine";
  controls: Array<{ id: string; requirement: "required" }>;
  commands: PlanCommand[];
};

type IsolatedRoots = {
  home: string;
  userProfile: string;
  appData: string;
  localAppData: string;
  codexHome: string;
  opencodeConfigDir: string;
  xdgConfigHome: string;
  temp: string;
  tmp: string;
  tmpdir: string;
};

type TestLayout = {
  root: string;
  cwd: string;
  inputDir: string;
  planPath: string;
  outputDir: string;
  receiptPath: string;
  markersDir: string;
  markerPath: string;
  targetDir: string;
  isolated: IsolatedRoots;
};

type CliResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type BoundedProcessResult = CliResult & {
  timedOut: boolean;
  error?: Error;
};

type ReceiptCommand = {
  commandId: string;
  executable: string;
  argv: string[];
  exitCode: number;
  durationMs: number;
  excerpt: string;
  outputDigest: string;
};

type ReceiptResult = {
  controlId: string;
  status: string;
  evidence?: string;
  reason?: string;
};

type QualityReceipt = {
  namespace: string;
  version: number;
  authority: string;
  identity: {
    profile: string;
    baseSha: string;
    headSha: string;
    policyDigest: string;
  };
  commands: ReceiptCommand[];
  results: ReceiptResult[];
};

const temporaryRoots: string[] = [];

function createLayout(): TestLayout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-quality-cli-"));
  temporaryRoots.push(root);

  const isolated: IsolatedRoots = {
    home: path.join(root, "home"),
    userProfile: path.join(root, "user-profile"),
    appData: path.join(root, "app-data"),
    localAppData: path.join(root, "local-app-data"),
    codexHome: path.join(root, "codex-home"),
    opencodeConfigDir: path.join(root, "opencode-config"),
    xdgConfigHome: path.join(root, "xdg-config"),
    temp: path.join(root, "temp"),
    tmp: path.join(root, "tmp"),
    tmpdir: path.join(root, "tmpdir"),
  };
  const layout: TestLayout = {
    root,
    cwd: path.join(root, "cwd with spaces"),
    inputDir: path.join(root, "input"),
    planPath: path.join(root, "input", "plan with spaces.json"),
    outputDir: path.join(root, "output"),
    receiptPath: path.join(root, "output", "receipt with spaces.json"),
    markersDir: path.join(root, "markers"),
    markerPath: path.join(root, "markers", "grandchild-marker.txt"),
    targetDir: path.join(root, "target dir"),
    isolated,
  };

  for (const directory of [
    layout.cwd,
    layout.inputDir,
    layout.outputDir,
    layout.markersDir,
    layout.targetDir,
    ...Object.values(isolated),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return layout;
}

function isolatedEnvironment(layout: TestLayout): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: layout.isolated.home,
    USERPROFILE: layout.isolated.userProfile,
    APPDATA: layout.isolated.appData,
    LOCALAPPDATA: layout.isolated.localAppData,
    CODEX_HOME: layout.isolated.codexHome,
    OPENCODE_CONFIG_DIR: layout.isolated.opencodeConfigDir,
    XDG_CONFIG_HOME: layout.isolated.xdgConfigHome,
    TEMP: layout.isolated.temp,
    TMP: layout.isolated.tmp,
    TMPDIR: layout.isolated.tmpdir,
  };

  const preservedHostKeys = new Set([
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "windir",
    "ComSpec",
    "COMSPEC",
  ]);
  for (const key of Object.keys(process.env)) {
    if (!preservedHostKeys.has(key)) continue;
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function writePlan(layout: TestLayout, plan: QualityPlan): void {
  fs.writeFileSync(layout.planPath, `${JSON.stringify(plan)}\n`, "utf8");
}

function nodeCommand(
  controlId: string,
  overrides: Partial<PlanCommand> = {},
): PlanCommand {
  return {
    controlId,
    commandId: `${controlId}-command`,
    executable: process.execPath,
    argv: ["-e", "process.stdout.write('quality pass')"],
    timeoutMs: 2_000,
    ...overrides,
  };
}

function qualityPlan(command: PlanCommand): QualityPlan {
  return {
    identity: { baseSha: BASE_SHA, headSha: HEAD_SHA },
    profile: "routine",
    controls: [{ id: command.controlId, requirement: "required" }],
    commands: [command],
  };
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    let killed = false;
    try {
      const result = spawnSync(taskkill, ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        timeout: TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      killed = result.error === undefined && result.status === 0;
    } catch {
      // Fall back to the direct child when taskkill is unavailable.
    }
    if (!killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and the kill attempt.
      }
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the kill attempt.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runBoundedProcess(
  invocation: ProcessInvocation,
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  return new Promise<BoundedProcessResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        detached: true,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let childError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killGrace: NodeJS.Timeout | undefined;

    const onStdoutData = (chunk: string | Buffer): void => {
      stdout += chunk.toString();
    };
    const onStderrData = (chunk: string | Buffer): void => {
      stderr += chunk.toString();
    };
    const onLateError = (error: Error): void => {
      childError ??= error;
    };
    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (killGrace !== undefined) clearTimeout(killGrace);
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // A terminated child can report an asynchronous error after cleanup.
      child.on("error", onLateError);
      child.unref();
    };
    const settle = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, timedOut, ...(childError === undefined ? {} : { error: childError }) });
    };
    const onChildError = (error: Error): void => {
      childError ??= error;
    };
    const onClose = (status: number | null, signal: NodeJS.Signals | null): void => {
      settle({ status, signal, stdout, stderr });
    };
    const onTimeout = (): void => {
      if (settled) return;
      timedOut = true;
      killProcessTree(child);
      killGrace = setTimeout(() => {
        if (settled) return;
        killProcessTree(child);
        settle({ status: null, signal: "SIGKILL", stdout, stderr });
      }, CLI_KILL_GRACE_MS);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", onChildError);
    child.once("close", onClose);
    timeout = setTimeout(onTimeout, options.timeoutMs);
  });
}

async function runQuality(
  layout: TestLayout,
  args: string[],
  environment = isolatedEnvironment(layout),
): Promise<CliResult> {
  expect(path.isAbsolute(process.execPath)).toBe(true);
  expect(CLI_PATH).toMatch(/[\\/]dist[\\/]cli\.js$/);

  const result = await runBoundedProcess(
    { command: process.execPath, args: [CLI_PATH, "quality", ...args] },
    { cwd: layout.cwd, env: environment, timeoutMs: CLI_TIMEOUT_MS },
  );
  if (result.error !== undefined) {
    const details = [result.error.message, result.stdout, result.stderr]
      .filter((value) => value !== "")
      .join("\n");
    throw new Error(`quality CLI failed${details === "" ? "" : `:\n${details}`}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseReceipt(serialized: string): QualityReceipt {
  expect(serialized).not.toBe("");
  expect(serialized.endsWith("\n")).toBe(true);

  const receipt = JSON.parse(serialized) as QualityReceipt;
  expect(receipt).toMatchObject({
    namespace: "jorgex.quality.receipt",
    version: 1,
    authority: "local",
  });
  expect(receipt.identity.baseSha).toBe(BASE_SHA);
  expect(receipt.identity.headSha).toBe(HEAD_SHA);
  expect(receipt.identity.profile).toBe("routine");
  expect(receipt.identity.policyDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.commands).toHaveLength(1);
  expect(receipt.results).toHaveLength(1);
  expect(receipt).not.toHaveProperty("status");
  return receipt;
}

function onlyCommand(receipt: QualityReceipt): ReceiptCommand {
  const command = receipt.commands[0];
  if (command === undefined) throw new Error("quality acceptance receipt has no command");
  return command;
}

function onlyResult(receipt: QualityReceipt): ReceiptResult {
  const result = receipt.results[0];
  if (result === undefined) throw new Error("quality acceptance receipt has no result");
  return result;
}

function snapshotEntry(target: string): string {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target).sort().map((name) => {
        return `${name}:${snapshotEntry(path.join(target, name))}`;
      });
      return `directory:${entries.join("|")}`;
    }
    if (stat.isFile()) return `file:${fs.readFileSync(target).toString("base64")}`;
    if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(target)}`;
    return `other:${stat.mode}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function managedSnapshot(layout: TestLayout): Record<string, string> {
  const roots: Array<[string, string]> = [
    ["cwd", layout.cwd],
    ["input", layout.inputDir],
    ["output", layout.outputDir],
    ["markers", layout.markersDir],
    ["target-dir", layout.targetDir],
    ...Object.entries(layout.isolated).map(([name, root]) => [`env:${name}`, root] as [string, string]),
  ];
  return Object.fromEntries(roots.map(([name, root]) => [name, snapshotEntry(root)]));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appearedWithin(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await wait(25);
  }
  return fs.existsSync(file);
}

function writeManagedSentinels(layout: TestLayout): void {
  const roots = [
    layout.cwd,
    layout.outputDir,
    layout.markersDir,
    layout.targetDir,
    ...Object.values(layout.isolated),
  ];
  roots.forEach((root, index) => {
    fs.writeFileSync(
      path.join(root, `sentinel-${index}.txt`),
      `managed-sentinel-${index}`,
      "utf8",
    );
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }
});

describe("quality CLI acceptance black-box", () => {
  beforeAll(async () => {
    await buildDist();
  }, 60_000);

  it("ejecuta el CLI compilado real, emite pass por stdout y no hereda el entorno", async () => {
    const layout = createLayout();
    const ambientKey = `JX_ACCEPTANCE_AMBIENT_${process.pid}`;
    const ambientValue = "ambient-value-sentinel";
    const explicitValue = "explicit-value-sentinel";
    const script = [
      "const observed = {",
      "  explicit: process.env.QUALITY_ACCEPTANCE_EXPLICIT ?? null,",
      `  ambient: process.env[${JSON.stringify(ambientKey)}] ?? null,`,
      "  cwd: process.cwd(),",
      "};",
      "process.stdout.write('quality pass\\n' + JSON.stringify(observed));",
    ].join("\n");
    writePlan(layout, qualityPlan(nodeCommand("pass", {
      commandId: "pass-stdout",
      argv: ["-e", script],
      env: { QUALITY_ACCEPTANCE_EXPLICIT: explicitValue },
    })));
    const before = managedSnapshot(layout);
    const result = await runQuality(layout, [layout.planPath], {
      ...isolatedEnvironment(layout),
      [ambientKey]: ambientValue,
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(fs.existsSync(layout.receiptPath)).toBe(false);
    expect(managedSnapshot(layout)).toEqual(before);

    const receipt = parseReceipt(result.stdout);
    const command = onlyCommand(receipt);
    const observed = JSON.stringify({
      explicit: explicitValue,
      ambient: null,
      cwd: layout.cwd,
    });
    expect(command).toMatchObject({
      commandId: "pass-stdout",
      executable: process.execPath,
      exitCode: 0,
    });
    expect(command.excerpt).toContain(`quality pass\n${observed}`);
    expect(command.argv[0]).toBe("-e");
    expect(command.argv[1]).toBe(script);
  });

  it("reemplaza un receipt sentinel con --receipt sin dejar temporales", async () => {
    const layout = createLayout();
    const sentinel = "RECEIPT_SENTINEL_MUST_BE_REPLACED";
    fs.writeFileSync(layout.receiptPath, sentinel, "utf8");
    writePlan(layout, qualityPlan(nodeCommand("atomic", {
      commandId: "atomic-pass",
      argv: ["-e", "process.stdout.write('atomic pass')"],
    })));

    const result = await runQuality(layout, [layout.planPath, "--receipt", layout.receiptPath]);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const serialized = fs.readFileSync(layout.receiptPath, "utf8");
    expect(serialized).not.toContain(sentinel);
    const receipt = parseReceipt(serialized);
    expect(onlyResult(receipt)).toMatchObject({ controlId: "atomic", status: "pass" });
    expect(fs.readdirSync(layout.outputDir).sort()).toEqual([path.basename(layout.receiptPath)]);
  });

  it("conserva un fallo nonzero como fail y devuelve exit 1", async () => {
    const layout = createLayout();
    const failureOutput = "quality-failure-output-sentinel";
    writePlan(layout, qualityPlan(nodeCommand("nonzero", {
      commandId: "nonzero-fail",
      argv: ["-e", `process.stderr.write(${JSON.stringify(failureOutput)}); process.exit(7)`],
    })));

    const result = await runQuality(layout, [layout.planPath]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const receipt = parseReceipt(result.stdout);
    const command = onlyCommand(receipt);
    const controlResult = onlyResult(receipt);
    expect(command.exitCode).toBe(7);
    expect(command.excerpt).toContain(failureOutput);
    expect(controlResult).toMatchObject({
      controlId: "nonzero",
      status: "fail",
      reason: "nonzero-exit",
    });
    expect(controlResult.status).not.toBe("pass");
  });

  it("marca timeout y no deja el marcador del grandchild tras una espera acotada", async () => {
    const layout = createLayout();
    const internalTimeoutMs = 2_000;
    const grandchildDelayMs = 5_000;
    const grandchildScript = [
      `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'grandchild-marker'), Number(process.argv[2]))`,
    ].join(";");
    const rootScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2], process.argv[3]], { stdio: 'ignore' });",
      "process.stdout.write('root spawned\\n');",
      "setTimeout(() => {}, 60_000);",
    ].join("\n");
    writePlan(layout, qualityPlan(nodeCommand("timeout", {
      commandId: "timeout-tree",
      argv: ["-e", rootScript, "--", grandchildScript, layout.markerPath, String(grandchildDelayMs)],
      timeoutMs: internalTimeoutMs,
    })));

    const result = await runQuality(layout, [layout.planPath, "--receipt", layout.receiptPath]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const receipt = parseReceipt(fs.readFileSync(layout.receiptPath, "utf8"));
    expect(onlyCommand(receipt).excerpt).toContain("root spawned");
    expect(onlyResult(receipt)).toMatchObject({
      controlId: "timeout",
      status: "incomplete",
      reason: "timeout",
    });
    expect(await appearedWithin(layout.markerPath, 6_000)).toBe(false);
  }, 16_000);

  it("informa un ejecutable ausente como unavailable/incomplete", async () => {
    const layout = createLayout();
    const missingExecutable = path.join(layout.root, "missing executable with spaces.exe");
    writePlan(layout, qualityPlan(nodeCommand("unavailable", {
      commandId: "missing-executable",
      executable: missingExecutable,
      argv: [],
    })));

    const result = await runQuality(layout, [layout.planPath]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const receipt = parseReceipt(result.stdout);
    expect(onlyCommand(receipt)).toMatchObject({
      executable: missingExecutable,
      exitCode: -1,
    });
    expect(onlyResult(receipt)).toMatchObject({
      controlId: "unavailable",
      status: "incomplete",
      reason: "spawn-error",
    });
  });

  it("conserva exactamente maxOutputBytes cuando el límite se alcanza", async () => {
    const layout = createLayout();
    const output = "0123456789abcdef";
    const maxOutputBytes = Buffer.byteLength(output, "utf8");
    writePlan(layout, qualityPlan(nodeCommand("output-limit", {
      commandId: "output-limit-exact",
      argv: [
        "-e",
        `process.stdout.write(${JSON.stringify(output)}); setTimeout(() => {}, 60_000)`,
      ],
      maxOutputBytes,
      timeoutMs: 500,
    })));

    const result = await runQuality(layout, [layout.planPath]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    const receipt = parseReceipt(result.stdout);
    const command = onlyCommand(receipt);
    expect(command.excerpt).toBe(output);
    expect(Buffer.byteLength(command.excerpt, "utf8")).toBe(maxOutputBytes);
    expect(onlyResult(receipt)).toMatchObject({
      controlId: "output-limit",
      status: "incomplete",
      reason: "output-limit",
    });
  });

  it("redacta argv/output y demuestra que el proceso hijo no hereda env", async () => {
    const layout = createLayout();
    const ambientKey = `JX_ACCEPTANCE_REDACTION_AMBIENT_${process.pid}`;
    const ambientValue = "ambient-redaction-value-sentinel";
    const argvSecret = "argv-value-sentinel";
    const outputSecret = "output-value-sentinel";
    const script = [
      "const secret = process.env.QUALITY_ACCEPTANCE_OUTPUT;",
      `const ambient = process.env[${JSON.stringify(ambientKey)}] ?? null;`,
      "const bearer = 'Author' + 'ization: Bearer ';",
      "const pfx = 'pass' + 'word=';",
      "const field = 'to' + 'ken';",
      "process.stdout.write([",
      "  bearer + secret,",
      "  pfx + secret,",
      "  JSON.stringify({ [field]: secret, ambient }),",
      "].join('\\n'));",
    ].join("\n");
    writePlan(layout, qualityPlan(nodeCommand("redaction", {
      commandId: "redaction-and-env",
      argv: ["-e", script, "--", "--token", argvSecret],
      env: { QUALITY_ACCEPTANCE_OUTPUT: outputSecret },
    })));
    const result = await runQuality(layout, [layout.planPath], {
      ...isolatedEnvironment(layout),
      [ambientKey]: ambientValue,
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const receipt = parseReceipt(result.stdout);
    const command = onlyCommand(receipt);
    const serialized = JSON.stringify(receipt);

    expect(serialized).not.toContain(argvSecret);
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(ambientValue);
    expect(command.argv.slice(-2)).toEqual(["--token", "[REDACTED]"]);
    expect(command.excerpt).toContain("Authorization: [REDACTED]");
    expect(command.excerpt).toContain("password=[REDACTED]");
    expect(command.excerpt).toContain('"token":"[REDACTED]"');
    expect(command.excerpt).toContain('"ambient":null');
    expect(command).not.toHaveProperty("environment");
    expect(command).not.toHaveProperty("stdout");
    expect(command).not.toHaveProperty("stderr");
  });

  it("rechaza --target-dir antes de spawn y conserva solo los roots/sentinels gestionados", async () => {
    const layout = createLayout();
    const receiptSentinel = "TARGET_DIR_RECEIPT_SENTINEL";
    fs.writeFileSync(layout.receiptPath, receiptSentinel, "utf8");
    writeManagedSentinels(layout);
    writePlan(layout, qualityPlan(nodeCommand("must-not-spawn", {
      commandId: "target-dir-rejected",
      argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(layout.markerPath)}, 'spawned')`],
    })));
    const before = managedSnapshot(layout);

    const result = await runQuality(layout, [
      layout.planPath,
      "--target-dir",
      layout.targetDir,
      "--receipt",
      layout.receiptPath,
    ]);

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--target-dir/);
    expect(fs.readFileSync(layout.receiptPath, "utf8")).toBe(receiptSentinel);
    expect(fs.existsSync(layout.markerPath)).toBe(false);
    expect(managedSnapshot(layout)).toEqual(before);
  });
});
