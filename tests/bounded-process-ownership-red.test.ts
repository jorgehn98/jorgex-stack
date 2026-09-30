import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runBoundedProcess,
  stopOwnProcessTree,
  type BoundedProcessResult,
  type StopOwnProcessGroup,
} from "./helpers/bounded-process.js";

/**
 * Own-group ownership: the leader can exit while an inert descendant stays
 * alive, so the runner stops its own PID/group on close and surfaces
 * cleanup failures instead of falling back to a child-only kill.
 *
 * Seam: the runner itself, with real OS processes but no pnpm chain.
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }
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

const GRANDCHILD_SCRIPT =
  "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), Number(process.argv[2]))";

const LEADER_EXITS_IMMEDIATELY = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', process.argv[1], '--', process.argv[2], process.argv[3]], { stdio: 'ignore' });",
  "child.unref();",
  "process.exit(0);",
].join("\n");

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
      for (const pid of observedPids) stopOwnProcessTree(pid);
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
