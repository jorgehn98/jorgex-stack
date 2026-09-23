import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PI_RUNTIME_ARCHIVE, PI_RUNTIME_CANDIDATE, STACK_ENGRAM_PROVIDER_ONLY } from "./fixtures/pi-runtime.js";
import { runPiProjectionLifecycleSystem } from "../src/lib/pi-projection-lifecycle.js";
import { stackRoot } from "../src/lib/paths.js";

const piDirectory = process.env.JORGEX_PI_DIR;
const crossRepo = piDirectory === undefined ? describe.skip : describe;
const registryTarball = process.env.JORGEX_PI_TARBALL;
const registryCandidateRaw = process.env.JORGEX_PI_CANDIDATE;
const hasObservedRegistryInputs = registryTarball !== undefined && registryCandidateRaw !== undefined;
const registryArtifact = hasObservedRegistryInputs ? describe : describe.skip;
const piBinRaw = process.env.JORGEX_PI_BIN;
const temporaryPaths: string[] = [];

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function digest(algorithm: "sha256" | "sha512", file: string): string {
  return createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
}

function listTarEntries(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd().split(/\r?\n/);
}

function expectExactArtifactIntegrity(tarball: string): void {
  const stats = fs.statSync(tarball);
  expect(stats.isFile()).toBe(true);
  expect(stats.size).toBe(PI_RUNTIME_CANDIDATE.tarball.bytes);
  expect(digest("sha256", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha256);
  expect(digest("sha512", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha512);
}

// ---------------------------------------------------------------------------
// Observed candidate (T06/T09 PR02): CI resolves the live published Pi via
// dist/pi-ci-artifact.js and freezes {version,tarballUrl,integrity,bytes,
// sha256,sha512} as bounded private JSON. JORGEX_PI_CANDIDATE is that JSON
// file path (workflow: ${{ runner.temp }}/pi-observed.json) or the inline
// JSON itself. The .29 receipt/pin fixtures stay historical/offline and are
// never the next selector; the observed version (currently .31 unbundled)
// is the only selector for registry checks below. No fixture .31/hashes.
// ---------------------------------------------------------------------------

interface ObservedPiCandidate {
  version: string;
  tarballUrl: string;
  integrity: string;
  bytes: number;
  sha256: string;
  sha512: string;
}

function canonicalObservedTarballUrl(version: string): string {
  return `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`;
}

function canonicalObservedSource(version: string): string {
  return `npm:jorgex-pi@${version}`;
}

function readObservedCandidate(): ObservedPiCandidate {
  const raw = process.env.JORGEX_PI_CANDIDATE;
  expect(raw, "JORGEX_PI_CANDIDATE must be set for observed registry checks").toBeTypeOf("string");
  const rawValue = raw as string;
  expect(Buffer.byteLength(rawValue, "utf8")).toBeLessThan(64 * 1024);
  let text: string;
  let resolvedPath: string | null = null;
  try {
    const candidateStat = fs.lstatSync(rawValue);
    if (candidateStat.isFile() && !candidateStat.isSymbolicLink()) {
      expect(candidateStat.size).toBeLessThan(64 * 1024);
      resolvedPath = path.resolve(rawValue);
      text = fs.readFileSync(resolvedPath, "utf8");
    } else {
      text = rawValue;
    }
  } catch {
    text = rawValue;
  }
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(64 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("JORGEX_PI_CANDIDATE is not valid JSON");
  }
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  const record = parsed as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual(["bytes", "integrity", "sha256", "sha512", "tarballUrl", "version"]);
  const { version, tarballUrl, integrity, bytes, sha256, sha512 } = record as {
    version: unknown;
    tarballUrl: unknown;
    integrity: unknown;
    bytes: unknown;
    sha256: unknown;
    sha512: unknown;
  };
  expect(typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)).toBe(true);
  const observedVersion = version as string;
  expect(tarballUrl).toBe(canonicalObservedTarballUrl(observedVersion));
  expect(typeof integrity === "string" && (integrity as string).startsWith("sha512-")).toBe(true);
  const integrityValue = integrity as string;
  const b64 = integrityValue.slice("sha512-".length);
  expect(/^[A-Za-z0-9+/]+={0,2}$/.test(b64)).toBe(true);
  const integrityBytes = Buffer.from(b64, "base64");
  expect(integrityBytes.length).toBe(64);
  expect(integrityBytes.toString("base64")).toBe(b64);
  expect(typeof bytes === "number" && Number.isInteger(bytes) && (bytes as number) > 0).toBe(true);
  expect((bytes as number)).toBeLessThanOrEqual(128 * 1024 * 1024);
  expect(typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256 as string)).toBe(true);
  expect(typeof sha512 === "string" && /^[0-9a-f]{128}$/.test(sha512 as string)).toBe(true);
  const expectedIntegrity = `sha512-${Buffer.from(sha512 as string, "hex").toString("base64")}`;
  expect(integrityValue).toBe(expectedIntegrity);
  expect(resolvedPath === null ? true : path.isAbsolute(resolvedPath)).toBe(true);
  return { version: observedVersion, tarballUrl: tarballUrl as string, integrity: integrityValue, bytes: bytes as number, sha256: sha256 as string, sha512: sha512 as string };
}

function expectObservedArtifactIntegrity(tarball: string, observed: ObservedPiCandidate): void {
  const stats = fs.statSync(tarball);
  expect(stats.isFile()).toBe(true);
  expect(stats.size).toBe(observed.bytes);
  expect(digest("sha256", tarball)).toBe(observed.sha256);
  expect(digest("sha512", tarball)).toBe(observed.sha512);
  const expectedIntegrity = `sha512-${Buffer.from(observed.sha512, "hex").toString("base64")}`;
  expect(observed.integrity).toBe(expectedIntegrity);
}

