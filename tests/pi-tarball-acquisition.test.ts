import path from "node:path";
import { describe, expect, it } from "vitest";

const candidate = {
  source: "npm:jorgex-pi@0.3.0",
  bytes: 89_104_529,
  sha256: "13919b9aaed407e4e08c774cd24a496d3befbd91de6aafd37725fd7263963a3b",
  sha512: "85c9adf038e8a0e826009fc8cffe23006688c184a43602d81e29807516073e604b0e451bd8f6883f1d352fb858d232acd593d72af67689b8ef5f7467f17fc096",
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
const tarball = path.join(target, "downloads", "jorgex-pi-0.3.0.tgz");
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
    package: { name: "jorgex-pi", version: "0.3.0", root: path.dirname(path.dirname(packageRunner)) },
    result: { healthy: true, checks: [{ id: "package", status: "ok" }, { id: "engram", status: "ok" }] },
  })}\n`;
}

function deps(
  events: string[],
  artifact: { bytes: number; sha256: string; sha512: string } = candidate,
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
      return JSON.stringify({ packages: ["npm:foreign@1.0.0", `npm:jorgex-pi@file:${tarball}`] });
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
  it("verifies the frozen tarball before Pi, installs only a local file alias, normalizes its one entry, then uses the package-local doctor", async () => {
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
      `download:${path.join(target, "downloads", "jorgex-pi-0.3.0.tgz")}`,
      "backup-settings",
      `receipt:installing:target-dir:${path.resolve(codingAgentDir)}`,
      `/opt/pi/bin/pi:install npm:jorgex-pi@file:${tarball} --no-approve`,
      "read-settings",
      `settings:${JSON.stringify({ packages: ["npm:foreign@1.0.0", { source: candidate.source, skills: [] }] })}`,
      `${process.execPath}:${packageRunner} doctor --json`,
      `receipt:installed:target-dir:${path.resolve(codingAgentDir)}`,
    ]);
    const trace = events.join("\n");
    expect(trace).not.toContain("PI_PACKAGE_DIR");
    expect(trace).not.toContain("NPM_TOKEN");
    expect(trace).not.toContain(process.env.HOME ?? "__no_home__");
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
      expect(events).toEqual([`download:${path.join(target, "downloads", "jorgex-pi-0.3.0.tgz")}`]);
    }
  });
});
