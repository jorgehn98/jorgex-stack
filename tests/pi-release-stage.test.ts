import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as _PiReleaseStageExists from "../src/lib/pi-release-stage.js";

/**
 * T05 next RED for T06 Pi-native stage orchestration.
 *
 * Intended code-facing contract (no production change here):
 * - `stageVerifiedPiTarball({ homeDir, agentDir, piExecutable,
 *   artifact: { path, bytes, sha256, sha512 },
 *   release: { version, tarballUrl, integrity } }, run)` exported from
 *   `src/lib/pi-release-stage.ts`.
 * - `run` injected as
 *   `(executable, args, options: { env, cwd }) =>
 *   { exitCode, stdout, stderr }`, so the test simulates the Pi CLI without
 *   real external network.
 * - Function creates a random private stageRoot as a child of agentDir
 *   (mode 0700), Pi stageDir = stageRoot/pi-agent, isolated child HOME/XDG/
 *   npm cache/temp/cwd under stageRoot; invokes Pi
 *   `install npm:jorgex-pi@file:<verified artifact path> --no-approve` ONLY
 *   with the stage env, never the active PI_CODING_AGENT_DIR, never npm
 *   from Stack; on success inspects the stage via existing
 *   `inspectStagedPiNpm(stageDir, artifact.path, release)` and returns
 *   `{ stageDir, evidence, sourceAlias }`; on failure it must not mutate
 *   active npm/settings/receipt/foreign and must preserve the stage for
 *   visible diagnosis (or safe cleanup only after confirming no backup).
 *
 * Fixture notes:
 * - All paths live in an `os.tmpdir()` sandbox acting as fake home/agent
 *   (never real HOME). Synthetic `9.9.9` version/bytes only; they prove the
 *   stage wiring observes the verified artifact instead of hardcoding
 *   literals. No real Pi CLI, no npm execution, no network.
 * - The control exit0 case deliberately builds only a sentinel file via the
 *   fake run (no full lock/tree) to avoid duplicating the 371-line
 *   staged-lock fixture. It proves install→inspect wiring: with a minimal
 *   tree the inspector must still gate (`pi-staged-lock:`) instead of
 *   returning fabricated evidence. Real success stays for manual probing.
 * - TOCTOU preflight: the verified `artifact` identity is bound at call
 *   time, but the tarball lives on disk until native Pi executes it. A
 *   swap after verification must reject (`pi-release-stage:`) BEFORE the
 *   injected Pi run ever executes; the post-install inspector alone is too
 *   late because it would run after untrusted bytes went through Pi.
 */

type StageArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  sha512: string;
};

type StageRelease = {
  version: string;
  tarballUrl: string;
  integrity: string;
};

type StageInput = {
  homeDir: string;
  agentDir: string;
  piExecutable: string;
  artifact: StageArtifact;
  release: StageRelease;
};

type StageRunOptions = {
  env: Record<string, string>;
  cwd: string;
};

type StageRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type StageRun = (
  executable: string,
  args: string[],
  options: StageRunOptions,
) => StageRunResult | Promise<StageRunResult>;

type StageEvidence = {
  lockSha256: string;
  treeSha256: string;
  dependencies: Array<{ name: string; version: string; integrity: string }>;
};

type StageResult = {
  stageDir: string;
  evidence: StageEvidence;
  sourceAlias: string;
};

type PiReleaseStageModule = {
  stageVerifiedPiTarball(input: StageInput, run: StageRun): Promise<StageResult>;
};

const stageSpecifier = new URL("../src/lib/pi-release-stage.js", import.meta.url).href;

async function loadStage(): Promise<PiReleaseStageModule> {
  const mod = (await import(/* @vite-ignore */ stageSpecifier)) as Partial<PiReleaseStageModule>;
  expect(
    mod.stageVerifiedPiTarball,
    "stageVerifiedPiTarball must be exported from src/lib/pi-release-stage.ts",
  ).toBeTypeOf("function");
  return mod as PiReleaseStageModule;
}

const STAGE_VERSION = "9.9.9";

const OLD_SETTINGS = `${JSON.stringify({ packages: ["npm:foreign@1.0.0", "npm:jorgex-pi@0.8.24-owned"] }, null, 2)}\n`;
const OLD_RECEIPT = `${JSON.stringify({ schemaVersion: 2, release: "owned-previous" }, null, 2)}\n`;
const FOREIGN_INDEX = "// foreign package - must survive byte-identically\nmodule.exports = 'foreign';\n";
const PI_EXECUTABLE = "/opt/pi/bin/pi";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ActiveSandbox = {
  homeDir: string;
  agentDir: string;
  settingsPath: string;
  receiptPath: string;
  foreignIndex: string;
  foreignManifest: string;
  artifact: StageArtifact;
  release: StageRelease;
};

