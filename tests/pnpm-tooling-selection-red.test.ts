import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PNPM_FAIL_CLOSED,
  PNPM_PM_ON_FAIL_ENV,
  PNPM_VERIFY_DEPS_ENV,
  PREPARED_PNPM_ENTRY_ENV,
  VERIFICATION_DISK_ROOT_ENV,
  prepareRepoBuildRun,
  resolvePnpmBuildInvocation,
  resolveVerificationDiskBase,
  type BoundedProcessOptions,
  type BoundedProcessResult,
  type BoundedProcessRunner,
  type ProcessInvocation,
} from "./helpers/pnpm-tooling.js";

/**
 * Regression for the recursive pnpm acquisition: the quality acceptance path
 * previously resolved `pnpm build` through Corepack or an ambiguous PATH
 * fallback without checking identity/version, letting an old pnpm switch
 * versions and acquire packages until resources were exhausted.
 *
 * Contract under protection: before any build, the tooling selector must
 * resolve an absolute prepared pnpm entrypoint, trust only its package metadata
 * (name `pnpm`, declared `bin.pnpm`, exact `packageManager` version), confirm
 * the real `--version` through the existing bounded runner, and refuse to
 * continue on missing/incorrect/unknown tools without spawning any
 * install/acquisition process. The bounded runner is injected so this
 * regression intercepts process creation instead of reproducing the real chain.
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

function makeRepo(packageManager: string): string {
  const root = makeTempRoot("jx-pnpm-repo-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", packageManager })}\n`,
    "utf8",
  );
  return root;
}

type PnpmFixture = {
  packageRoot: string;
  entry: string;
};

function makePnpmPackage(
  version: string,
  options: { name?: string; binName?: string } = {},
): PnpmFixture {
  const packageRoot = path.join(makeTempRoot("jx-pnpm-pkg-"), "node_modules", "pnpm");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "bin", "pnpm.mjs"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(path.join(packageRoot, "bin", "pnpm.cjs"), "// compat stub\n", "utf8");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: options.name ?? "pnpm",
      version,
      bin: { pnpm: options.binName ?? "bin/pnpm.mjs" },
    })}\n`,
    "utf8",
  );
  return { packageRoot, entry: path.join(packageRoot, "bin", "pnpm.mjs") };
}

type RecordedCall = {
  invocation: ProcessInvocation;
  options: BoundedProcessOptions;
};

function recordingRunner(
  result: Partial<BoundedProcessResult> = {},
): { calls: RecordedCall[]; run: BoundedProcessRunner } {
  const calls: RecordedCall[] = [];
  const run: BoundedProcessRunner = async (invocation, options) => {
    calls.push({ invocation, options });
    return {
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...result,
    };
  };
  return { calls, run };
}

const REQUIRED_VERSION = "11.1.1";

describe("pnpm tooling selection preflight", () => {
  it("resuelve el binario declarado del pnpm exacto y comprueba --version con el runner acotado", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmBuildInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    expect(runner.calls).toHaveLength(1);
    const check = runner.calls[0];
    expect(check).toBeDefined();
    expect(check?.invocation.command).toBe(process.execPath);
    expect(check?.invocation.args).toEqual([pnpm.entry, "--version"]);
    expect(check?.options.cwd).toBe(repoRoot);
    expect(check?.options.timeoutMs).toBe(1_000);
    expect(check?.options.env?.[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(check?.options.env?.[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([pnpm.entry, "build"]);
    expect(resolved.env[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
  });

  it("aplica las guardas fail-closed de pnpm 11 en la comprobación y en el build para no instalar dependencias implícitamente", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmBuildInvocation({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [PNPM_VERIFY_DEPS_ENV]: "install",
        [PNPM_PM_ON_FAIL_ENV]: "download",
      },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    const checkEnv = runner.calls[0]?.options.env;
    expect(checkEnv?.[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(checkEnv?.[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env).not.toHaveProperty("npm_config_manage_package_manager_versions");
  });

  it("resuelve el binario declarado por la metadata aunque la ruta preparada use el stub .cjs", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmBuildInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: path.join(pnpm.packageRoot, "bin", "pnpm.cjs") },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    expect(runner.calls[0]?.invocation.args).toEqual([pnpm.entry, "--version"]);
    expect(resolved.args).toEqual([pnpm.entry, "build"]);
  });

  it("rechaza un pnpm preparado con versión distinta antes de crear cualquier proceso", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage("11.22.0");
    const runner = recordingRunner({ stdout: "11.22.0\n" });

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/11\.22\.0.*pnpm@11\.1\.1|pnpm@11\.1\.1.*11\.22\.0/s);
    expect(runner.calls).toHaveLength(0);
  });

  it("rechaza la ausencia de pnpm preparado y una ruta inexistente sin recurrir a Corepack ni PATH", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const runner = recordingRunner();

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: {},
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(new RegExp(PREPARED_PNPM_ENTRY_ENV));

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: path.join(repoRoot, "missing", "pnpm.mjs") },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/missing[\\/]pnpm\.mjs/);

    expect(runner.calls).toHaveLength(0);
  });

  it("rechaza un entrypoint que no declara el paquete pnpm", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION, { name: "pnpm-compat" });
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/pnpm/);
    expect(runner.calls).toHaveLength(0);
  });

  it("rechaza cuando --version informa otra versión aunque la metadata coincida", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: "10.0.0\n" });

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/10\.0\.0/);
    expect(runner.calls).toHaveLength(1);
  });

  it("rechaza packageManager con rango o hash en vez de una versión exacta", async () => {
    const runner = recordingRunner();
    const ranged = makeRepo("pnpm@^11.1.1");
    const pinned = makeRepo("pnpm@11.1.1+sha512.abc");

    for (const repoRoot of [ranged, pinned]) {
      await expect(
        resolvePnpmBuildInvocation({
          repoRoot,
          env: { [PREPARED_PNPM_ENTRY_ENV]: path.join(repoRoot, "pnpm.mjs") },
          runProcess: runner.run,
          versionCheckTimeoutMs: 1_000,
        }),
      ).rejects.toThrow(/packageManager/);
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("conserva el entorno ya aislado y añade las guardas fail-closed en la comprobación y en el build", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });
    const isolatedHome = path.join(makeTempRoot("jx-pnpm-home-"), "home");
    const isolatedTemp = path.join(makeTempRoot("jx-pnpm-tmp-"), "temp");

    const resolved = await resolvePnpmBuildInvocation({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        HOME: isolatedHome,
        TEMP: isolatedTemp,
      },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    const checkEnv = runner.calls[0]?.options.env;
    expect(checkEnv?.HOME).toBe(isolatedHome);
    expect(checkEnv?.TEMP).toBe(isolatedTemp);
    expect(checkEnv?.[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(checkEnv?.[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env.HOME).toBe(isolatedHome);
    expect(resolved.env.TEMP).toBe(isolatedTemp);
    expect(resolved.env[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(resolved.env[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
  });

  it("no crea ningún proceso de instalación, adquisición o corepack", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    await resolvePnpmBuildInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    for (const call of runner.calls) {
      expect(call.invocation.command).toBe(process.execPath);
      expect(call.invocation.command).not.toMatch(/corepack|pnpm|npm|npx/i);
      expect(call.invocation.args[0]).toBe(pnpm.entry);
      expect(call.invocation.args[1]).toBe("--version");
      expect(call.invocation.args).not.toContain("install");
      expect(call.invocation.args).not.toContain("add");
    }
  });

  it("exige salida exacta de --version y no acepta ruido ni el último token", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `warn: nodo antiguo\n${REQUIRED_VERSION}\n` });

    await expect(
      resolvePnpmBuildInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/exacta/);
    expect(runner.calls).toHaveLength(1);
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Walks up from the worktree until it leaves every workspace ancestor and the
 * `worktrees`/`node_modules` segments, giving a real disk base for tests.
 */
