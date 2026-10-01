import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

/**
 * Bounded process runner shared by the acceptance suite and its regressions.
 *
 * Ownership contract: a single owner tracks both owned process groups and
 * registered root callbacks. Every child is spawned as its own POSIX
 * process-group leader (or Windows process tree root). Termination is by
 * PID/group, never by process name. A group that is already gone (`ESRCH`)
 * is an expected absence; any other cleanup failure is reported
 * (`treeCleanupError`) instead of being hidden by a child-only `kill`
 * fallback. Groups stop first; root callbacks run only after every group
 * stop is verified, and stay registered until the caller unregisters them
 * after a confirmed cleanup.
 *
 * On Windows there is no POSIX group: `taskkill /pid <pid> /t /f` is the only
 * mechanism, bounded by a timeout. When taskkill is unavailable or reports a
 * non-absence failure, the result is marked as unverified cleanup; no success
 * is claimed.
 */

export const TREE_KILL_TIMEOUT_MS = 1_000;
export const CLI_KILL_GRACE_MS = 250;

export type ProcessInvocation = {
  command: string;
  args: string[];
};

export type BoundedProcessOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type CliResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type TreeCleanupOutcome = { ok: true } | { ok: false; cause: string };

export type StopOwnProcessGroup = (pid: number) => TreeCleanupOutcome;

export type TreeCleanupFailure = {
  pid: number;
  cause: string;
};

export type BoundedProcessResult = CliResult & {
  timedOut: boolean;
  error?: Error;
  treeCleanupError?: TreeCleanupFailure;
};

export type BoundedProcessRunnerOptions = BoundedProcessOptions & {
  /** Test seam: override own PID/group termination (defaults to the real one). */
  stopOwnProcessGroup?: StopOwnProcessGroup;
};

export type BoundedProcessRunner = (
  invocation: ProcessInvocation,
  options: BoundedProcessRunnerOptions,
) => Promise<BoundedProcessResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stops the process group/tree owned by `pid`. `ok` means the stop signal was
 * delivered or the group was already absent; `ok: false` means cleanup is
 * unverified and must be surfaced by the caller.
 */
export function stopOwnProcessTree(pid: number): TreeCleanupOutcome {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(taskkill, ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        timeout: TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, cause: `taskkill no ejecutable: ${errorMessage(error)}` };
    }
    if (result.error !== undefined) {
      return { ok: false, cause: `taskkill error: ${result.error.message}` };
    }
    // 0 = taskkill reports the tree terminated. 128 only proves the leader is
    // gone, not its descendants, so it is reported as unverified.
    if (result.status === 0) return { ok: true };
    if (result.status === 128) {
      return {
        ok: false,
        cause: "taskkill status 128: solo el líder desapareció; árbol no verificado",
      };
    }
    return { ok: false, cause: `taskkill status ${String(result.status)} sin verificación de árbol` };
  }

  try {
    process.kill(-pid, "SIGKILL");
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true };
    return { ok: false, cause: `${code ?? "UNKNOWN"}: ${errorMessage(error)}` };
  }
}

type OwnedProcessGroup = { pid: number; stop: StopOwnProcessGroup };

type OwnedCleanup = { label: string; cleanup: () => void };

const ownedProcessGroups = new Map<number, OwnedProcessGroup>();
const ownedCleanups = new Map<string, OwnedCleanup>();
let cleanupSequence = 0;
let lifecycleInstalled = false;

/**
 * Fails before any detached spawn when this host cannot deliver verifiable
 * cancellation to the owner: worker_threads receive no signals, and Windows
 * terminates on an external SIGTERM without letting JavaScript clean up.
 * SIGKILL stays irrecoverable by design; resources remain identified for
 * recovery, but no teardown is promised.
 */
export function assertVerificationCancellationCapability(): void {
  if (!isMainThread) {
    throw new Error(
      "No hay cancelación verificable en worker_threads (Node no entrega señales a workers); no se inicia el árbol detached.",
    );
  }
  if (process.platform === "win32") {
    throw new Error(
      "Windows no garantiza cancelación interceptable (SIGTERM externo termina incondicionalmente); no se inicia el árbol detached. El backing de disco ya falla cerrado (statfs type 0).",
    );
  }
}

function cleanupOwnedProcessGroups(): string[] {
  const failures: string[] = [];
  for (const resource of [...ownedProcessGroups.values()]) {
    const outcome = resource.stop(resource.pid);
    if (outcome.ok) ownedProcessGroups.delete(resource.pid);
    else failures.push(`pid ${resource.pid}: ${outcome.cause}`);
  }
  return failures;
}

