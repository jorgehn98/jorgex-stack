import path from "node:path";
import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

const candidate = {
  source: PI_RUNTIME_CANDIDATE.package.source,
  ...PI_RUNTIME_CANDIDATE.tarball,
} as const;

type Environment = Record<string, string>;
type Invocation = { executable: string; args: string[]; environment: Environment };
type InstallResult = {
  kind: "installed";
  receipt: {
    schemaVersion: 1;
    scope: { kind: "target-dir"; codingAgentDir: string };
    engram: { binary: string };
  };
} | { kind: "blocked"; reason: string };

type PiTarballAcquisition = {
  installPiFromVerifiedTarball(
    input: {
      targetDir: string;
      piExecutable: string;
      engramBin: string;
      candidate: typeof candidate;
    },
    deps: {
      download(destination: string): { path: string; bytes: number; sha256: string; sha512: string };
      backupSettings(): void;
      run(invocation: Invocation): { exitCode: number; stdout: string; stderr: string };
      readSettings(): string;
      rewriteSettings(content: string): void;
      writeReceiptAtomic(content: string): void;
    },
  ): InstallResult;
};

async function acquisition(): Promise<PiTarballAcquisition> {
  const mod = await import("../src/lib/pi-runtime.js") as Partial<PiTarballAcquisition>;
  expect(mod.installPiFromVerifiedTarball).toBeTypeOf("function");
  return mod as PiTarballAcquisition;
}

const target = path.resolve("/tmp/jorgex-pi-portable-target");
const codingAgentDir = path.join(target, "pi-agent");
const tarball = path.join(target, "downloads", `jorgex-pi-${PI_RUNTIME_CANDIDATE.package.version}.tgz`);
const packageRunner = path.join(codingAgentDir, "npm", "node_modules", "jorgex-pi", "bin", "jorgex-pi.mjs");
const targetEnvironment = {
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
  PI_CODING_AGENT_DIR: codingAgentDir,
  ENGRAM_BIN: path.join(target, "bin", "engram"),
};

