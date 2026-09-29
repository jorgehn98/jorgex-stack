import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { stageVerifiedPiTarball } from "../src/lib/pi-release-stage.js";
import { materializeStagedPiRuntimeDependencies } from "../src/lib/pi-staged-lock.js";
import { smokeLinkedPiRuntime } from "../src/lib/pi-stage-smoke.js";
import { planDetectedBinCommand } from "../src/lib/detect.js";

const piExecutable = process.env.JORGEX_PI_BIN ?? (process.env.PI_TEST_HOST
  ? path.join(process.env.PI_TEST_HOST, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi")
  : undefined);
const artifactPath = process.env.JORGEX_PI_LIVE_ARTIFACT;
const version: string | undefined = process.env.JORGEX_PI_LIVE_VERSION ?? (process.env.PI_TEST_CANDIDATE
  ? JSON.parse(fs.readFileSync(process.env.PI_TEST_CANDIDATE, "utf8")).version as string
  : undefined);

const STAGE_RUN_TIMEOUT_MS = 120_000;
const DIAGNOSTIC_OUTPUT_BYTES = 96 * 1024;
const DIAGNOSTIC_TREE_ENTRIES = 500;

function appendBounded(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= DIAGNOSTIC_OUTPUT_BYTES ? next : next.slice(-DIAGNOSTIC_OUTPUT_BYTES);
}

function processSnapshot(pid: number | undefined, env: Record<string, string>): string {
  if (process.platform !== "win32" || pid === undefined) return JSON.stringify({ watchedPid: pid ?? null });

  const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    `$pending = [System.Collections.Generic.Queue[int]]::new(); $pending.Enqueue(${pid})`,
    "$rows = @(); $seen = @{}",
    "while ($pending.Count -gt 0 -and $rows.Count -lt 64) {",
    "  $current = $pending.Dequeue(); if ($seen.ContainsKey($current)) { continue }; $seen[$current] = $true;",
    "  $rows += Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $current) | Select-Object Name,ProcessId,ParentProcessId;",
    "  Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $current) | ForEach-Object { $pending.Enqueue([int]$_.ProcessId) };",
    "}; $rows | ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env },
  });
  const detail = result.stdout ?? result.stderr ?? result.error?.message ?? "powershell unavailable";
  return JSON.stringify({ watchedPid: pid ?? null, processTable: detail }, null, 2);
}

function boundedStageTree(stageRoot: string): Array<{ relativePath: string; kind: string; bytes?: number }> {
  const entries: Array<{ relativePath: string; kind: string; bytes?: number }> = [];
  const visit = (current: string): void => {
    if (entries.length >= DIAGNOSTIC_TREE_ENTRIES) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= DIAGNOSTIC_TREE_ENTRIES) return;
      const full = path.join(current, child.name);
      const relativePath = path.relative(stageRoot, full);
      if (child.isDirectory()) {
        entries.push({ relativePath, kind: "directory" });
        visit(full);
        continue;
      }
      if (child.isSymbolicLink()) {
        entries.push({ relativePath, kind: "symlink" });
        continue;
      }
      try {
        entries.push({ relativePath, kind: "file", bytes: fs.statSync(full).size });
      } catch {
        entries.push({ relativePath, kind: "unreadable" });
      }
    }
  };
  visit(stageRoot);
  return entries;
}

function npmCacheLogs(stageRoot: string): Array<{ file: string; tail: string }> {
  const logsDir = path.join(stageRoot, "npm-cache", "_logs");
  let files: string[];
  try {
    files = fs.readdirSync(logsDir).filter((entry) => entry.endsWith(".log")).sort();
  } catch {
    return [];
  }
  let remaining = DIAGNOSTIC_OUTPUT_BYTES;
  const logs: Array<{ file: string; tail: string }> = [];
  for (const file of files) {
    if (remaining <= 0) break;
    try {
      const raw = fs.readFileSync(path.join(logsDir, file), "utf8");
      const tail = raw.slice(-Math.min(raw.length, remaining, 32 * 1024));
      logs.push({ file, tail });
      remaining -= tail.length;
    } catch {
      logs.push({ file, tail: "<unreadable>" });
    }
  }
  return logs;
}

