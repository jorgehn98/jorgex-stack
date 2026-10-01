import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NpmPackageRelease } from "../src/lib/npm-provider.js";
import type { StagePiProviderPackagesInput } from "../src/lib/pi-provider-stage.js";
import type { StageRun } from "../src/lib/pi-release-stage.js";

/**
 * T63 RED for the provider-only native Pi stage.
 *
 * Intended code-facing contract (no production change in this RED):
 * - `stagePiProviderPackages({ homeDir, agentDir, piExecutable, releases },
 *   { fetchImpl, run })` is exported from `src/lib/pi-provider-stage.ts`.
 * - The stage downloads each exact release through the existing verified npm
 *   tarball helper, then invokes the Pi executable (never npm) with a local
 *   `npm:<provider>@file:<artifact>` source.
 * - The native install runs with `npm_config_install_strategy=nested` and
 *   `npm_config_ignore_scripts=true` in a private HOME/cache/config tree. The
 *   active Pi agent, settings, receipt and foreign package are never used as
 *   the stage.
 * - Each returned package is backed by a real provider root and a v3 npm lock
 *   whose local file source, version and SRI match the downloaded artifact.
 *   The provider root may contain its own nested closure and `.bin`, but no
 *   foreign root module. Symlink escapes, foreign roots and integrity drift
 *   fail closed before evidence is returned.
 *
 * The fake run below models the native Pi process boundary by writing the
 * smallest useful npm v3 tree. It does not mock private verifier functions.
 * Tarball responses are also supplied through fetch, so the test exercises
 * the existing verified-download seam without network or user HOME access.
 */

type ProviderName = "gentle-engram" | "pi-mcp-adapter";
type ProviderReleases = Record<ProviderName, NpmPackageRelease>;

type ProviderPackageEvidence = {
  name: string;
  version: string;
  integrity: string;
  packageRoot: string;
  treeSha256: string;
  bins: Record<string, string>;
};

type ProviderStageModule = {
  stagePiProviderPackages(
    input: StagePiProviderPackagesInput,
    deps?: { fetchImpl?: typeof fetch; run?: StageRun },
  ): Promise<{ stageDir: string; packages: ProviderPackageEvidence[] }>;
};

type StageCall = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  provider: ProviderName;
  artifactPath: string;
};