function findDiskBaseOutsideWorkspace(): string {
  let current = REPO_ROOT;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No hay base de disco fuera del workspace desde ${REPO_ROOT}`);
    current = parent;
    const segments = current.split(path.sep);
    const hasWorkspace = fs.existsSync(path.join(current, "pnpm-workspace.yaml"));
    const badSegment = segments.includes("worktrees") || segments.includes("node_modules");
    if (!hasWorkspace && !badSegment) return current;
  }
}

function makeDiskBase(): string {
  const base = fs.mkdtempSync(path.join(findDiskBaseOutsideWorkspace(), ".jx-verify-test-base-"));
  tempRoots.push(base);
  return base;
}

describe("verification isolation at the real acceptance caller seam", () => {
  it("usa npm_execpath como entrypoint preparado cuando no hay override explícito", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmBuildInvocation({
      repoRoot,
      env: { npm_execpath: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    expect(resolved.args).toEqual([pnpm.entry, "build"]);
  });

  it.skipIf(process.platform === "win32")(
    "resuelve el paquete declarado a través de un entrypoint symlink (npm_execpath global)",
    async () => {
      const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
      const pnpm = makePnpmPackage(REQUIRED_VERSION);
      const link = path.join(makeTempRoot("jx-pnpm-link-"), "pnpm");
      fs.symlinkSync(pnpm.entry, link);
      const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

      const resolved = await resolvePnpmBuildInvocation({
        repoRoot,
        env: { npm_execpath: link },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      });

      expect(resolved.args).toEqual([pnpm.entry, "build"]);
      expect(runner.calls[0]?.invocation.args).toEqual([pnpm.entry, "--version"]);
    },
  );

  it("resuelve una base de disco y rechaza workspace, node_modules y worktrees (TMPDIR en disco permitido)", () => {
    const diskBase = makeDiskBase();

    expect(
      resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { [VERIFICATION_DISK_ROOT_ENV]: diskBase },
      }),
    ).toBe(fs.realpathSync(diskBase));

    expect(() =>
      resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { [VERIFICATION_DISK_ROOT_ENV]: REPO_ROOT },
      }),
    ).toThrow(/workspace/);

    const underTmp = makeTempRoot("jx-tempdir-base-");
    const tmpFsType = fs.statfsSync(underTmp).type;
    const tmpIsRam = tmpFsType === 0x01021994 || tmpFsType === 0x858458f6;
    if (tmpIsRam) {
      expect(() =>
        resolveVerificationDiskBase({
          repoRoot: REPO_ROOT,
          env: { [VERIFICATION_DISK_ROOT_ENV]: underTmp },
        }),
      ).toThrow(/RAM/);
    } else {
      expect(
        resolveVerificationDiskBase({
          repoRoot: REPO_ROOT,
          env: { [VERIFICATION_DISK_ROOT_ENV]: underTmp },
        }),
      ).toBe(fs.realpathSync(underTmp));
    }

    const nodeModulesBase = path.join(diskBase, "node_modules");
    fs.mkdirSync(nodeModulesBase, { recursive: true });
    expect(() =>
      resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { [VERIFICATION_DISK_ROOT_ENV]: nodeModulesBase },
      }),
    ).toThrow(/node_modules/);

    const worktreesBase = path.join(diskBase, "worktrees");
    fs.mkdirSync(worktreesBase, { recursive: true });
    expect(() =>
      resolveVerificationDiskBase({
        repoRoot: REPO_ROOT,
        env: { [VERIFICATION_DISK_ROOT_ENV]: worktreesBase },
      }),
    ).toThrow(/worktrees/);
  });

  it("preflight exacto antes de crear el HOME privado, con teardown armado antes de crear y guardas preservadas", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const diskBase = makeDiskBase();
    const ambientHome = path.join(makeTempRoot("jx-ambient-home-"), "home");
    const ambientXdg = {
      XDG_CONFIG_HOME: path.join(makeTempRoot("jx-ambient-xdg-config-"), "config"),
      XDG_DATA_HOME: path.join(makeTempRoot("jx-ambient-xdg-data-"), "data"),
      XDG_CACHE_HOME: path.join(makeTempRoot("jx-ambient-xdg-cache-"), "cache"),
    };
    const sequence: string[] = [];
    const existedAtRegistration: boolean[] = [];
    const baseRunner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });
    const run: BoundedProcessRunner = async (invocation, options) => {
      sequence.push("preflight");
      return baseRunner.run(invocation, options);
    };
    const registerTempRoot = (root: string): void => {
      sequence.push("home");
      existedAtRegistration.push(fs.existsSync(root));
      tempRoots.push(root);
    };

    const prepared = await prepareRepoBuildRun({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [VERIFICATION_DISK_ROOT_ENV]: diskBase,
        HOME: ambientHome,
        ...ambientXdg,
      },
      runProcess: run,
      versionCheckTimeoutMs: 1_000,
      registerTempRoot,
    });

    expect(sequence).toEqual(["preflight", "home"]);
    expect(existedAtRegistration).toEqual([false]);
    expect(baseRunner.calls).toHaveLength(1);
    expect(baseRunner.calls[0]?.options.env?.HOME).toBe(ambientHome);
    expect(baseRunner.calls[0]?.options.env?.XDG_CONFIG_HOME).toBe(ambientXdg.XDG_CONFIG_HOME);
    expect(baseRunner.calls[0]?.options.env?.[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(baseRunner.calls[0]?.options.env?.[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);

    expect(prepared.invocation.args).toEqual([pnpm.entry, "build"]);
    expect(prepared.env.HOME).toBe(path.join(prepared.root, "home"));
    expect(prepared.env.HOME).not.toBe(ambientHome);
    expect(prepared.env.XDG_CONFIG_HOME).toBe(path.join(prepared.root, "xdg-config"));
    expect(prepared.env.XDG_DATA_HOME).toBe(path.join(prepared.root, "xdg-data"));
    expect(prepared.env.XDG_CACHE_HOME).toBe(path.join(prepared.root, "xdg-cache"));
    expect(prepared.env.XDG_CONFIG_HOME).not.toBe(ambientXdg.XDG_CONFIG_HOME);
    expect(prepared.env[PNPM_VERIFY_DEPS_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(prepared.env[PNPM_PM_ON_FAIL_ENV]).toBe(PNPM_FAIL_CLOSED);
    expect(fs.statSync(prepared.root).isDirectory()).toBe(true);
    expect(path.relative(REPO_ROOT, prepared.root).startsWith("..")).toBe(true);
    expect(prepared.root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(false);
  });

  it("rechaza una base de disco inválida tras el preflight y sin crear HOME", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });
    const registered: string[] = [];

    await expect(
      prepareRepoBuildRun({
        repoRoot,
        env: {
          [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
          [VERIFICATION_DISK_ROOT_ENV]: repoRoot,
        },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
        registerTempRoot: (root) => registered.push(root),
      }),
    ).rejects.toThrow(/workspace/);

    expect(runner.calls).toHaveLength(1);
    expect(registered).toEqual([]);
  });
});