function cleanupOwnedCallbacks(): string[] {
  const failures: string[] = [];
  for (const entry of ownedCleanups.values()) {
    try {
      entry.cleanup();
    } catch (error) {
      // Keep the registration armed for retry and diagnosis.
      failures.push(`${entry.label}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

function cleanupOwnedResources(): string[] {
  const groupFailures = cleanupOwnedProcessGroups();
  // Never delete owned roots while a group stop is still unverified.
  if (groupFailures.length > 0) return groupFailures;
  return cleanupOwnedCallbacks();
}

function reportOwnedCleanupFailure(failures: string[]): void {
  try {
    process.stderr.write(
      `No se pudo verificar la limpieza de recursos propios: ${failures.join("; ")}\n`,
    );
  } catch {
    // Best effort on a termination path.
  }
}

/**
 * Installs the owned-resource owner once, before the first spawn. Signal
 * listeners are prepended, never removing framework listeners: with another
 * handler the framework keeps ownership of termination; without one, our
 * listener is removed and the signal is re-raised to preserve native
 * termination and its nonzero code.
 */
function installOwnedResourceLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  const onExit = (code: number): void => {
    const failures = cleanupOwnedResources();
    if (failures.length > 0) {
      reportOwnedCleanupFailure(failures);
      // Final cleanup failure must be nonzero, without overwriting a previous
      // nonzero exit code.
      if (code === 0) process.exitCode = 1;
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    const failures = cleanupOwnedResources();
    if (failures.length > 0) reportOwnedCleanupFailure(failures);
    const otherListeners = process.listeners(signal).filter((listener) => listener !== onSignal);
    if (otherListeners.length > 0) return; // The framework owns termination.
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };

  process.on("exit", onExit);
  process.prependListener("SIGINT", onSignal);
  process.prependListener("SIGTERM", onSignal);
}

/** Explicitly forgets an owned group whose cleanup the caller already handled. */
export function releaseOwnedProcessGroup(pid: number): void {
  ownedProcessGroups.delete(pid);
}

/**
 * Single cleanup boundary for callers (test hooks included): runs the same
 * owner cleanup — groups first, then registered callbacks — and throws with
 * every pending cause when any resource remains unverified. It never duplicates
 * the cleanup loop.
 */
export function cleanupOwnedResourcesOrThrow(): void {
  const failures = cleanupOwnedResources();
  if (failures.length > 0) {
    throw new Error(`No se pudo verificar la limpieza de recursos propios: ${failures.join("; ")}`);
  }
}

/**
 * Registers a synchronous cleanup for another owned resource (for example the
 * acceptance temporary roots). The owner runs callbacks only after every owned
 * group stop is verified, keeps failed registrations armed for retry, and
 * leaves successful ones armed until the caller unregisters them after a
 * confirmed cleanup.
 */
export function registerOwnedResourceCleanup(label: string, cleanup: () => void): () => void {
  installOwnedResourceLifecycle();
  cleanupSequence += 1;
  const key = `${label}#${cleanupSequence}`;
  ownedCleanups.set(key, { label, cleanup });
  return () => {
    ownedCleanups.delete(key);
  };
}

export function runBoundedProcess(
  invocation: ProcessInvocation,
  options: BoundedProcessRunnerOptions,
): Promise<BoundedProcessResult> {
  assertVerificationCancellationCapability();
  installOwnedResourceLifecycle();
  const stopOwnProcessGroup = options.stopOwnProcessGroup ?? stopOwnProcessTree;

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

    if (child.pid !== undefined) {
      ownedProcessGroups.set(child.pid, { pid: child.pid, stop: stopOwnProcessGroup });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let childError: Error | undefined;
    let treeCleanupError: TreeCleanupFailure | undefined;
    let lastStopOutcome: TreeCleanupOutcome | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killGrace: NodeJS.Timeout | undefined;

    const stopOwnGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      const outcome = stopOwnProcessGroup(pid);
      lastStopOutcome = outcome;
      if (!outcome.ok && treeCleanupError === undefined) {
        treeCleanupError = { pid, cause: outcome.cause };
      }
    };

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
      // Keep unverified groups tracked so the lifecycle can retry and report.
      if (child.pid !== undefined && lastStopOutcome?.ok === true) {
        ownedProcessGroups.delete(child.pid);
      }
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
      let failure = childError;
      if (treeCleanupError !== undefined) {
        const message = `tree cleanup failed (pid ${treeCleanupError.pid}): ${treeCleanupError.cause}`;
        failure = failure === undefined ? new Error(message) : new Error(`${failure.message}\n${message}`);
      }
      resolve({
        ...result,
        timedOut,
        ...(failure === undefined ? {} : { error: failure }),
        ...(treeCleanupError === undefined ? {} : { treeCleanupError }),
      });
    };
    const onChildError = (error: Error): void => {
      childError ??= error;
    };
    const onClose = (status: number | null, signal: NodeJS.Signals | null): void => {
      // The leader can exit while an inert descendant stays in its group.
      stopOwnGroup();
      settle({ status, signal, stdout, stderr });
    };
    const onTimeout = (): void => {
      if (settled) return;
      timedOut = true;
      stopOwnGroup();
      killGrace = setTimeout(() => {
        if (settled) return;
        stopOwnGroup();
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