const OBSERVED_UNBUNDLED_RUNTIME_DEPS = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "@narumitw/pi-goal",
  "pi-subagents",
  "pi-web-access",
  "strip-json-comments",
] as const;

function expectUnbundledProducerInventory(tarball: string, manifest: { dependencies?: unknown; bundledDependencies?: unknown }): void {
  expect(manifest.bundledDependencies).toBeUndefined();
  expect(manifest.dependencies).not.toBeNull();
  expect(typeof manifest.dependencies).toBe("object");
  expect(Array.isArray(manifest.dependencies)).toBe(false);
  const dependencies = manifest.dependencies as Record<string, unknown>;
  expect(Object.keys(dependencies).sort()).toEqual([...OBSERVED_UNBUNDLED_RUNTIME_DEPS].sort());
  for (const dep of OBSERVED_UNBUNDLED_RUNTIME_DEPS) {
    expect(dependencies[dep]).toBe("*");
  }
  const entries = listTarEntries(tarball);
  expect(entries.some((entry) => entry.startsWith("package/node_modules/"))).toBe(false);
  expect(entries).toContain("package/package.json");
  expect(entries).toContain("package/bin/jorgex-pi.mjs");
  expect(entries).toContain("package/contract/jorgex-pi.v1.json");
  expect(entries).toContain("package/contract/runner.v1.json");
  expect(entries).toContain("package/contract/assets.v1.json");
  expect(entries).toContain("package/contract/parity.v2.json");
}

function expectObservedRunnerOutput(
  output: { stdout: string; stderr: string },
  command: "sync" | "cleanup" | "doctor",
  packageRunner: string,
  observedVersion: string,
): void {
  expect(output.stderr).toBe("");
  expect(output.stdout.endsWith("\n")).toBe(true);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes);
  const body = output.stdout.slice(0, -1);
  expect(body).not.toBe("");
  expect(body).not.toMatch(/[\r\n]/);
  const parsed: unknown = JSON.parse(body);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  const record = parsed as { schemaVersion?: unknown; command?: unknown; ok?: unknown; package?: unknown };
  expect(record.schemaVersion).toBe(PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion);
  expect(record.command).toBe(command);
  expect(record.ok).toBe(true);
  const packageInfo = record.package as { name?: unknown; version?: unknown; root?: unknown };
  expect(packageInfo.name).toBe("jorgex-pi");
  expect(packageInfo.version).toBe(observedVersion);
  expect(typeof packageInfo.root).toBe("string");
  expect(path.resolve(packageInfo.root as string, "bin", "jorgex-pi.mjs")).toBe(path.resolve(packageRunner));
}

function readTarJson(tarball: string, entry: string): unknown {
  return JSON.parse(execFileSync("tar", ["-xOf", tarball, entry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })) as unknown;
}

function packTarball(root: string): string {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-cross-repo-pack-"));
  temporaryPaths.push(packDir);
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  const tarballs = fs.readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return path.join(packDir, tarballs[0]!);
}

function expectArchiveInventory(tarball: string): void {
  const entries = new Set(listTarEntries(tarball));
  expect(entries.size).toBe(PI_RUNTIME_ARCHIVE.entries);
  expect(entries.has(`package/${PI_RUNTIME_ARCHIVE.workAudit.asset}`)).toBe(true);
  for (const asset of PI_RUNTIME_ARCHIVE.brandingAssets) {
    expect(entries.has(`package/${asset}`), asset).toBe(true);
  }
  for (const asset of PI_RUNTIME_ARCHIVE.qualityAssets) {
    expect(entries.has(`package/${asset}`), asset).toBe(true);
  }
  const packedManifest = readTarJson(tarball, "package/package.json") as {
    bundledDependencies?: unknown;
    pi?: { skills?: unknown };
  };
  expect(packedManifest.pi?.skills).toEqual(expect.arrayContaining([PI_RUNTIME_ARCHIVE.workAudit.manifestEntry]));
  expect(packedManifest.bundledDependencies).toEqual(PI_RUNTIME_ARCHIVE.bundledDependencies);
  for (const dependency of PI_RUNTIME_ARCHIVE.bundledDependencies) {
    expect(entries.has(`package/node_modules/${dependency}/package.json`), dependency).toBe(true);
  }
  for (const dependency of PI_RUNTIME_ARCHIVE.closurePackageManifests) {
    expect(entries.has(`package/node_modules/${dependency}/package.json`), dependency).toBe(true);
  }
  for (const binding of PI_RUNTIME_ARCHIVE.nativeBindings) {
    expect(entries.has(`package/node_modules/${binding}`), binding).toBe(true);
  }
}