const stageSpecifier = new URL("../src/lib/pi-provider-stage.js", import.meta.url).href;
const PI_EXECUTABLE = path.resolve("/opt/pi/bin/pi");
const PROVIDERS: readonly ProviderName[] = ["gentle-engram", "pi-mcp-adapter"];
const BIN_NAMES: Record<ProviderName, string> = {
  "gentle-engram": "gentle-engram",
  "pi-mcp-adapter": "pi-mcp-adapter",
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadProviderStage(): Promise<ProviderStageModule> {
  const mod = (await import(/* @vite-ignore */ stageSpecifier)) as Partial<ProviderStageModule>;
  expect(
    mod.stagePiProviderPackages,
    "stagePiProviderPackages must be exported from src/lib/pi-provider-stage.ts",
  ).toBeTypeOf("function");
  return mod as ProviderStageModule;
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function canonicalTarballUrl(name: ProviderName, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
}

function makeRelease(name: ProviderName, version: string, bytes: Buffer): NpmPackageRelease {
  return { version, tarballUrl: canonicalTarballUrl(name, version), integrity: sri(bytes) };
}

function makeReleases(): { releases: ProviderReleases; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>([
    ["gentle-engram", Buffer.from("official-gentle-engram-stage-tarball\n")],
    ["pi-mcp-adapter", Buffer.from("official-pi-mcp-adapter-stage-tarball\n")],
  ]);
  return {
    bytes,
    releases: {
      "gentle-engram": makeRelease("gentle-engram", "0.1.16", bytes.get("gentle-engram")!),
      "pi-mcp-adapter": makeRelease("pi-mcp-adapter", "3.2.0", bytes.get("pi-mcp-adapter")!),
    },
  };
}

function verifiedTarballFetch(
  releases: ProviderReleases,
  bytes: Map<string, Buffer>,
  corrupt?: ProviderName,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const provider = PROVIDERS.find((name) => releases[name].tarballUrl === url);
    if (provider === undefined) throw new Error(`unexpected npm tarball request: ${url}`);
    const body = corrupt === provider
      ? Buffer.from("tampered-provider-tarball\n")
      : bytes.get(provider)!;
    const response = new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-length": String(body.byteLength), "content-type": "application/octet-stream" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }) as typeof fetch;
}

type ActiveSandbox = {
  root: string;
  homeDir: string;
  agentDir: string;
  settingsPath: string;
  activeFiles: string[];
  releases: ProviderReleases;
  bytes: Map<string, Buffer>;
};

function buildActiveSandbox(): ActiveSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-provider-stage-"));
  sandboxes.push(root);
  const homeDir = path.join(root, "home");
  const agentDir = path.join(homeDir, ".pi", "agent");
  const npmDir = path.join(agentDir, "npm");
  const foreignRoot = path.join(npmDir, "node_modules", "foreign-pkg");
  const managedRoot = path.join(npmDir, "node_modules", "jorgex-pi");
  const managedRelease = path.join(npmDir, "jorgex-pi-managed", "active-release");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(homeDir, ".jorgex-stack", "pi-receipt.json");
  const packageJsonPath = path.join(npmDir, "package.json");
  const lockPath = path.join(npmDir, "package-lock.json");
  const foreignPackagePath = path.join(foreignRoot, "package.json");
  const foreignIndexPath = path.join(foreignRoot, "index.js");
  const managedPackagePath = path.join(managedRoot, "package.json");
  const managedReleaseMarker = path.join(managedRelease, "release.marker");

  fs.mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(managedRelease, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ packages: ["npm:jorgex-pi@file:managed-release", "npm:foreign-pkg@1.0.0"] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: "pi-extensions", private: true })}\n`, { mode: 0o600 });
  fs.writeFileSync(lockPath, `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3, packages: {} })}\n`, { mode: 0o600 });
  fs.writeFileSync(foreignPackagePath, `${JSON.stringify({ name: "foreign-pkg", version: "1.0.0" })}\n`, { mode: 0o600 });
  fs.writeFileSync(foreignIndexPath, "module.exports = 'foreign-pkg';\n", { mode: 0o600 });
  fs.writeFileSync(managedPackagePath, `${JSON.stringify({ name: "jorgex-pi", version: "0.8.37" })}\n`, { mode: 0o600 });
  fs.writeFileSync(managedReleaseMarker, "managed-release-bytes\n", { mode: 0o600 });
  fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, state: "installed" })}\n`, { mode: 0o600 });

  const { releases, bytes } = makeReleases();
  return {
    root,
    homeDir,
    agentDir,
    settingsPath,
    activeFiles: [
      settingsPath,
      packageJsonPath,
      lockPath,
      foreignPackagePath,
      foreignIndexPath,
      managedPackagePath,
      managedReleaseMarker,
      receiptPath,
    ],
    releases,
    bytes,
  };
}

function snapshotFiles(files: readonly string[]): Map<string, Buffer> {
  return new Map(files.map((file) => [file, fs.readFileSync(file)]));
}

function expectFilesUnchanged(before: Map<string, Buffer>): void {
  for (const [file, bytes] of before) expect(fs.readFileSync(file), file).toEqual(bytes);
}

function providerStageRoots(homeDir: string): string[] {
  return fs.readdirSync(homeDir).filter((entry) => entry.startsWith("provider-stage-"));
}

function recordingTarballFetch(sandbox: ActiveSandbox): { requested: string[]; fetchImpl: typeof fetch } {
  const requested: string[] = [];
  const baseFetch = verifiedTarballFetch(sandbox.releases, sandbox.bytes);
  const fetchImpl: typeof fetch = (input, init) => {
    requested.push(String(input));
    return baseFetch(input, init);
  };
  return { requested, fetchImpl };
}