function writeLiveDiagnostics(
  stageRoot: string,
  pid: number | undefined,
  env: Record<string, string>,
  phase: "before-kill" | "after-kill",
  stdout: string,
  stderr: string,
): string | null {
  const report = {
    phase,
    platform: process.platform,
    pid: pid ?? null,
    stageRoot,
    stageDir: env.PI_CODING_AGENT_DIR ?? null,
    processSnapshot: processSnapshot(pid, env),
    npmCacheLogs: npmCacheLogs(stageRoot),
    tree: boundedStageTree(stageRoot),
    stdoutTail: stdout.slice(-DIAGNOSTIC_OUTPUT_BYTES),
    stderrTail: stderr.slice(-DIAGNOSTIC_OUTPUT_BYTES),
  };
  const reportPath = path.join(stageRoot, `live-diagnostics-${phase}.json`);
  try {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    return null;
  }
  const externalRoot = process.env.JORGEX_PI_LIVE_DIAGNOSTICS;
  if (externalRoot) {
    try {
      fs.mkdirSync(externalRoot, { recursive: true });
      fs.copyFileSync(reportPath, path.join(externalRoot, `${path.basename(stageRoot)}-${phase}.json`));
    } catch {
      // The stage-local report remains available in the retained failure stage.
    }
  }
  return reportPath;
}

function stopOwnedWindowsProcess(child: ChildProcess, env: Record<string, string>): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill();
    } catch {
      // Already exited.
    }
    return;
  }
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  try {
    spawnSync(taskkill, ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: "ignore",
      windowsHide: true,
      env: { ...env },
    });
  } catch {
    // Fall through to the direct kill below.
  }
  try {
    child.kill();
  } catch {
    // Already exited.
  }
}

/**
 * The live Windows failure is inside Pi's native npm child, not Vitest.
 * Keep this runner asynchronous so a timeout can record npm's isolated cache,
 * inspect the owned process tree, and terminate cmd/npm/node as one tree.
 */
function runPiInstallWithDiagnostics(
  executable: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = planDetectedBinCommand(executable, args);
  if (command === null) throw new Error("Unsafe Pi test executable");
  const env: Record<string, string> = {
    ...options.env,
    npm_config_loglevel: "verbose",
    npm_config_timing: "true",
  };
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let diagnosticPath: string | null = null;
    const finish = (exitCode: number, detail = ""): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr: [detail, stderr].filter(Boolean).join("\n") });
    };
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => finish(1, error.message));
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(1, `pi install timed out after ${STAGE_RUN_TIMEOUT_MS}ms; signal=${signal ?? "unknown"}; diagnostics=${diagnosticPath ?? "unavailable"}`);
      } else {
        finish(code ?? 1);
      }
    });
    setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const stageRoot = path.dirname(env.PI_CODING_AGENT_DIR ?? options.cwd);
      diagnosticPath = writeLiveDiagnostics(stageRoot, child.pid, env, "before-kill", stdout, stderr);
      stopOwnedWindowsProcess(child, env);
      writeLiveDiagnostics(stageRoot, child.pid, env, "after-kill", stdout, stderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(1, `pi install timed out after ${STAGE_RUN_TIMEOUT_MS}ms; diagnostics=${diagnosticPath ?? "unavailable"}`);
    }, STAGE_RUN_TIMEOUT_MS).unref?.();
  });
}

it.skipIf(!piExecutable || !artifactPath || !version)("real Pi loads the promoted-link topology only with its verified local runtime copies", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-layout-live-"));
  let failed = false;
  try {
    const agentDir = path.join(homeDir, "agent");
    fs.mkdirSync(agentDir);
    const bytes = fs.readFileSync(artifactPath!);
    const artifact = {
      path: path.resolve(artifactPath!), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
    const release = { version: version!, tarballUrl: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const staged = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: piExecutable!, artifact, release },
      runPiInstallWithDiagnostics,
    );
    const packageRoot = path.join(staged.stageDir, "npm", "node_modules", "jorgex-pi");
    // Restore the old topology to prove the same real loader goes RED.
    fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true });
    const smoke = { piExecutable: piExecutable!, packageRoot, scratchRoot: path.dirname(staged.stageDir) };
    await expect(smokeLinkedPiRuntime(smoke)).rejects.toThrow(/permission load failure|Cannot find module/);
    materializeStagedPiRuntimeDependencies({ stageDir: staged.stageDir, tarballPath: artifact.path, release });
    const ready = await smokeLinkedPiRuntime(smoke);
    expect(ready.commands).toEqual(expect.arrayContaining(["permission-system", "subagents", "goal", "websearch"]));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed) console.error(`Failed Pi live stage retained for diagnosis: ${homeDir}`);
    else fs.rmSync(homeDir, { recursive: true, force: true });
  }
}, 240_000);