function writeFakePlaywright(root: string): string {
  const bin = path.join(root, "bin", process.platform === "win32" ? "playwright-cli.cmd" : "playwright-cli");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(bin, "@echo off\r\necho 0.1.18\r\n");
  } else {
    fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write("0.1.18\\n");\n`);
    fs.chmodSync(bin, 0o755);
  }
  return bin;
}

function expectRunnerOutput(
  output: { stdout: string; stderr: string },
  command: "sync" | "cleanup",
  packageRunner: string,
): void {
  expect(output.stderr).toBe("");
  expect(output.stdout.endsWith("\n")).toBe(true);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes);

  const body = output.stdout.slice(0, -1);
  expect(body).not.toBe("");
  expect(body).not.toMatch(/[\r\n]/);

  const parsed: unknown = JSON.parse(body);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  const record = parsed as {
    schemaVersion?: unknown;
    command?: unknown;
    ok?: unknown;
    package?: unknown;
  };
  expect(record.schemaVersion).toBe(PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion);
  expect(record.command).toBe(command);
  expect(record.ok).toBe(true);
  expect(record.package).not.toBeNull();
  expect(typeof record.package).toBe("object");
  expect(Array.isArray(record.package)).toBe(false);
  const packageInfo = record.package as { name?: unknown; version?: unknown; root?: unknown };
  expect(packageInfo.name).toBe(PI_RUNTIME_CANDIDATE.package.name);
  expect(packageInfo.version).toBe(PI_RUNTIME_CANDIDATE.package.version);
  expect(typeof packageInfo.root).toBe("string");
  const packageRoot = packageInfo.root as string;
  expect(path.isAbsolute(packageRoot)).toBe(true);
  expect(path.resolve(packageRoot, "bin", "jorgex-pi.mjs")).toBe(path.resolve(packageRunner));
}

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

registryArtifact("observed npm artifact for the published jorgex-pi candidate", () => {
  let observed: ObservedPiCandidate;
  beforeAll(() => {
    observed = readObservedCandidate();
    expectObservedArtifactIntegrity(path.resolve(registryTarball!), observed);
  });

  it("matches the observed bytes, digests, package contract, and unbundled inventory", () => {
    const tarball = path.resolve(registryTarball!);
    const observedLocal = readObservedCandidate();
    expect(observedLocal).toEqual(observed);
    expectObservedArtifactIntegrity(tarball, observedLocal);
    const expectedSource = canonicalObservedSource(observedLocal.version);

    const manifest = readTarJson(tarball, "package/package.json") as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
      bundledDependencies?: unknown;
    };
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as {
      package?: unknown;
      pi?: { testedVersions?: unknown };
      capabilities?: unknown;
    };
    const runner = readTarJson(tarball, "package/contract/runner.v1.json") as {
      schemaVersion?: unknown;
      bin?: unknown;
      commands?: unknown;
      stdout?: { maxBytes?: unknown };
      experience?: { diagnostic?: unknown };
      permissions?: { diagnostic?: unknown };
    };
    const assets = readTarJson(tarball, "package/contract/assets.v1.json") as { managedExternalWrites?: unknown };
    const parity = readTarJson(tarball, "package/contract/parity.v2.json") as {
      source?: { commit?: unknown };
    };
    // Actual package version comes from observed metadata, never the .29 fixture.
    expect(manifest).toMatchObject({ name: "jorgex-pi", version: observedLocal.version });
    expect(contract.package).toEqual({ name: "jorgex-pi", version: observedLocal.version, source: expectedSource });
    // Stack compatibility policy: capabilities + writes must equal Stack's contract.
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(contract.pi?.testedVersions).toEqual(expect.arrayContaining([...PI_RUNTIME_CANDIDATE.pi.testedVersions]));
    expect(runner).toMatchObject({
      schemaVersion: PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion,
      bin: PI_RUNTIME_CANDIDATE.contract.runner.bin,
      commands: PI_RUNTIME_CANDIDATE.contract.runner.commands,
      stdout: { maxBytes: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes },
    });
    expect(assets.managedExternalWrites).toEqual(PI_RUNTIME_CANDIDATE.contract.managedExternalWrites);
    expect(parity.source?.commit).toBe(PI_RUNTIME_ARCHIVE.parity.source.commit);
    // Unbundled: six provider-managed runtime deps via npm, no nested bundle.
    expectUnbundledProducerInventory(tarball, manifest);
    // Engram bridge preserved, legacy retired.
    const capabilities = contract.capabilities as string[];
    expect(capabilities).toContain("engram-official-bridge-v1");
    expect(capabilities).toContain("engram-runtime-tools-v1");
    expect(capabilities).not.toContain("mcp-adapter-v1");
    // Permissions + experience policy preserved.
    expect(capabilities).toEqual(expect.arrayContaining(["permissions-policy-v1", "permissions-upgrade-v1", "experience-defaults-v1"]));
    expect(runner.experience?.diagnostic).toBe(
      "status reports pending, initialized, invalid, or unreadable from the receipt only; pending means the receipt is absent and requires a registered package; invalid preserves INVALID_PATH, INVALID_RECEIPT, or RECEIPT_TOO_LARGE and unreadable preserves READ_FAILED; status and doctor are read-only and never lock, write, or delete state",
    );
    expect(runner.permissions?.diagnostic).toBe(
      "permission state reports invalid or unreadable files without exposing their contents; a registered package also reports pending when the receipt is not initialized",
    );
    // Browser handoff capabilities preserved (non-execution; no tarball bootstrap here).
    expect(capabilities).toEqual(expect.arrayContaining(["playwright-handoff-v1", "chrome-devtools-handoff-v1", "context7-http-v1"]));
    const entries = new Set(listTarEntries(tarball));
    expect(entries.has("package/extensions/mcp-engram.ts")).toBe(true);
    expect(entries.has("package/extensions/playwright.ts")).toBe(true);
    expect(entries.has("package/assets/system-prompt/browser-playwright.md")).toBe(true);
    expect(entries.has("package/assets/permissions/defaults.json")).toBe(true);
  }, 60_000);

  // Unbundled .31 cannot run via direct extraction (runner needs
  // provider-managed strip-json-comments). When opt-in JORGEX_PI_BIN exists,
  // stage the observed tarball through isolated `pi` (no pnpm, no HOME);
  // otherwise this is an explicit skip. Non-execution contract checks above
  // and below stay always on.
  (piBinRaw === undefined ? it.skip : it)("stages the observed unbundled candidate through isolated pi when opt-in (otherwise explicit skip)", async () => {
    const observedLocal = readObservedCandidate();
    const tarball = path.resolve(registryTarball!);
    expectObservedArtifactIntegrity(tarball, observedLocal);
    const piBin = path.resolve(piBinRaw as string);
    expect(fs.statSync(piBin).isFile()).toBe(true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-observed-stage-"));
    temporaryPaths.push(root);
    const agentDir = path.join(root, "pi-agent");
    const settingsFile = path.join(agentDir, "settings.json");
    const modelsFile = path.join(agentDir, "models.json");
    const home = path.join(root, "home");
    const engramBin = path.join(root, process.platform === "win32" ? "engram.exe" : "engram");
    const officialGentle = "npm:gentle-engram@0.1.99";
    const officialAdapter = "npm:pi-mcp-adapter@0.2.5";
    const officialPackages = [officialGentle, officialAdapter];
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    fs.mkdirSync(path.join(root, "xdg-config"), { recursive: true });
    fs.mkdirSync(path.join(root, "xdg-cache"), { recursive: true });
    fs.mkdirSync(path.join(root, "npm-cache"), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: officialPackages, foreign: { keep: true }, defaultThinkingLevel: "high" }));
    fs.writeFileSync(modelsFile, JSON.stringify({ foreign: { keep: true } }));
    fs.writeFileSync(engramBin, process.platform === "win32" ? "placeholder" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(engramBin, 0o700);
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }));

    const fileAlias = `npm:jorgex-pi@file:${tarball}`;
    const installEnv: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CACHE_HOME: path.join(root, "xdg-cache"),
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TMPDIR: path.join(root, "tmp"),
      npm_config_cache: path.join(root, "npm-cache"),
      PI_CODING_AGENT_DIR: agentDir,
      ENGRAM_BIN: engramBin,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    };
    fs.mkdirSync(installEnv.APPDATA as string, { recursive: true });
    fs.mkdirSync(installEnv.LOCALAPPDATA as string, { recursive: true });
    fs.mkdirSync(installEnv.XDG_DATA_HOME as string, { recursive: true });

    const install = spawnSync(piBin, ["install", fileAlias, "--no-approve"], {
      cwd: root,
      encoding: "utf8",
      env: installEnv,
      shell: false,
      timeout: 120_000,
    });
    expect(install.status).toBe(0);
    const installedSettings = readJson(settingsFile) as { packages?: unknown };
    expect(installedSettings.packages).toEqual(expect.arrayContaining([fileAlias]));
    const packageRunner = path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
    expect(fs.statSync(packageRunner).isFile()).toBe(true);

    const sync = spawnSync(process.execPath, [packageRunner, "sync", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: { ...installEnv, PI_CODING_AGENT_DIR: agentDir },
      shell: false,
      timeout: 120_000,
    });
    expect(sync.status).toBe(0);
    expectObservedRunnerOutput(sync, "sync", packageRunner, observedLocal.version);
    expect(readJson(settingsFile)).toMatchObject({
      foreign: { keep: true },
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    });
    expect(fs.existsSync(path.join(agentDir, "jorgex-pi", "sol-lifecycle.v1.json"))).toBe(true);
  }, 120_000);

  it("preserves Stack Playwright handoff contract for the observed unbundled candidate without executing the tarball", () => {
    const tarball = path.resolve(registryTarball!);
    const observedLocal = readObservedCandidate();
    expectObservedArtifactIntegrity(tarball, observedLocal);
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as { capabilities?: unknown };
    // Browser handoff capabilities stay in the Stack-compatible contract.
    expect(contract.capabilities).toEqual(expect.arrayContaining(["playwright-handoff-v1"]));
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(contract.capabilities).toEqual(
      expect.arrayContaining(["chrome-devtools-handoff-v1", "context7-http-v1"]),
    );

    // Producer keeps the handoff assets; no tarball bootstrap execution here
    // (unbundled .31 needs provider-managed deps, so direct node import would
    // fail with missing strip-json-comments). Static inventory only, no pnpm.
    const entries = new Set(listTarEntries(tarball));
    expect(entries.has("package/extensions/playwright.ts")).toBe(true);
    expect(entries.has("package/assets/system-prompt/browser-playwright.md")).toBe(true);
    expect(entries.has("package/assets/system-prompt/browser-chrome-devtools.md")).toBe(true);
    expect(entries.has("package/assets/system-prompt/context7.md")).toBe(true);

    // Stack-side handoff lifecycle still works with the observed source and
    // stays isolated under the temp target (no HOME, no tarball execution).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-published-playwright-"));
    temporaryPaths.push(root);
    const targetDir = path.join(root, "stack-target");
    const agentDir = path.join(targetDir, "pi-agent");
    const playwrightCommand = writeFakePlaywright(root);
    const packageSource = canonicalObservedSource(observedLocal.version);

    expect(runPiProjectionLifecycleSystem({
      operation: "install",
      targetDir,
      packageSource,
      engramBin: path.join(root, "engram"),
      playwrightCliEnabled: true,
      playwrightHandoffEnabled: true,
      playwrightCliCommand: playwrightCommand,
    })).toMatchObject({ kind: "installed" });

    const handoff = path.join(agentDir, "jorgex-pi", "playwright.v1.json");
    expect(readJson(handoff)).toEqual({
      schemaVersion: 1,
      enabled: true,
      command: playwrightCommand,
      version: "0.1.18",
    });

    expect(runPiProjectionLifecycleSystem({
      operation: "sync",
      targetDir,
      packageSource,
      engramBin: path.join(root, "engram"),
      playwrightCliEnabled: false,
      playwrightHandoffEnabled: false,
      playwrightCliCommand: null,
    })).toMatchObject({ kind: "synced" });
    expect(fs.existsSync(handoff)).toBe(false);
  }, 60_000);
});

crossRepo("cross-repo contract for the pinned jorgex-pi candidate", () => {
  it("verifies the explicit JorgeX Pi checkout contract and bundled closure", () => {
    const root = path.resolve(piDirectory!);
    expect(fs.statSync(root).isDirectory()).toBe(true);

    const manifest = readJson(path.join(root, "package.json")) as { name?: string; version?: string };
    const contract = readJson(path.join(root, "contract", "jorgex-pi.v1.json")) as {
      package?: unknown;
      pi?: { testedVersions?: unknown };
      capabilities?: unknown;
    };
    const runner = readJson(path.join(root, "contract", "runner.v1.json")) as {
      schemaVersion?: unknown;
      bin?: unknown;
      commands?: unknown;
      stdout?: { maxBytes?: unknown };
    };
    const assets = readJson(path.join(root, "contract", "assets.v1.json")) as { managedExternalWrites?: unknown };

    expect(manifest).toMatchObject({
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
    });
    expect(contract.package).toEqual(PI_RUNTIME_CANDIDATE.package);
    expect(contract.pi?.testedVersions).toEqual(PI_RUNTIME_CANDIDATE.pi.testedVersions);
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(runner).toMatchObject({
      schemaVersion: PI_RUNTIME_CANDIDATE.contract.runner.schemaVersion,
      bin: PI_RUNTIME_CANDIDATE.contract.runner.bin,
      commands: PI_RUNTIME_CANDIDATE.contract.runner.commands,
      stdout: { maxBytes: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes },
    });
    expect(assets.managedExternalWrites).toEqual(PI_RUNTIME_CANDIDATE.contract.managedExternalWrites);

    const tarball = packTarball(root);
    expectArchiveInventory(tarball);
  }, 60_000);

  it("coordinates install through the managed operation with the checkout-local Pi: normalizes source, initializes via sync, and removes only the managed package", async () => {
    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js");
    const { runManagedPiOperation } = await import("../src/lib/pi-managed-runtime.js") as unknown as {
      runManagedPiOperation(operation: "install", deps: {
        runPackage(operation: string): Promise<{ kind: string; reason?: string; receipt?: unknown }>;
        runProjection(operation: string): Promise<unknown>;
        prepareProjectionUninstall(): Promise<never>;
        completeProjectionUninstall(): Promise<never>;
      }): Promise<unknown>;
    };
    const root = path.resolve(piDirectory!);
    const piManifest = readJson(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")) as {
      version?: unknown;
    };
    const piExecutable = path.join(root, "node_modules", ".bin", "pi");
    expect(piManifest.version).toBe("0.84.2");
    expect(fs.realpathSync(piExecutable)).toBe(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));

    const sourceTarball = packTarball(root);
    const checkoutLifecycleFixture = {
      source: PI_RUNTIME_CANDIDATE.package.source,
      bytes: fs.statSync(sourceTarball).size,
      sha256: digest("sha256", sourceTarball),
      sha512: digest("sha512", sourceTarball),
      package: PI_RUNTIME_CANDIDATE.package,
      provenance: { commit: "checkout-lifecycle-fixture" },
    };
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-cross-repo-install-"));
    temporaryPaths.push(target);
    const workspace = path.join(target, "workspace");
    const agentDir = path.join(target, "pi-agent");
    const settingsPath = path.join(agentDir, "settings.json");
    const downloadedTarball = path.join(target, "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
    const packageRunner = path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
    const packageRoot = path.dirname(path.dirname(packageRunner));
    const engramBin = path.join(target, "bin", process.platform === "win32" ? "engram.exe" : "engram");
    const foreignSource = "npm:foreign@1.0.0";
    const foreignState = { owner: "user", nested: { keep: true } };
    // T54-RED: this lower-level managed-operation test starts AFTER the
    // coordinator's external `engram setup pi` (it never pretends to run the
    // coordinator). Seed the singleton provider-managed packages + canonical
    // MCP with the executable sandbox binary before the managed install;
    // versions are provider-managed observations, only the singleton shape and
    // canonical MCP form are asserted. Order/package/projection assertions
    // below stay strict. Sandbox stays under the temp target, no real HOME.
    const officialGentle = "npm:gentle-engram@0.1.99";
    const officialAdapter = "npm:pi-mcp-adapter@0.2.5";

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, process.platform === "win32" ? "placeholder" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(engramBin, 0o700);
    fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [foreignSource, officialGentle, officialAdapter], foreignState, defaultThinkingLevel: "high" })}\n`);
    fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
      },
    }));
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages).toEqual([foreignSource, officialGentle, officialAdapter]);

    const invocations: Array<{ executable: string; args: string[]; environment: Record<string, string> }> = [];
    const runIsolated = (invocation: { executable: string; args: string[]; environment: Record<string, string> }) => {
      invocations.push(invocation);
      expect(invocation.environment).toMatchObject({
        HOME: path.join(target, "home"),
        USERPROFILE: path.join(target, "home"),
        APPDATA: path.join(target, "appdata"),
        LOCALAPPDATA: path.join(target, "localappdata"),
        XDG_CONFIG_HOME: path.join(target, "xdg-config"),
        XDG_DATA_HOME: path.join(target, "xdg-data"),
        XDG_CACHE_HOME: path.join(target, "xdg-cache"),
        TEMP: path.join(target, "tmp"),
        TMP: path.join(target, "tmp"),
        TMPDIR: path.join(target, "tmp"),
        npm_config_cache: path.join(target, "npm-cache"),
        PI_CODING_AGENT_DIR: agentDir,
        ENGRAM_BIN: engramBin,
      });
      expect(invocation.environment).not.toHaveProperty("PI_PACKAGE_DIR");
      expect(invocation.environment).not.toHaveProperty("NPM_TOKEN");
      const result = spawnSync(invocation.executable, invocation.args, {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...invocation.environment,
          NPM_CONFIG_AUDIT: "false",
          NPM_CONFIG_FUND: "false",
          NPM_CONFIG_OFFLINE: "true",
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
        shell: false,
        timeout: 120_000,
        maxBuffer: PI_RUNTIME_CANDIDATE.contract.runner.maxStdoutBytes + 1,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? (result.error?.message ?? ""),
      };
    };

    const trace: string[] = [];
    const result = await runManagedPiOperation("install", {
      async runPackage(next) {
        trace.push(`package:${next}`);
        if (next === "install") {
          return installPiFromVerifiedTarball({
            targetDir: target,
            piExecutable,
            engramBin,
            candidate: {
              ...checkoutLifecycleFixture,
            },
          }, {
            download(destination) {
              expect(destination).toBe(downloadedTarball);
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.copyFileSync(sourceTarball, destination);
              return {
                path: destination,
                bytes: fs.statSync(destination).size,
                sha256: digest("sha256", destination),
                sha512: digest("sha512", destination),
              };
            },
            backupSettings() {
              const backup = path.join(target, "backups", "settings.json");
              fs.mkdirSync(path.dirname(backup), { recursive: true });
              fs.copyFileSync(settingsPath, backup);
            },
            run: runIsolated,
            readSettings: () => fs.readFileSync(settingsPath, "utf8"),
            rewriteSettings: (content) => fs.writeFileSync(settingsPath, `${content}\n`),
            writeReceiptAtomic: (content) => {
              const receiptPath = path.join(target, "state", "pi-receipt.json");
              fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
              fs.writeFileSync(receiptPath, content);
            },
          }) as unknown as { kind: string; reason?: string; receipt?: unknown };
        }
        if (next !== "sync") throw new Error(`unexpected package operation: ${next}`);
        const sync = runIsolated({
          executable: process.execPath,
          args: [packageRunner, "sync", "--json"],
          environment: invocations[0]!.environment,
        });
        expect(sync.exitCode).toBe(0);
        expectRunnerOutput(sync, "sync", packageRunner);
        return { kind: "synced" };
      },
      async runProjection(next) {
        trace.push(`projection:${next}`);
        return runPiProjectionLifecycleSystem({
          operation: next as "install",
          targetDir: target,
          packageSource: PI_RUNTIME_CANDIDATE.package.source,
          engramBin,
          playwrightCliEnabled: false,
        }) as unknown;
      },
      async prepareProjectionUninstall(): Promise<never> {
        throw new Error("install must not prepare uninstall");
      },
      async completeProjectionUninstall(): Promise<never> {
        throw new Error("install must not complete uninstall");
      },
    });

    expect(trace).toEqual(["package:install", "projection:install", "package:sync"]);
    expect(result).toEqual(expect.objectContaining({ kind: "installed" }));
    expect(invocations).toEqual([
      expect.objectContaining({
        executable: piExecutable,
        args: ["install", `npm:jorgex-pi@file:${downloadedTarball}`, "--no-approve"],
      }),
      expect.objectContaining({
        executable: process.execPath,
        args: [packageRunner, "doctor", "--json"],
      }),
      expect.objectContaining({
        executable: process.execPath,
        args: [packageRunner, "sync", "--json"],
      }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      packages: [foreignSource, officialGentle, officialAdapter, { source: PI_RUNTIME_CANDIDATE.package.source, skills: [], prompts: [] }],
      foreignState,
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "high",
    });
    expect(JSON.parse(fs.readFileSync(path.join(target, "backups", "settings.json"), "utf8"))).toEqual({
      packages: [foreignSource, officialGentle, officialAdapter],
      foreignState,
      defaultThinkingLevel: "high",
    });
    expect(fs.existsSync(packageRunner)).toBe(true);
    expect(fs.existsSync(path.join(target, "state", "pi-receipt.json"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "jorgex-pi", "sol-lifecycle.v1.json"))).toBe(true);

    const remove = runIsolated({
      executable: piExecutable,
      args: ["remove", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
      environment: invocations[0]!.environment,
    });
    expect(remove).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
      packages: [foreignSource, officialGentle, officialAdapter],
      foreignState,
      defaultThinkingLevel: "high",
    });
    expect(fs.existsSync(packageRoot)).toBe(false);
  }, 60_000);

  it("exposes the exact Pi 0.8.29 initialization-diagnostics-v1 contract and provisional pending doctor", async () => {
    const root = path.resolve(piDirectory!);
    const manifest = readJson(path.join(root, "package.json")) as { name?: string; version?: string };
    expect(manifest).toMatchObject({ name: "jorgex-pi", version: "0.8.29" });

    const contract = readJson(path.join(root, "contract", "jorgex-pi.v1.json")) as { capabilities?: string[]; package?: { version?: string; source?: string } };
    expect(contract.package).toEqual({ name: "jorgex-pi", version: "0.8.29", source: "npm:jorgex-pi@0.8.29" });
    expect(contract.capabilities).toContain("initialization-diagnostics-v1");
    expect(contract.capabilities?.at(-1)).toBe("initialization-diagnostics-v1");

    const runner = readJson(path.join(root, "contract", "runner.v1.json")) as {
      experience?: { diagnostic?: string };
      permissions?: { diagnostic?: string };
    };
    expect(runner.experience?.diagnostic).toBe(
      "status reports pending, initialized, invalid, or unreadable from the receipt only; pending means the receipt is absent and requires a registered package; invalid preserves INVALID_PATH, INVALID_RECEIPT, or RECEIPT_TOO_LARGE and unreadable preserves READ_FAILED; status and doctor are read-only and never lock, write, or delete state",
    );
    expect(runner.permissions?.diagnostic).toBe(
      "permission state reports invalid or unreadable files without exposing their contents; a registered package also reports pending when the receipt is not initialized",
    );

    const schema = readJson(path.join(root, "contract", "schemas", "runner-response.v1.schema.json")) as {
      $defs: {
        statusResult: { required: string[]; properties: Record<string, unknown> };
        doctorResult: { properties: { checks: { minItems: number; maxItems: number; prefixItems: Array<{ properties: { id: { const: string } } }>; items: unknown } } };
        experience: unknown;
      };
    };
    expect(schema.$defs.statusResult.required).toEqual(["installation", "engram", "context7", "permissions", "experience"]);
    expect(schema.$defs.statusResult.properties.experience).toEqual({ $ref: "#/$defs/experience" });
    expect(schema.$defs.doctorResult.properties.checks.minItems).toBe(5);
    expect(schema.$defs.doctorResult.properties.checks.maxItems).toBe(5);
    expect(schema.$defs.doctorResult.properties.checks.items).toBe(false);
    expect(schema.$defs.doctorResult.properties.checks.prefixItems.map((item) => item.properties.id.const)).toEqual([
      "package",
      "engram",
      "context7",
      "permissions",
      "experience",
    ]);

    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-pending-cross-repo-"));
    temporaryPaths.push(target);
    const agentDir = path.join(target, "pi-agent");
    const packageRunner = path.join(agentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
    const packageRoot = path.dirname(path.dirname(packageRunner));
    const pendingDoctor = `${JSON.stringify({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
      package: { name: "jorgex-pi", version: "0.8.29", root: packageRoot },
      result: {
        healthy: false,
        checks: [
          { id: "package", status: "ok" },
          { id: "engram", status: "ok" },
          { id: "context7", status: "ok" },
          { id: "permissions", status: "error" },
          { id: "experience", status: "error" },
        ],
      },
      error: {
        phase: "initialization",
        code: "INITIALIZATION_REQUIRED",
        message: "Pi initialization is pending: run sync to complete first initialization.",
        remedy: "Run jorgex-pi sync --json and retry.",
      },
    })}\n`;
    const candidate = {
      source: "npm:jorgex-pi@0.8.29",
      bytes: 1,
      sha256: "a".repeat(64),
      sha512: "b".repeat(128),
      package: { name: "jorgex-pi", version: "0.8.29", source: "npm:jorgex-pi@0.8.29" },
    } as const;

    let downloadDestination: string | null = null;
    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: path.join(target, "bin", "engram"),
      candidate,
    }, {
      download(destination: string) {
        downloadDestination = destination;
        return { path: destination, bytes: 1, sha256: "a".repeat(64), sha512: "b".repeat(128) };
      },
      backupSettings() {},
      run(invocation: { executable: string; args: string[]; environment: Record<string, string> }) {
        if (invocation.args[0] === "install") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: pendingDoctor, stderr: "" };
      },
      readSettings() {
        expect(downloadDestination).not.toBeNull();
        return JSON.stringify({ packages: [`npm:jorgex-pi@file:${downloadDestination}`] });
      },
      rewriteSettings() {},
      writeReceiptAtomic() {},
    });

    expect(result).toEqual(expect.objectContaining({ kind: "installed" }));
  }, 60_000);

});