function buildActiveSandbox(): ActiveSandbox {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-release-stage-"));
  sandboxes.push(sandbox);

  const homeDir = sandbox;
  const agentDir = path.join(homeDir, "agent");
  const settingsPath = path.join(agentDir, "settings.json");
  const receiptPath = path.join(homeDir, "state", "pi-receipt.json");
  const foreignDir = path.join(agentDir, "npm", "node_modules", "foreign-pkg");
  const foreignIndex = path.join(foreignDir, "index.js");
  const foreignManifest = path.join(foreignDir, "package.json");

  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "package.json"), '{"name":"foreign-pkg","version":"1.0.0"}\n');
  fs.writeFileSync(foreignIndex, FOREIGN_INDEX);
  fs.writeFileSync(settingsPath, OLD_SETTINGS);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, OLD_RECEIPT);

  const tarballBytes = Buffer.from("synthetic-verified-jorgex-pi-tarball-9.9.9\n");
  const downloadsDir = path.join(sandbox, "downloads");
  fs.mkdirSync(downloadsDir, { recursive: true });
  const artifactPath = path.join(downloadsDir, `jorgex-pi-${STAGE_VERSION}.tgz`);
  fs.writeFileSync(artifactPath, tarballBytes);

  const artifact: StageArtifact = {
    path: artifactPath,
    bytes: tarballBytes.byteLength,
    sha256: createHash("sha256").update(tarballBytes).digest("hex"),
    sha512: createHash("sha512").update(tarballBytes).digest("hex"),
  };
  const release: StageRelease = {
    version: STAGE_VERSION,
    tarballUrl: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${STAGE_VERSION}.tgz`,
    integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
  };
  return { homeDir, agentDir, settingsPath, receiptPath, foreignIndex, foreignManifest, artifact, release };
}

type CapturedCall = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

function isStrictChild(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function expectStageIsolation(calls: CapturedCall[], agentDir: string, artifactPath: string): string {
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.executable).toBe(PI_EXECUTABLE);
  expect(call.executable).not.toBe("npm");
  expect(call.args).toEqual(["install", `npm:jorgex-pi@file:${artifactPath}`, "--no-approve"]);
  expect(call.args.join(" ")).not.toContain("latest");
  expect(call.args.join(" ")).not.toContain(agentDir);

  const stageAgentDir = call.env["PI_CODING_AGENT_DIR"];
  expect(stageAgentDir).toBeDefined();
  expect(stageAgentDir).not.toBe(agentDir);
  expect(isStrictChild(agentDir, stageAgentDir!)).toBe(true);
  expect(path.basename(stageAgentDir!)).toBe("pi-agent");
  const stageRoot = path.dirname(stageAgentDir!);
  expect(path.dirname(stageRoot)).toBe(agentDir);

  expect(isStrictChild(agentDir, call.cwd)).toBe(true);
  expect(isStrictChild(stageRoot, call.cwd)).toBe(true);
  expect(call.cwd).not.toBe(agentDir);

  for (const key of ["HOME", "npm_config_cache"] as const) {
    expect(call.env[key], `${key} must be stage-isolated`).toBeDefined();
    expect(isStrictChild(stageRoot, call.env[key]!), `${key} must live under the stage root`).toBe(true);
  }
  expect(call.env["HOME"]).not.toBe(process.env["HOME"] ?? "__no_home__");
  for (const key of Object.keys(call.env)) {
    if (/^(TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME)$/.test(key)) {
      expect(isStrictChild(stageRoot, call.env[key]!), `${key} must live under the stage root`).toBe(true);
    }
  }

  const stat = fs.statSync(stageRoot);
  expect(stat.isDirectory()).toBe(true);
  expect(stat.mode & 0o777).toBe(0o700);
  return stageAgentDir!;
}

describe("[T06-RED] Pi-native verified stage orchestration before activation", () => {
  it("fails closed on Pi install exit1 without mutating active foreign/settings/receipt and never targets the active agent", async () => {
    const { stageVerifiedPiTarball } = await loadStage();
    const { homeDir, agentDir, settingsPath, receiptPath, foreignIndex, foreignManifest, artifact, release } =
      buildActiveSandbox();

    const beforeSettings = fs.readFileSync(settingsPath, "utf8");
    const beforeReceipt = fs.readFileSync(receiptPath, "utf8");
    const beforeForeign = fs.readFileSync(foreignIndex, "utf8");
    const beforeForeignManifest = fs.readFileSync(foreignManifest, "utf8");

    const calls: CapturedCall[] = [];
    const run: StageRun = (executable, args, options) => {
      calls.push({ executable, args: [...args], env: { ...options.env }, cwd: options.cwd });
      return { exitCode: 1, stdout: "", stderr: "pi install boom" };
    };

    const failure = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: PI_EXECUTABLE, artifact, release },
      run,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-release-stage:/);

    const stageAgentDir = expectStageIsolation(calls, agentDir, artifact.path);

    // Active tree byte-stable: foreign + settings + receipt untouched, no
    // install ever ran against the active agent dir.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(beforeSettings);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(beforeForeign);
    expect(fs.readFileSync(foreignManifest, "utf8")).toBe(beforeForeignManifest);
    expect(fs.lstatSync(path.dirname(foreignIndex)).isDirectory()).toBe(true);

    // Stage preserved for visible diagnosis: the isolated agent dir reported
    // via the stage env still exists; when the error exposes stageDir it must
    // agree with the isolated env instead of pointing at the active agent.
    expect(fs.existsSync(stageAgentDir)).toBe(true);
    const exposed = (failure as Error & { stageDir?: unknown }).stageDir;
    if (exposed !== undefined) {
      expect(exposed).toBe(stageAgentDir);
    }
  });

  it("CONTROL: exit0 with a minimal synthetic tree still reaches the staged inspector instead of returning fabricated evidence", async () => {
    const { stageVerifiedPiTarball } = await loadStage();
    const { homeDir, agentDir, settingsPath, receiptPath, foreignIndex, artifact, release } = buildActiveSandbox();

    const calls: CapturedCall[] = [];
    const run: StageRun = (_executable, _args, options) => {
      calls.push({
        executable: _executable,
        args: [..._args],
        env: { ...options.env },
        cwd: options.cwd,
      });
      // Minimal synthetic marker only: proves the fake Pi ran inside the
      // isolated cwd without duplicating the full staged-lock lock/tree.
      fs.mkdirSync(options.cwd, { recursive: true });
      fs.writeFileSync(path.join(options.cwd, "sentinel.txt"), "synthetic-stage-marker\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const failure = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: PI_EXECUTABLE, artifact, release },
      run,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // Install succeeded, so the failure must come from the real stage
    // inspector gating the minimal tree before activation.
    expect(String((failure as Error).message)).toMatch(/pi-staged-lock:/);

    const stageAgentDir = expectStageIsolation(calls, agentDir, artifact.path);
    expect(fs.readFileSync(path.join(calls[0]!.cwd, "sentinel.txt"), "utf8")).toBe(
      "synthetic-stage-marker\n",
    );
    expect(fs.existsSync(stageAgentDir)).toBe(true);

    // Control also leaves the active tree untouched.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(OLD_SETTINGS);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(OLD_RECEIPT);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(FOREIGN_INDEX);
  });

  it("fails closed before Pi when the verified artifact bytes were swapped on disk (TOCTOU), without invoking Pi", async () => {
    const { stageVerifiedPiTarball } = await loadStage();
    const { homeDir, agentDir, settingsPath, receiptPath, foreignIndex, foreignManifest, artifact, release } =
      buildActiveSandbox();

    const beforeSettings = fs.readFileSync(settingsPath, "utf8");
    const beforeReceipt = fs.readFileSync(receiptPath, "utf8");
    const beforeForeign = fs.readFileSync(foreignIndex, "utf8");
    const beforeForeignManifest = fs.readFileSync(foreignManifest, "utf8");

    // Swap the tarball AFTER the verified artifact/release identities were
    // constructed: the stage must re-hash the bytes before Pi ever runs.
    fs.writeFileSync(artifact.path, "tampered-after-verification\n");

    const calls: CapturedCall[] = [];
    const run: StageRun = (executable, args, options) => {
      calls.push({ executable, args: [...args], env: { ...options.env }, cwd: options.cwd });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const failure = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: PI_EXECUTABLE, artifact, release },
      run,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/pi-release-stage:/);

    // Preflight gate: native Pi must never execute the swapped bytes.
    expect(calls).toHaveLength(0);

    // Active tree byte-identical: foreign + settings + receipt untouched.
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(beforeSettings);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
    expect(fs.readFileSync(foreignIndex, "utf8")).toBe(beforeForeign);
    expect(fs.readFileSync(foreignManifest, "utf8")).toBe(beforeForeignManifest);
    expect(fs.lstatSync(path.dirname(foreignIndex)).isDirectory()).toBe(true);

    // No productive package mutation: the shared npm root still holds only
    // the foreign entry and no managed release was published.
    expect(fs.existsSync(path.join(agentDir, "npm", "jorgex-pi-managed"))).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "npm", "node_modules", "jorgex-pi"))).toBe(false);
  });
});
