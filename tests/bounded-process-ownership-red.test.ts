import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assertVerificationCancellationCapability,
  cleanupOwnedResourcesOrThrow,
  registerOwnedProcessGroup,
  registerOwnedResourceCleanup,
  releaseOwnedProcessGroup,
  runBoundedProcess,
  stopOwnProcessTree,
  type BoundedProcessResult,
  type StopOwnProcessGroup,
} from "./helpers/bounded-process.js";
import { removeTemporaryRoots } from "./helpers/pnpm-tooling.js";

/**
 * Regression seam for the bounded runner: real OS processes, no pnpm chain.
 * Cancellation signals go only to child harnesses, never to the vitest worker
 * itself; the helper installs its lifecycle before the first spawn.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots: string[] = [];

afterEach(() => {
  removeTemporaryRoots(tempRoots);
});

afterAll(() => {
  removeTemporaryRoots(tempRoots);
});

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
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

function readHandshakePids(leaderPidFile: string, childPidFile: string): number[] {
  return [leaderPidFile, childPidFile]
    .filter((file) => fs.existsSync(file))
    .map((file) => Number(fs.readFileSync(file, "utf8").trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const GRANDCHILD_SCRIPT =
  "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), Number(process.argv[2]))";

const LEADER_EXITS_IMMEDIATELY = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2], process.argv[3]], { stdio: 'ignore' });",
  "child.unref();",
  "process.exit(0);",
].join("\n");

const RESIGNAL_HARNESS = path.join(REPO_ROOT, "tests", "fixtures", "cancellation-resignal-harness.mjs");
const FOREIGN_HANDLER_HARNESS = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "cancellation-foreign-handler-harness.mjs",
);
const EXIT_FAILURE_HARNESS = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "cancellation-exit-failure-harness.mjs",
);
const WORKER_HARNESS = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "worker-home-cancellation-harness.mjs",
);
const OWNED_ROOTS_HARNESS = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "owned-roots-failure-harness.mjs",
);

const REQUIRED_VERSION = "11.1.1";

function findDiskBaseOutsideWorkspace(): string {
  let current = REPO_ROOT;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No hay base de disco fuera del workspace desde ${REPO_ROOT}`);
    }
    current = parent;
    const segments = current.split(path.sep);
    const hasWorkspace = fs.existsSync(path.join(current, "pnpm-workspace.yaml"));
    const badSegment = segments.includes("worktrees") || segments.includes("node_modules");
    if (!hasWorkspace && !badSegment) return current;
  }
}

function makeDiskBase(): string {
  const base = fs.mkdtempSync(path.join(findDiskBaseOutsideWorkspace(), ".jx-verify-disk-base-"));
  tempRoots.push(base);
  return base;
}

function makeRepo(packageManager: string): string {
  const root = makeTempRoot("jx-repo-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", packageManager })}\n`,
    "utf8",
  );
  return root;
}

function makeFakePnpm(version: string): { entry: string } {
  const packageRoot = path.join(makeTempRoot("jx-fake-pnpm-"), "node_modules", "pnpm");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "bin", "pnpm.mjs"),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${version}\n`)});\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "pnpm", version, bin: { pnpm: "bin/pnpm.mjs" } })}\n`,
    "utf8",
  );
  return { entry: path.join(packageRoot, "bin", "pnpm.mjs") };
}

describe("bounded runner process ownership", () => {
  it("limpia el grupo propio al cerrar el líder y no deja descendiente inerte", async () => {
    const root = makeTempRoot("jx-runner-leader-exit-");
    const marker = path.join(root, "leaked-marker.txt");

    const result = await runBoundedProcess(
      {
        command: process.execPath,
        args: ["-e", LEADER_EXITS_IMMEDIATELY, "--", GRANDCHILD_SCRIPT, marker, "5000"],
      },
      { cwd: root, timeoutMs: 2_000 },
    );

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.treeCleanupError).toBeUndefined();
    expect(await appearedWithin(marker, 6_000)).toBe(false);
  }, 12_000);

  it("propaga un fallo de limpieza de grupo con pid y causa en vez de fingir árbol limpio", async () => {
    const root = makeTempRoot("jx-runner-cleanup-failure-");
    const observedPids: number[] = [];
    const stopOwnProcessGroup: StopOwnProcessGroup = (pid) => {
      observedPids.push(pid);
      return { ok: false, cause: "mock EPERM al terminar el grupo" };
    };

    try {
      const result: BoundedProcessResult = await runBoundedProcess(
        { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
        { cwd: root, timeoutMs: 2_000, stopOwnProcessGroup },
      );

      expect(result.status).toBe(0);
      expect(result.treeCleanupError).toBeDefined();
      expect(typeof result.treeCleanupError?.pid).toBe("number");
      expect(result.treeCleanupError?.cause).toMatch(/EPERM|mock/);
      // The error invariant makes every existing consumer fail closed.
      expect(result.error?.message).toMatch(/tree cleanup failed/);
      expect(result.error?.message).toMatch(/EPERM|mock/);
    } finally {
      for (const pid of observedPids) {
        stopOwnProcessTree(pid);
        releaseOwnedProcessGroup(pid);
      }
    }
  });

  it("trata la ausencia esperada del grupo (ESRCH) como limpieza correcta", async () => {
    const root = makeTempRoot("jx-runner-esrch-");

    const result = await runBoundedProcess(
      { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      {
        cwd: root,
        timeoutMs: 2_000,
        stopOwnProcessGroup: () => ({ ok: true }),
      },
    );

    expect(result.status).toBe(0);
    expect(result.treeCleanupError).toBeUndefined();
  });
});

describe("verification cancellation lifecycle", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "limpia el grupo propio y reenvía %s conservando terminación nativa",
    async (signal) => {
      const root = makeTempRoot("jx-cancel-resignal-");
      const marker = path.join(root, "leaked-marker.txt");
      const leaderPidFile = path.join(root, "leader.pid");
      const childPidFile = path.join(root, "child.pid");

      const result = spawnSync(
        process.execPath,
        [RESIGNAL_HARNESS, signal, marker, "1500", leaderPidFile, childPidFile],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      const ownedPids = readHandshakePids(leaderPidFile, childPidFile);

      try {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBe(signal);
        expect(result.status).toBeNull();
        expect(result.stdout).toMatch(/leader=\d+ child=\d+/);
        expect(await appearedWithin(marker, 2_500)).toBe(false);
      } finally {
        for (const pid of ownedPids) killIfAlive(pid);
      }
    },
    15_000,
  );

  it.each(["SIGTERM", "SIGINT"] as const)(
    "limpia el grupo propio con %s pero conserva el handler del framework",
    async (signal) => {
      const root = makeTempRoot("jx-cancel-foreign-");
      const marker = path.join(root, "leaked-marker.txt");
      const leaderPidFile = path.join(root, "leader.pid");
      const childPidFile = path.join(root, "child.pid");
      const foreignMarker = path.join(root, "foreign-handler.txt");

      const result = spawnSync(
        process.execPath,
        [FOREIGN_HANDLER_HARNESS, signal, marker, "1500", leaderPidFile, childPidFile, foreignMarker],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
      const ownedPids = readHandshakePids(leaderPidFile, childPidFile);

      try {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.signal).toBeNull();
        expect(fs.readFileSync(foreignMarker, "utf8")).toBe("framework-handler");
        expect(await appearedWithin(marker, 2_500)).toBe(false);
      } finally {
        for (const pid of ownedPids) killIfAlive(pid);
      }
    },
    15_000,
  );

  it("convierte un cleanup final fallido en salida 1 sin sustituir un código no cero previo", () => {
    const zero = spawnSync(process.execPath, [EXIT_FAILURE_HARNESS, "0"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(zero.error).toBeUndefined();
    expect(zero.status).toBe(1);
    expect(zero.stderr).toMatch(/No se pudo verificar la limpieza/);

    const three = spawnSync(process.execPath, [EXIT_FAILURE_HARNESS, "3"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(three.error).toBeUndefined();
    expect(three.status).toBe(3);
  }, 15_000);

  it("rechaza la capacidad de cancelación dentro de un worker_threads real", async () => {
    const helperUrl = pathToFileURL(
      path.join(REPO_ROOT, "tests", "helpers", "bounded-process.ts"),
    ).href;
    const worker = new Worker(
      [
        "const { parentPort } = require('node:worker_threads');",
        `import(${JSON.stringify(helperUrl)}).then((module) => {`,
        "  try { module.assertVerificationCancellationCapability(); parentPort.postMessage('no-throw'); }",
        "  catch (error) { parentPort.postMessage(String(error && error.message ? error.message : error)); }",
        "}).catch((error) => parentPort.postMessage('import-fail: ' + error.message));",
      ].join("\n"),
      { eval: true },
    );

    const message = await new Promise<string>((resolve) => {
      worker.once("message", (value) => resolve(String(value)));
    });
    await worker.terminate();
    expect(message).toMatch(/worker_threads|cancelación/);
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "control: el proceso principal POSIX declara capacidad de cancelación",
    () => {
      expect(() => assertVerificationCancellationCapability()).not.toThrow();
    },
  );
});

describe("owned resource roots", () => {
  function runWorkerHarness(
    mode: "resignal" | "foreign",
    signal: "SIGTERM" | "SIGINT",
  ): {
    result: ReturnType<typeof spawnSync>;
    home: string | undefined;
    pids: number[];
    root: string;
  } {
    const diskBase = makeDiskBase();
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const fake = makeFakePnpm(REQUIRED_VERSION);
    const root = makeTempRoot("jx-worker-cancel-");
    const homeHandshake = path.join(root, "home.txt");
    const leaderPidFile = path.join(root, "leader.pid");
    const childPidFile = path.join(root, "child.pid");
    const foreignMarker = path.join(root, "foreign-handler.txt");

    const result = spawnSync(
      process.execPath,
      [
        WORKER_HARNESS,
        mode,
        signal,
        repoRoot,
        homeHandshake,
        leaderPidFile,
        childPidFile,
        foreignMarker,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          JORGEX_PNPM_ENTRYPOINT: fake.entry,
          JORGEX_VERIFICATION_DISK_ROOT: diskBase,
          HOME: diskBase,
          TEMP: diskBase,
          TMP: diskBase,
          TMPDIR: diskBase,
        },
      },
    );

    return {
      result,
      home: fs.existsSync(homeHandshake)
        ? fs.readFileSync(homeHandshake, "utf8").trim()
        : undefined,
      pids: readHandshakePids(leaderPidFile, childPidFile),
      root,
    };
  }

  it.each(["SIGTERM", "SIGINT"] as const)(
    "el worker elimina su propio HOME real antes de que el padre lo toque (%s)",
    async (signal) => {
      const { result, home, pids, root } = runWorkerHarness("resignal", signal);
      const leakMarker = `${path.join(root, "home.txt")}.leak`;

      try {
        expect(result.error).toBeUndefined();
        expect(result.signal).toBe(signal);
        expect(result.status).toBeNull();
        expect(home).toBeDefined();
        expect(fs.existsSync(home ?? "")).toBe(false);
        expect(await appearedWithin(leakMarker, 2_500)).toBe(false);
      } finally {
        for (const pid of pids) killIfAlive(pid);
        if (home !== undefined && fs.existsSync(home)) removeTemporaryRoots([home]);
      }
    },
    20_000,
  );

  it("el worker conserva el handler del framework pero elimina su HOME real", async () => {
    const { result, home, pids, root } = runWorkerHarness("foreign", "SIGTERM");
    const leakMarker = `${path.join(root, "home.txt")}.leak`;

    try {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(fs.readFileSync(path.join(root, "foreign-handler.txt"), "utf8")).toBe(
        "framework-handler",
      );
      expect(home).toBeDefined();
      expect(fs.existsSync(home ?? "")).toBe(false);
      expect(await appearedWithin(leakMarker, 2_500)).toBe(false);
    } finally {
      for (const pid of pids) killIfAlive(pid);
      if (home !== undefined && fs.existsSync(home)) removeTemporaryRoots([home]);
    }
  }, 20_000);

  it.each(["stop-fail", "rm-fail"] as const)(
    "retiene el root propio y sale nonzero cuando el cleanup de raíces no se verifica (%s)",
    (mode) => {
      const diskBase = makeDiskBase();
      const ownedRoot = path.join(diskBase, `owned-root-${mode}`);

      const result = spawnSync(process.execPath, [OWNED_ROOTS_HARNESS, mode, ownedRoot], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, HOME: diskBase, TEMP: diskBase, TMP: diskBase, TMPDIR: diskBase },
      });

      try {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(fs.existsSync(ownedRoot)).toBe(true);
        expect(result.stderr).toMatch(/No se pudo verificar la limpieza/);
      } finally {
        removeTemporaryRoots([ownedRoot]);
      }
    },
    20_000,
  );
});

describe("single owner cleanup boundary", () => {
  it("el hook normal usa el mismo owner: stop no verificado retiene el root y el retry lo limpia", async () => {
    const root = makeTempRoot("jx-owner-hook-");
    const ownedRoot = path.join(root, "owned-root");
    fs.mkdirSync(ownedRoot);
    const observedPids: number[] = [];
    const failingStop: StopOwnProcessGroup = (pid) => {
      observedPids.push(pid);
      return { ok: false, cause: "mock stop failure" };
    };

    const result = await runBoundedProcess(
      { command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      { cwd: root, timeoutMs: 2_000, stopOwnProcessGroup: failingStop },
    );
    expect(result.treeCleanupError).toBeDefined();

    const unregister = registerOwnedResourceCleanup("normal-hook-roots", () =>
      removeTemporaryRoots([ownedRoot]),
    );

    try {
      expect(() => cleanupOwnedResourcesOrThrow()).toThrow(/No se pudo verificar/);
      expect(fs.existsSync(ownedRoot)).toBe(true);

      for (const pid of observedPids) {
        stopOwnProcessTree(pid);
        releaseOwnedProcessGroup(pid);
      }
      cleanupOwnedResourcesOrThrow();
      expect(fs.existsSync(ownedRoot)).toBe(false);
    } finally {
      unregister();
      for (const pid of observedPids) {
        stopOwnProcessTree(pid);
        releaseOwnedProcessGroup(pid);
      }
      if (fs.existsSync(ownedRoot)) removeTemporaryRoots([ownedRoot]);
    }
  }, 15_000);

  it("un callback que falla conserva label, root y error en el mismo owner", () => {
    const root = makeTempRoot("jx-owner-callback-fail-");
    const ownedRoot = path.join(root, "owned-root");
    fs.mkdirSync(ownedRoot);
    const unregister = registerOwnedResourceCleanup("failing-roots", () => {
      throw new Error("mock rm failure");
    });

    try {
      expect(() => cleanupOwnedResourcesOrThrow()).toThrow(/failing-roots.*mock rm failure/s);
      expect(fs.existsSync(ownedRoot)).toBe(true);
    } finally {
      unregister();
      if (fs.existsSync(ownedRoot)) removeTemporaryRoots([ownedRoot]);
    }
  });

  it("un grupo ya spawneado registrado se detiene en el mismo owner antes de los callbacks de raíz", () => {
    const root = makeTempRoot("jx-owner-register-");
    const ownedRoot = path.join(root, "owned-root");
    fs.mkdirSync(ownedRoot);
    const stopped: number[] = [];
    const release = registerOwnedProcessGroup(999_999, (pid) => {
      stopped.push(pid);
      return { ok: false, cause: "mock stop failure" };
    });
    const unregister = registerOwnedResourceCleanup("registered-group-roots", () =>
      removeTemporaryRoots([ownedRoot]),
    );

    try {
      // El stop no verificado del grupo registrado retiene el root: el callback no corre.
      expect(() => cleanupOwnedResourcesOrThrow()).toThrow(/999999.*mock stop failure/s);
      expect(stopped).toEqual([999_999]);
      expect(fs.existsSync(ownedRoot)).toBe(true);

      // Con el stop verificado, el owner detiene el grupo y luego limpia el root.
      release();
      const releaseOk = registerOwnedProcessGroup(999_999, (pid) => {
        stopped.push(pid);
        return { ok: true };
      });
      cleanupOwnedResourcesOrThrow();
      expect(fs.existsSync(ownedRoot)).toBe(false);
      releaseOk();
    } finally {
      release();
      unregister();
      if (fs.existsSync(ownedRoot)) removeTemporaryRoots([ownedRoot]);
    }
  });
});