describe("T43 provider-only parity: Stack sin protocolo Engram", () => {
  it("no distribuye fuente/sección/placeholder/interfaz Stack en ningún runtime", () => {
    const root = stackRoot();
    expect(fs.existsSync(path.join(root, STACK_ENGRAM_PROVIDER_ONLY.forbiddenSource.replace(/^stack\//, "")))).toBe(false);
    const sections = fs.readFileSync(path.join(root, "..", "src", "lib", "system-prompt-sections.ts"), "utf8");
    expect(sections).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenSection);
    const plugins = fs.readFileSync(path.join(root, "..", "src", "components", "plugins.ts"), "utf8");
    expect(plugins).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenPlaceholder);
    const types = fs.readFileSync(path.join(root, "..", "src", "adapters", "types.ts"), "utf8");
    expect(types).not.toContain(STACK_ENGRAM_PROVIDER_ONLY.forbiddenInterface);
    // Context7/browser/writing-style no se tocan en T43.
    expect(sections).toContain("context7");
    expect(sections).toContain("writing-style");
  });
});

// ---------------------------------------------------------------------------
// T52-RED: seam cross-repo compara el contrato productor 0.8.29 completo.
// Cuando JORGEX_PI_DIR se provee, lee el tag exacto
// bbaf80f09bd1512e21fe80f22b4aad61420a8800 read-only (git show, sin mutar el
// checkout) o el checkout si ya es 0.8.29, y compara capabilities completas.
// Cuando JORGEX_PI_TARBALL se provee, lee el tarball exacto read-only y
// compara el mismo contrato. Fuente independiente: contract/jorgex-pi.v1.json
// del tag Pi v0.8.29. Ambos exigen bridge y resto intacto en productor y en
// Stack (fixture + producción). No edita pin generado.
// ---------------------------------------------------------------------------

const T52_EXPECTED_PI_0_8_29_COMMIT = "bbaf80f09bd1512e21fe80f22b4aad61420a8800";
const T52_EXPECTED_PI_0_8_29_CAPABILITIES = [
  "foundation-contract-v1",
  "stack-snapshot-v2",
  "modular-system-prompts-v1",
  "runtime-agents-v1",
  "permission-gated-tools-v1",
  "structured-questions-v1",
  "web-access-v1",
  "goal-continuation-v1",
  "engram-official-bridge-v1",
  "engram-runtime-tools-v1",
  "context7-http-v1",
  "permissions-policy-v1",
  "permissions-upgrade-v1",
  "experience-defaults-v1",
  "chrome-devtools-handoff-v1",
  "playwright-handoff-v1",
  "runner-json-v1",
  "tui-branding-v1",
  "managed-primary-model-v1",
  "quality-receipt-contract-v1",
  "quality-capabilities-contract-v1",
  "initialization-diagnostics-v1",
] as const;

function t52ReadProducerContract(piDir: string): { version: string; capabilities: string[] } {
  const root = path.resolve(piDir);
  const checkoutFile = path.join(root, "contract", "jorgex-pi.v1.json");
  try {
    const checkout = readJson(checkoutFile) as { package?: { version?: unknown }; capabilities?: unknown };
    if (checkout.package?.version === "0.8.29" && Array.isArray(checkout.capabilities)) {
      return { version: "0.8.29", capabilities: checkout.capabilities as string[] };
    }
  } catch {
    // El checkout puede estar en otra versión; se intenta el tag exacto.
  }
  const tagOut = execFileSync("git", ["show", `${T52_EXPECTED_PI_0_8_29_COMMIT}:contract/jorgex-pi.v1.json`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tagContract = JSON.parse(tagOut) as { package?: { version?: unknown }; capabilities?: unknown };
  expect(tagContract.package?.version).toBe("0.8.29");
  expect(Array.isArray(tagContract.capabilities)).toBe(true);
  return { version: "0.8.29", capabilities: tagContract.capabilities as string[] };
}

const t52CrossRepo = piDirectory === undefined ? describe.skip : describe;
const t52Registry = hasObservedRegistryInputs ? describe : describe.skip;

t52CrossRepo("[T52-RED] productor Pi 0.8.29 leído del tag exacto", () => {
  it("el checkout/tag productor contiene bridge y no legacy, resto intacto, y Stack lo iguala", async () => {
    const producer = t52ReadProducerContract(piDirectory!);
    expect(producer.capabilities).toContain("engram-official-bridge-v1");
    expect(producer.capabilities).not.toContain("mcp-adapter-v1");
    expect(producer.capabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);

    const fixtureCapabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
    expect(fixtureCapabilities).toContain("engram-official-bridge-v1");
    expect(fixtureCapabilities).not.toContain("mcp-adapter-v1");
    expect(fixtureCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(fixtureCapabilities).toEqual(producer.capabilities);

    const { PI_RUNTIME_REGISTRY } = await import("../src/lib/pi-runtime.js");
    const productionCapabilities = [...PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities];
    expect(productionCapabilities).toContain("engram-official-bridge-v1");
    expect(productionCapabilities).not.toContain("mcp-adapter-v1");
    expect(productionCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(productionCapabilities).toEqual(producer.capabilities);
  }, 60_000);
});

t52Registry("[T52-RED] tarball observado Pi con contrato productor completo (unbundled, sin fixture .31)", () => {
  it("el tarball observado contiene bridge y no legacy, resto intacto, y Stack lo iguala", async () => {
    const observedLocal = readObservedCandidate();
    const tarball = path.resolve(registryTarball!);
    expectObservedArtifactIntegrity(tarball, observedLocal);
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as {
      package?: { name?: unknown; version?: unknown; source?: unknown };
      capabilities?: unknown;
    };
    // Versión real desde metadata observada, nunca fixture .29 ni .31 hardcodeado.
    expect(contract.package).toEqual({
      name: "jorgex-pi",
      version: observedLocal.version,
      source: canonicalObservedSource(observedLocal.version),
    });
    const tarballCapabilities = contract.capabilities as string[];
    expect(tarballCapabilities).toContain("engram-official-bridge-v1");
    expect(tarballCapabilities).not.toContain("mcp-adapter-v1");
    // .31 mantiene el mismo contrato de compatibilidad Stack que .29.
    expect(tarballCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);

    // Fixture histórico .29 intacto; no se finge .31/hashes en fixtures.
    const fixtureCapabilities = [...PI_RUNTIME_CANDIDATE.contract.capabilities];
    expect(fixtureCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(fixtureCapabilities).toEqual(tarballCapabilities);

    const { PI_RUNTIME_REGISTRY } = await import("../src/lib/pi-runtime.js");
    const productionCapabilities = [...PI_RUNTIME_REGISTRY.pi.candidate.contract.capabilities];
    expect(productionCapabilities).toEqual([...T52_EXPECTED_PI_0_8_29_CAPABILITIES]);
    expect(productionCapabilities).toEqual(tarballCapabilities);
  }, 60_000);
});
