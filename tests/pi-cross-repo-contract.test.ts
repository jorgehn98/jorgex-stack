import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_RUNTIME_ARCHIVE, PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

const piDirectory = process.env.JORGEX_PI_DIR;
const crossRepo = piDirectory === undefined ? describe.skip : describe;
const registryTarball = process.env.JORGEX_PI_TARBALL;
const registryArtifact = registryTarball === undefined ? describe.skip : describe;
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
  for (const asset of PI_RUNTIME_ARCHIVE.brandingAssets) {
    expect(entries.has(`package/${asset}`), asset).toBe(true);
  }
  const packedManifest = readTarJson(tarball, "package/package.json") as { bundledDependencies?: unknown };
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

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

registryArtifact("exact npm artifact for the pinned jorgex-pi candidate", () => {
  it("matches the frozen bytes, digests, package contract, and archive inventory", () => {
    const tarball = path.resolve(registryTarball!);
    expect(fs.statSync(tarball).isFile()).toBe(true);
    expect(fs.statSync(tarball).size).toBe(PI_RUNTIME_CANDIDATE.tarball.bytes);
    expect(digest("sha256", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha256);
    expect(digest("sha512", tarball)).toBe(PI_RUNTIME_CANDIDATE.tarball.sha512);

    const manifest = readTarJson(tarball, "package/package.json") as { name?: unknown; version?: unknown };
    const contract = readTarJson(tarball, "package/contract/jorgex-pi.v1.json") as {
      package?: unknown;
      pi?: { testedVersions?: unknown };
      capabilities?: unknown;
    };
    const assets = readTarJson(tarball, "package/contract/assets.v1.json") as { managedExternalWrites?: unknown };
    expect(manifest).toMatchObject({
      name: PI_RUNTIME_CANDIDATE.package.name,
      version: PI_RUNTIME_CANDIDATE.package.version,
    });
    expect(contract.package).toEqual(PI_RUNTIME_CANDIDATE.package);
    expect(contract.pi?.testedVersions).toEqual(PI_RUNTIME_CANDIDATE.pi.testedVersions);
    expect(contract.capabilities).toEqual(PI_RUNTIME_CANDIDATE.contract.capabilities);
    expect(assets.managedExternalWrites).toEqual(PI_RUNTIME_CANDIDATE.contract.managedExternalWrites);
    expectArchiveInventory(tarball);
  }, 60_000);

  it("executes Sol sync and ownership-safe cleanup from the exact published tarball", () => {
    const tarball = path.resolve(registryTarball!);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-registry-lifecycle-"));
    temporaryPaths.push(root);
    execFileSync("tar", ["-xzf", tarball, "-C", root], { stdio: ["ignore", "ignore", "pipe"] });

    const agentDir = path.join(root, "agent");
    const settingsFile = path.join(agentDir, "settings.json");
    const modelsFile = path.join(agentDir, "models.json");
    const engramBin = path.join(root, process.platform === "win32" ? "engram.exe" : "engram");
    const runner = path.join(root, "package", "bin", "jorgex-pi.mjs");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ foreign: { keep: true } }));
    fs.writeFileSync(modelsFile, JSON.stringify({ foreign: { keep: true } }));
    fs.writeFileSync(engramBin, "placeholder");

    const environment = {
      PI_CODING_AGENT_DIR: agentDir,
      ENGRAM_BIN: engramBin,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    };
    fs.mkdirSync(environment.TEMP, { recursive: true });
    const run = (command: "sync" | "cleanup") => spawnSync(process.execPath, [runner, command, "--json"], {
      encoding: "utf8",
      env: environment,
    });

    const sync = run("sync");
    expect(sync).toMatchObject({ status: 0, stderr: "" });
    expect(readJson(settingsFile)).toMatchObject({
      foreign: { keep: true },
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
    });
    expect(readJson(modelsFile)).toMatchObject({
      foreign: { keep: true },
      providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { contextWindow: 872000 } } } },
    });

    const settings = readJson(settingsFile) as Record<string, unknown>;
    settings.defaultModel = "user-model";
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const models = readJson(modelsFile) as Record<string, any>;
    models.providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow = 900000;
    fs.writeFileSync(modelsFile, JSON.stringify(models));

    const cleanup = run("cleanup");
    expect(cleanup).toMatchObject({ status: 0, stderr: "" });
    expect(readJson(settingsFile)).toEqual({ foreign: { keep: true }, defaultModel: "user-model" });
    expect(readJson(modelsFile)).toEqual({
      foreign: { keep: true },
      providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { contextWindow: 900000 } } } },
    });
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

  it("installs the packed checkout artifact with the checkout-local Pi, normalizes its source, validates doctor, and removes only the managed package", async () => {
    const { installPiFromVerifiedTarball } = await import("../src/lib/pi-runtime.js");
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

    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, process.platform === "win32" ? "placeholder" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") fs.chmodSync(engramBin, 0o700);
    fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [foreignSource], foreignState })}\n`);

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

    const result = installPiFromVerifiedTarball({
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
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "installed",
      receipt: expect.objectContaining({
        schemaVersion: 1,
        state: "installed",
        scope: { kind: "target-dir", codingAgentDir: agentDir },
        engram: { binary: engramBin },
      }),
    }));
    expect(invocations).toEqual([
      expect.objectContaining({
        executable: piExecutable,
        args: ["install", `npm:jorgex-pi@file:${downloadedTarball}`, "--no-approve"],
      }),
      expect.objectContaining({
        executable: process.execPath,
        args: [packageRunner, "doctor", "--json"],
      }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
      packages: [foreignSource, { source: PI_RUNTIME_CANDIDATE.package.source, skills: [] }],
      foreignState,
    });
    expect(JSON.parse(fs.readFileSync(path.join(target, "backups", "settings.json"), "utf8"))).toEqual({
      packages: [foreignSource],
      foreignState,
    });
    expect(fs.existsSync(packageRunner)).toBe(true);

    const remove = runIsolated({
      executable: piExecutable,
      args: ["remove", PI_RUNTIME_CANDIDATE.package.source, "--no-approve"],
      environment: invocations[0]!.environment,
    });
    expect(remove).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({ packages: [foreignSource], foreignState });
    expect(fs.existsSync(packageRoot)).toBe(false);
  }, 60_000);
});