function doctorJson(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    command: "doctor",
    ok: true,
    package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root: path.dirname(path.dirname(packageRunner)) },
    result: { healthy: true, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "ok" }] },
  })}\n`;
}

function deps(
  events: string[],
  artifact: { bytes: number; sha256: string; sha512: string } = candidate,
  settingsJson = JSON.stringify({ packages: ["npm:foreign@1.0.0", `npm:jorgex-pi@file:${tarball}`] }),
) {
  return {
    download(destination: string) {
      events.push(`download:${destination}`);
      return { path: tarball, ...artifact };
    },
    backupSettings() {
      events.push("backup-settings");
    },
    run(call: Invocation) {
      events.push(`${call.executable}:${call.args.join(" ")}`);
      expect(call.environment).toMatchObject(targetEnvironment);
      return call.args[0] === "install"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: doctorJson(), stderr: "" };
    },
    readSettings() {
      events.push("read-settings");
      return settingsJson;
    },
    rewriteSettings(content: string) {
      events.push(`settings:${content}`);
    },
    writeReceiptAtomic(content: string) {
      const parsed = JSON.parse(content) as { state?: string; scope?: { kind?: string; codingAgentDir?: string } };
      events.push(`receipt:${parsed.state}:${parsed.scope?.kind}:${parsed.scope?.codingAgentDir}`);
    },
  };
}

describe("Pi tarball acquisition and portable scope", () => {
  it("verifies the frozen tarball before Pi, installs only a local file alias, preserves package defaults until external projections exist, then uses the package-local doctor", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const events: string[] = [];
    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: targetEnvironment.ENGRAM_BIN,
      candidate,
    }, deps(events));

    expect(result).toMatchObject({
      kind: "installed",
      receipt: {
        schemaVersion: 1,
        scope: { kind: "target-dir", codingAgentDir: path.resolve(codingAgentDir) },
        engram: { binary: targetEnvironment.ENGRAM_BIN },
      },
    });
    expect(events).toEqual([
      `download:${tarball}`,
      "backup-settings",
      `receipt:installing:target-dir:${path.resolve(codingAgentDir)}`,
      `/opt/pi/bin/pi:install npm:jorgex-pi@file:${tarball} --no-approve`,
      "read-settings",
      `settings:${JSON.stringify({ packages: ["npm:foreign@1.0.0", candidate.source] })}`,
      `${process.execPath}:${packageRunner} doctor --json`,
      `receipt:installed:target-dir:${path.resolve(codingAgentDir)}`,
    ]);
    const trace = events.join("\n");
    expect(trace).not.toContain("PI_PACKAGE_DIR");
    expect(trace).not.toContain("NPM_TOKEN");
    expect(trace).not.toContain(process.env.HOME ?? "__no_home__");
  });

  it("normalizes an object alias while preserving its filters, metadata, and foreign entries", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const events: string[] = [];
    const alias = `npm:jorgex-pi@file:${tarball}`;
    const settingsJson = JSON.stringify({
      packages: [
        { source: "npm:foreign@1.0.0", skills: ["foreign-skill"], prompts: ["foreign-prompt"], custom: true },
        { source: alias, skills: ["keep-skill"], prompts: ["keep-prompt"], custom: { label: "keep" } },
      ],
      foreignSetting: "keep",
    });

    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: targetEnvironment.ENGRAM_BIN,
      candidate,
    }, deps(events, candidate, settingsJson));

    expect(result).toMatchObject({ kind: "installed" });
    expect(events).toContain(`settings:${JSON.stringify({
      packages: [
        { source: "npm:foreign@1.0.0", skills: ["foreign-skill"], prompts: ["foreign-prompt"], custom: true },
        { source: candidate.source, skills: ["keep-skill"], prompts: ["keep-prompt"], custom: { label: "keep" } },
      ],
      foreignSetting: "keep",
    })}`);
  });

  it("blocks a string and object alias duplicate without rewriting settings", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const events: string[] = [];
    const alias = `npm:jorgex-pi@file:${tarball}`;
    const settingsJson = JSON.stringify({
      packages: [
        "npm:foreign@1.0.0",
        alias,
        { source: alias, skills: ["keep-skill"], prompts: ["keep-prompt"], custom: true },
      ],
    });

    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: targetEnvironment.ENGRAM_BIN,
      candidate,
    }, deps(events, candidate, settingsJson));

    expect(result).toEqual({ kind: "blocked", reason: "settings-corrupt" });
    expect(events.filter((event) => event.startsWith("settings:")).length).toBe(0);
  });

  it("blocks an ambiguous canonical registration without rewriting settings", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const events: string[] = [];
    const alias = `npm:jorgex-pi@file:${tarball}`;
    const settingsJson = JSON.stringify({
      packages: [
        "npm:foreign@1.0.0",
        alias,
        candidate.source,
        { source: candidate.source, skills: [], prompts: [] },
      ],
    });

    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: targetEnvironment.ENGRAM_BIN,
      candidate,
    }, deps(events, candidate, settingsJson));

    expect(result).toEqual({ kind: "blocked", reason: "settings-corrupt" });
    expect(events.filter((event) => event.startsWith("settings:")).length).toBe(0);
  });

  it("fails closed on any size or digest mismatch before Pi, settings, runner, or receipt mutation", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const cases = [
      { bytes: candidate.bytes + 1, sha256: candidate.sha256, sha512: candidate.sha512 },
      { bytes: candidate.bytes, sha256: "0".repeat(64), sha512: candidate.sha512 },
      { bytes: candidate.bytes, sha256: candidate.sha256, sha512: "0".repeat(128) },
    ];

    for (const artifact of cases) {
      const events: string[] = [];
      const result = installPiFromVerifiedTarball({
        targetDir: target,
        piExecutable: "/opt/pi/bin/pi",
        engramBin: targetEnvironment.ENGRAM_BIN,
        candidate,
      }, deps(events, artifact));
      expect(result).toMatchObject({ kind: "blocked", reason: "tarball-integrity" });
      expect(events).toEqual([`download:${tarball}`]);
    }
  });
});

describe("Pi doctor initialization pending (initialization-diagnostics-v1)", () => {
  const PENDING_MESSAGE = "Pi initialization is pending: run sync to complete first initialization.";
  const PENDING_REMEDY = "Run jorgex-pi sync --json and retry.";
  const PENDING_CHECKS = [
    { id: "package", status: "ok" },
    { id: "engram", status: "ok" },
    { id: "context7", status: "ok" },
    { id: "permissions", status: "error" },
    { id: "experience", status: "error" },
  ] as const;

  function pendingDoctorJson(): string {
    return `${JSON.stringify({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
      package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root: path.dirname(path.dirname(packageRunner)) },
      result: { healthy: false, checks: PENDING_CHECKS },
      error: { phase: "initialization", code: "INITIALIZATION_REQUIRED", message: PENDING_MESSAGE, remedy: PENDING_REMEDY },
    })}\n`;
  }

  function pendingDeps(events: string[], doctor: { exitCode: number; stdout: string; stderr: string }) {
    const base = deps(events);
    return {
      ...base,
      run(call: Invocation) {
        events.push(`${call.executable}:${call.args.join(" ")}`);
        expect(call.environment).toMatchObject(targetEnvironment);
        if (call.args[0] === "install") return { exitCode: 0, stdout: "", stderr: "" };
        return doctor;
      },
    };
  }

  it("accepts only the exact pending envelope as provisional install after validating schema/command/package/root/ordered checks/error", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const events: string[] = [];
    const result = installPiFromVerifiedTarball({
      targetDir: target,
      piExecutable: "/opt/pi/bin/pi",
      engramBin: targetEnvironment.ENGRAM_BIN,
      candidate,
    }, pendingDeps(events, { exitCode: 1, stdout: pendingDoctorJson(), stderr: "" }));

    expect(result).toMatchObject({
      kind: "installed",
      receipt: {
        schemaVersion: 1,
        scope: { kind: "target-dir", codingAgentDir: path.resolve(codingAgentDir) },
        engram: { binary: targetEnvironment.ENGRAM_BIN },
      },
    });
    expect(events).toEqual([
      `download:${tarball}`,
      "backup-settings",
      `receipt:installing:target-dir:${path.resolve(codingAgentDir)}`,
      `/opt/pi/bin/pi:install npm:jorgex-pi@file:${tarball} --no-approve`,
      "read-settings",
      `settings:${JSON.stringify({ packages: ["npm:foreign@1.0.0", candidate.source] })}`,
      `${process.execPath}:${packageRunner} doctor --json`,
      `receipt:installed:target-dir:${path.resolve(codingAgentDir)}`,
    ]);
  });

  it("remains blocked for malformed, wrong identity, wrong checks, or other unhealthy doctor output", async () => {
    const { installPiFromVerifiedTarball } = await acquisition();
    const exact = JSON.parse(pendingDoctorJson().slice(0, -1)) as Record<string, unknown>;
    const packageValue = { ...(exact.package as Record<string, unknown>) };
    const root = path.dirname(path.dirname(packageRunner));
    const cases: Array<{ label: string; doctor: { exitCode: number; stdout: string; stderr: string } }> = [
      { label: "malformed json", doctor: { exitCode: 1, stdout: "{not-json\n", stderr: "" } },
      { label: "wrong schema", doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, schemaVersion: 2 })}\n`, stderr: "" } },
      { label: "wrong command", doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, command: "status" })}\n`, stderr: "" } },
      { label: "wrong package name", doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, package: { ...packageValue, name: "other-pi" } })}\n`, stderr: "" } },
      { label: "wrong package version", doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, package: { ...packageValue, version: "0.0.0" } })}\n`, stderr: "" } },
      { label: "wrong package root", doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, package: { ...packageValue, root: "/tmp/wrong-root" } })}\n`, stderr: "" } },
      {
        label: "wrong check order",
        doctor: {
          exitCode: 1,
          stdout: `${JSON.stringify({ ...exact, result: { healthy: false, checks: [...PENDING_CHECKS].reverse() } })}\n`,
          stderr: "",
        },
      },
      {
        label: "wrong check id",
        doctor: {
          exitCode: 1,
          stdout: `${JSON.stringify({ ...exact, result: { healthy: false, checks: [...PENDING_CHECKS.slice(0, 4), { id: "other", status: "error" }] } })}\n`,
          stderr: "",
        },
      },
      {
        label: "healthy checks with pending error",
        doctor: {
          exitCode: 1,
          stdout: `${JSON.stringify({ ...exact, result: { healthy: true, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "ok" }, { id: "context7", status: "ok" }, { id: "permissions", status: "ok" }, { id: "experience", status: "ok" }] } })}\n`,
          stderr: "",
        },
      },
      {
        label: "other unhealthy without initialization code",
        doctor: {
          exitCode: 1,
          stdout: `${JSON.stringify({
            schemaVersion: 1,
            command: "doctor",
            ok: false,
            package: { name: "jorgex-pi", version: PI_RUNTIME_CANDIDATE.package.version, root },
            result: { healthy: false, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "error" }, { id: "context7", status: "ok" }, { id: "permissions", status: "ok" }, { id: "experience", status: "ok" }] },
            error: { phase: "doctor", code: "UNHEALTHY", message: "One or more required runtime checks failed.", remedy: "Set ENGRAM_BIN to the existing Engram executable and retry." },
          })}\n`,
          stderr: "",
        },
      },
      {
        label: "wrong error phase",
        doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, error: { phase: "doctor", code: "INITIALIZATION_REQUIRED", message: PENDING_MESSAGE, remedy: PENDING_REMEDY } })}\n`, stderr: "" },
      },
      {
        label: "wrong error code",
        doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, error: { phase: "initialization", code: "UNHEALTHY", message: PENDING_MESSAGE, remedy: PENDING_REMEDY } })}\n`, stderr: "" },
      },
      {
        label: "wrong remedy",
        doctor: { exitCode: 1, stdout: `${JSON.stringify({ ...exact, error: { phase: "initialization", code: "INITIALIZATION_REQUIRED", message: PENDING_MESSAGE, remedy: "retry" } })}\n`, stderr: "" },
      },
      { label: "non-empty stderr", doctor: { exitCode: 1, stdout: pendingDoctorJson(), stderr: "warn" } },
      { label: "missing trailing newline", doctor: { exitCode: 1, stdout: pendingDoctorJson().slice(0, -1), stderr: "" } },
      { label: "success exit with pending body", doctor: { exitCode: 0, stdout: pendingDoctorJson(), stderr: "" } },
    ];

    for (const { label, doctor } of cases) {
      const events: string[] = [];
      const result = installPiFromVerifiedTarball({
        targetDir: target,
        piExecutable: "/opt/pi/bin/pi",
        engramBin: targetEnvironment.ENGRAM_BIN,
        candidate,
      }, pendingDeps(events, doctor));
      expect(result, label).toEqual({ kind: "blocked", reason: "runner-unhealthy" });
      expect(events.filter((event) => event.startsWith("receipt:installed")), label).toHaveLength(0);
    }
  });
});