function isStrictChild(root: string, child: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function expectProviderStageCall(call: StageCall, sandbox: ActiveSandbox): void {
  expect(call.executable).toBe(PI_EXECUTABLE);
  expect(call.args).toContain("install");
  expect(call.args.some((arg) => arg === `npm:${call.provider}@file:${call.artifactPath}`)).toBe(true);
  expect(call.args.join(" ")).not.toContain("latest");
  expect(call.args.join(" ")).not.toContain(sandbox.agentDir);
  expect(call.env.npm_config_install_strategy).toBe("nested");
  expect(call.env.npm_config_ignore_scripts).toBe("true");
  expect(call.env.npm_config_audit).toBe("false");
  expect(call.env.npm_config_fund).toBe("false");

  const stageAgentDir = call.env.PI_CODING_AGENT_DIR as string;
  expect(stageAgentDir).toBeDefined();
  expect(path.isAbsolute(stageAgentDir)).toBe(true);
  expect(stageAgentDir).not.toBe(sandbox.agentDir);
  expect(call.cwd).not.toBe(sandbox.agentDir);
  expect(call.env.HOME).toBeDefined();
  expect(call.env.HOME).not.toBe(process.env.HOME ?? "__no_home__");
  expect(isStrictChild(path.dirname(stageAgentDir), call.cwd) || isStrictChild(path.dirname(call.cwd), stageAgentDir)).toBe(true);

  for (const key of [
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "PI_AUTH_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    expect(call.env[key], `${key} must not cross the provider stage boundary`).toBeUndefined();
  }
  if (call.env.npm_config_userconfig !== undefined) {
    expect(call.env.npm_config_userconfig).not.toBe(process.env.npm_config_userconfig);
    expect(isStrictChild(path.dirname(stageAgentDir), call.env.npm_config_userconfig)).toBe(true);
  }
}

function writeNativeProviderFixture(
  call: StageCall,
  release: NpmPackageRelease,
  mode: "valid" | "foreign-root" | "symlink-escape" | "lock-drift",
): void {
  const stageAgentDir = call.env.PI_CODING_AGENT_DIR as string;
  const npmDir = path.join(stageAgentDir, "npm");
  const modulesDir = path.join(npmDir, "node_modules");
  const packageRoot = path.join(modulesDir, call.provider);
  const packageBin = BIN_NAMES[call.provider];
  const binRelative = `bin/${packageBin}.js`;
  const nestedRoot = path.join(packageRoot, "node_modules", "provider-support");
  const artifactRelative = path.relative(npmDir, call.artifactPath).split(path.sep).join("/");
  const fileSpec = `file:${artifactRelative}`;
  const nestedBytes = Buffer.from(`nested closure for ${call.provider}\n`);
  const nestedIntegrity = sri(nestedBytes);

  fs.mkdirSync(nestedRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(path.join(packageRoot, binRelative)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      { name: call.provider, version: release.version, bin: { [packageBin]: binRelative }, dependencies: { "provider-support": "1.0.0" } },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(packageRoot, binRelative), `#!/usr/bin/env node\n// ${call.provider} stage fixture\n`, { mode: 0o700 });
  fs.writeFileSync(
    path.join(nestedRoot, "package.json"),
    `${JSON.stringify({ name: "provider-support", version: "1.0.0" })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(nestedRoot, "index.js"), nestedBytes, { mode: 0o600 });
  fs.mkdirSync(path.join(modulesDir, ".bin"), { recursive: true, mode: 0o700 });
  const binLink = path.join(modulesDir, ".bin", packageBin);
  // npm emits a platform-specific shim here; a regular executable marker is
  // sufficient for the stage boundary and keeps this fixture privilege-free
  // on Windows. The provider's declared bin target is checked below.
  fs.writeFileSync(binLink, `#!/usr/bin/env node\nrequire(${JSON.stringify(path.join(packageRoot, binRelative))});\n`, { mode: 0o700 });

  const packages: Record<string, Record<string, unknown>> = {
    "": { dependencies: { [call.provider]: fileSpec } },
    [`node_modules/${call.provider}`]: {
      version: release.version,
      resolved: fileSpec,
      integrity: mode === "lock-drift" ? sri(Buffer.from("wrong-root-integrity\n")) : release.integrity,
      dependencies: { "provider-support": "1.0.0" },
    },
    [`node_modules/${call.provider}/node_modules/provider-support`]: {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/provider-support/-/provider-support-1.0.0.tgz",
      integrity: nestedIntegrity,
    },
  };
  fs.writeFileSync(
    path.join(npmDir, "package-lock.json"),
    `${JSON.stringify({ name: "pi-extensions", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    `${JSON.stringify({ name: "pi-extensions", private: true, dependencies: { [call.provider]: fileSpec } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (mode === "foreign-root") {
    const foreignRoot = path.join(modulesDir, "foreign-stage-package");
    fs.mkdirSync(foreignRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(foreignRoot, "package.json"), '{"name":"foreign-stage-package","version":"1.0.0"}\n', { mode: 0o600 });
  }
  if (mode === "symlink-escape") {
    const escapeTarget = path.join(path.dirname(stageAgentDir), "outside-provider-stage");
    fs.mkdirSync(escapeTarget, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(escapeTarget, "outside.txt"), "outside stage\n", { mode: 0o600 });
    fs.symlinkSync(
      escapeTarget,
      path.join(packageRoot, "escape-dir"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

function makeRunner(
  sandbox: ActiveSandbox,
  mode: "valid" | "foreign-root" | "symlink-escape" | "lock-drift" = "valid",
): { calls: StageCall[]; run: StageRun } {
  const calls: StageCall[] = [];
  const run: StageRun = (executable, args, options) => {
    const source = args.find((arg) => arg.startsWith("npm:") && arg.includes("@file:"));
    if (source === undefined) throw new Error("provider stage fixture did not receive a file source");
    const separator = source.indexOf("@file:");
    const provider = source.slice("npm:".length, separator) as ProviderName;
    const artifactPath = source.slice(separator + "@file:".length);
    const call: StageCall = {
      executable,
      args: [...args],
      env: { ...options.env },
      cwd: options.cwd,
      provider,
      artifactPath,
    };
    calls.push(call);
    const release = sandbox.releases[provider];
    if (release === undefined) throw new Error(`unexpected provider ${provider}`);
    if (!fs.existsSync(artifactPath)) throw new Error(`downloaded artifact missing: ${artifactPath}`);
    writeNativeProviderFixture(call, release, mode === "valid" ? "valid" : mode);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

function assertValidResult(result: Awaited<ReturnType<ProviderStageModule["stagePiProviderPackages"]>>, sandbox: ActiveSandbox): void {
  expect(path.isAbsolute(result.stageDir)).toBe(true);
  expect(result.stageDir).not.toBe(sandbox.agentDir);
  expect(result.packages).toHaveLength(PROVIDERS.length);
  const byName = new Map(result.packages.map((pkg) => [pkg.name, pkg]));
  for (const provider of PROVIDERS) {
    const release = sandbox.releases[provider];
    const pkg = byName.get(provider);
    expect(pkg).toBeDefined();
    expect(pkg).toMatchObject({ name: provider, version: release.version, integrity: release.integrity });
    expect(pkg!.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(path.isAbsolute(pkg!.packageRoot)).toBe(true);
    expect(isStrictChild(result.stageDir, pkg!.packageRoot)).toBe(true);
    const rootStat = fs.lstatSync(pkg!.packageRoot);
    expect(rootStat.isDirectory()).toBe(true);
    expect(rootStat.isSymbolicLink()).toBe(false);
    expect(pkg!.bins).toEqual({ [BIN_NAMES[provider]]: expect.any(String) });
    const binTarget = pkg!.bins[BIN_NAMES[provider]]!;
    expect(path.isAbsolute(binTarget)).toBe(false);
    const binPath = path.resolve(pkg!.packageRoot, binTarget);
    expect(isStrictChild(pkg!.packageRoot, binPath)).toBe(true);
    expect(fs.statSync(binPath).isFile()).toBe(true);

    const rootModules = fs.readdirSync(path.dirname(pkg!.packageRoot));
    expect(rootModules.filter((entry) => entry !== ".bin")).toEqual([provider]);
    expect(fs.existsSync(path.join(pkg!.packageRoot, "node_modules", "provider-support", "package.json"))).toBe(true);
  }
}

describe("[T63-RED] isolated native Pi provider stage", () => {
  it("downloads both exact providers, stages nested closures, and leaves active Pi state byte-identical", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const { calls, run } = makeRunner(sandbox);

    const result = await stage.stagePiProviderPackages(
      {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        releases: sandbox.releases,
      },
      { fetchImpl: verifiedTarballFetch(sandbox.releases, sandbox.bytes), run },
    );

    expect(calls).toHaveLength(PROVIDERS.length);
    for (const call of calls) expectProviderStageCall(call, sandbox);
    expect(new Set(calls.map((call) => call.provider))).toEqual(new Set(PROVIDERS));
    assertValidResult(result, sandbox);
    expectFilesUnchanged(before);
  });

  it("rejects a native stage with a foreign root or an escaping symlink before returning evidence", async () => {
    for (const mode of ["foreign-root", "symlink-escape"] as const) {
      const stage = await loadProviderStage();
      const sandbox = buildActiveSandbox();
      const before = snapshotFiles(sandbox.activeFiles);
      const { calls, run } = makeRunner(sandbox, mode);

      const failure = await stage.stagePiProviderPackages(
        {
          homeDir: sandbox.homeDir,
          agentDir: sandbox.agentDir,
          piExecutable: PI_EXECUTABLE,
          releases: sandbox.releases,
        },
        { fetchImpl: verifiedTarballFetch(sandbox.releases, sandbox.bytes), run },
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toMatch(/pi-provider-stage|foreign|escape|symlink|root/i);
      expect(calls.length).toBeGreaterThan(0);
      expectFilesUnchanged(before);
    }
  });

  it("fails closed on a downloaded provider SRI mismatch without invoking native Pi", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const { calls, run } = makeRunner(sandbox);

    const failure = await stage.stagePiProviderPackages(
      {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        releases: sandbox.releases,
      },
      {
        fetchImpl: verifiedTarballFetch(sandbox.releases, sandbox.bytes, "pi-mcp-adapter"),
        run,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/integrity|SRI|npm-provider|pi-provider-stage/i);
    expect(calls).toHaveLength(0);
    expectFilesUnchanged(before);
  });
});

describe("native gentle-only Pi provider stage", () => {
  it("acquires and returns only the mandatory gentle-engram provider for a verified native transport", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const { calls, run } = makeRunner(sandbox);
    const gentleRelease = sandbox.releases["gentle-engram"];
    const { requested, fetchImpl } = recordingTarballFetch(sandbox);

    const result = await stage.stagePiProviderPackages(
      {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        mcpTransport: "native",
        releases: { "gentle-engram": gentleRelease },
      },
      { fetchImpl, run },
    );

    expect(requested).toEqual([gentleRelease.tarballUrl]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.provider).toBe("gentle-engram");
    expectProviderStageCall(call, sandbox);
    expect(call.args.join(" ")).not.toContain("pi-mcp-adapter");

    expect(result.packages).toHaveLength(1);
    const pkg = result.packages[0]!;
    expect(pkg).toMatchObject({ name: "gentle-engram", version: gentleRelease.version, integrity: gentleRelease.integrity });
    expect(pkg.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(path.isAbsolute(pkg.packageRoot)).toBe(true);
    expect(isStrictChild(result.stageDir, pkg.packageRoot)).toBe(true);
    const rootStat = fs.lstatSync(pkg.packageRoot);
    expect(rootStat.isDirectory()).toBe(true);
    expect(rootStat.isSymbolicLink()).toBe(false);
    expect(pkg.bins).toEqual({ "gentle-engram": expect.any(String) });
    const binTarget = pkg.bins["gentle-engram"]!;
    expect(path.isAbsolute(binTarget)).toBe(false);
    const binPath = path.resolve(pkg.packageRoot, binTarget);
    expect(isStrictChild(pkg.packageRoot, binPath)).toBe(true);
    expect(fs.statSync(binPath).isFile()).toBe(true);
    expectFilesUnchanged(before);
  });

  it("rejects an unknown or null mcpTransport before any download or native Pi run", async () => {
    for (const value of ["bogus", null] as const) {
      const stage = await loadProviderStage();
      const sandbox = buildActiveSandbox();
      const before = snapshotFiles(sandbox.activeFiles);
      const stageRootsBefore = providerStageRoots(sandbox.homeDir);
      const { calls, run } = makeRunner(sandbox);
      const { requested, fetchImpl } = recordingTarballFetch(sandbox);
      const badInput = {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        mcpTransport: value,
        releases: { "gentle-engram": sandbox.releases["gentle-engram"] },
      } as unknown as StagePiProviderPackagesInput;

      const failure = await stage.stagePiProviderPackages(
        badInput,
        { fetchImpl, run },
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('pi-provider-stage: mcpTransport must be "native" or "legacy" when present');
      expect(requested).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(providerStageRoots(sandbox.homeDir)).toEqual(stageRootsBefore);
      expectFilesUnchanged(before);
    }
  });

  it("rejects a native transport that also declares a pi-mcp-adapter release before any download or native Pi run", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const stageRootsBefore = providerStageRoots(sandbox.homeDir);
    const gentleRelease = sandbox.releases["gentle-engram"];

    // The explicit `undefined` entry protects the hasOwnProperty presence
    // check: the key's presence, not its value, contradicts native transport.
    for (const adapterRelease of [sandbox.releases["pi-mcp-adapter"], undefined]) {
      const { calls, run } = makeRunner(sandbox);
      const { requested, fetchImpl } = recordingTarballFetch(sandbox);
      const contradictoryInput = {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        mcpTransport: "native",
        releases: { "gentle-engram": gentleRelease, "pi-mcp-adapter": adapterRelease },
      } as unknown as StagePiProviderPackagesInput;

      const failure = await stage.stagePiProviderPackages(
        contradictoryInput,
        { fetchImpl, run },
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("pi-provider-stage: native transport is contradictory with a pi-mcp-adapter release");
      expect(requested).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }

    expect(providerStageRoots(sandbox.homeDir)).toEqual(stageRootsBefore);
    expectFilesUnchanged(before);
  });

  it("rejects a default legacy stage that omits the pi-mcp-adapter release before any download or native Pi run", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const stageRootsBefore = providerStageRoots(sandbox.homeDir);
    const { calls, run } = makeRunner(sandbox);
    const { requested, fetchImpl } = recordingTarballFetch(sandbox);
    const badInput = {
      homeDir: sandbox.homeDir,
      agentDir: sandbox.agentDir,
      piExecutable: PI_EXECUTABLE,
      releases: { "gentle-engram": sandbox.releases["gentle-engram"] },
    } as unknown as StagePiProviderPackagesInput;

    const failure = await stage.stagePiProviderPackages(
      badInput,
      { fetchImpl, run },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("pi-provider-stage: pi-mcp-adapter release must be an object");
    expect(requested).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(providerStageRoots(sandbox.homeDir)).toEqual(stageRootsBefore);
    expectFilesUnchanged(before);
  });

  it("fails closed on a native gentle-engram SRI mismatch without invoking native Pi", async () => {
    const stage = await loadProviderStage();
    const sandbox = buildActiveSandbox();
    const before = snapshotFiles(sandbox.activeFiles);
    const { calls, run } = makeRunner(sandbox);
    const gentleRelease = sandbox.releases["gentle-engram"];

    const failure = await stage.stagePiProviderPackages(
      {
        homeDir: sandbox.homeDir,
        agentDir: sandbox.agentDir,
        piExecutable: PI_EXECUTABLE,
        mcpTransport: "native",
        releases: { "gentle-engram": gentleRelease },
      },
      { fetchImpl: verifiedTarballFetch(sandbox.releases, sandbox.bytes, "gentle-engram"), run },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/integrity|SRI|npm-provider|pi-provider-stage/i);
    expect(calls).toHaveLength(0);
    expectFilesUnchanged(before);
  });
});
