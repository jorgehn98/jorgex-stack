import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAYWRIGHT_CLI,
  PNPM_GLOBAL_BIN_REMEDY,
  isPlaywrightBrowserReady,
  planPlaywrightCliCommand,
  resolvePnpmBin,
  resolvePnpmFailureRemedy,
  setupPnpmGlobal,
  resolvePlaywrightCliState,
  executePlaywrightToolAction,
  verifyPlaywrightBrowser,
  detectPlaywrightCli,
} from "../src/lib/external-tools.js";
import { runDetectedBin } from "../src/lib/detect.js";
import {
  loadPlaywrightCliPreference,
  playwrightCliPreferenceFile,
  savePlaywrightCliPreference,
} from "../src/lib/tool-preferences.js";

const PINNED_PACKAGE = "@playwright/cli@0.1.18";
const WINDOWS_PLAYWRIGHT_BIN = "C:\\Users\\test\\AppData\\Local\\pnpm\\playwright-cli.cmd";
const WINDOWS_PNPM_BIN = "C:\\Users\\test\\AppData\\Local\\pnpm\\pnpm.cmd";
const tempDirs: string[] = [];
const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  lookPath: vi.fn<(command: string) => string | null>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mocks.execFileSync };
});

vi.mock("../src/lib/detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/detect.js")>();
  return { ...actual, lookPath: mocks.lookPath };
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-external-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  mocks.execFileSync.mockReset();
  mocks.lookPath.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Playwright CLI external tool core", () => {
  it("disables update notification only in the Playwright version subprocess", () => {
    const original = process.env.NO_UPDATE_NOTIFIER;
    mocks.lookPath.mockReturnValue(process.execPath);
    mocks.execFileSync.mockReturnValue("0.1.18\n");

    expect(detectPlaywrightCli().status).toBe("current");
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocks.execFileSync.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["--version"]);
    expect(options.timeout).toBe(5000);
    expect(options.env?.NO_UPDATE_NOTIFIER).toBe("1");
    expect(options.env?.PATH).toBe(process.env.PATH);
    expect(process.env.NO_UPDATE_NOTIFIER).toBe(original);

    mocks.execFileSync.mockClear();
    runDetectedBin(process.execPath, ["--version"], 5000);
    expect(mocks.execFileSync.mock.calls[0]?.[2]).not.toHaveProperty("env");
  });

  it("defines the approved package, binary, and release pin", () => {
    expect(PLAYWRIGHT_CLI).toMatchObject({
      packageName: "@playwright/cli",
      bin: "playwright-cli",
      version: "0.1.18",
    });
  });

  it.each([
    {
      name: "absent when no executable was detected",
      input: { binPath: null, versionOutput: null },
      expected: { status: "absent", detectedVersion: null, binPath: null },
    },
    {
      name: "broken when the executable cannot return a version",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: null },
      expected: { status: "broken", detectedVersion: null, binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
    {
      name: "broken when the version output is malformed",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "playwright-cli unknown\n" },
      expected: { status: "broken", detectedVersion: null, binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
    {
      name: "current only at the approved release",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "playwright-cli 0.1.18\n" },
      expected: { status: "current", detectedVersion: "0.1.18", binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
    {
      name: "current when the CLI reports the bare approved release",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "0.1.18" },
      expected: { status: "current", detectedVersion: "0.1.18", binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
    {
      name: "outdated for another parseable release",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "playwright-cli 0.1.16\n" },
      expected: { status: "outdated", detectedVersion: "0.1.16", binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
  ])("reports $name", ({ input, expected }) => {
    expect(resolvePlaywrightCliState(input)).toMatchObject(expected);
  });

  it.each([
    ["install", ["add", "--global", PINNED_PACKAGE]],
    ["update", ["add", "--global", PINNED_PACKAGE]],
    ["remove", ["remove", "--global", "@playwright/cli"]],
    ["install-browser", ["dlx", PINNED_PACKAGE, "install-browser", "chromium"]],
  ] as const)("plans %s as direct pinned pnpm argv", (action, args) => {
    expect(planPlaywrightCliCommand(action, WINDOWS_PNPM_BIN)).toEqual({
      command: WINDOWS_PNPM_BIN,
      args,
    });
  });

  it("returns a typed global-bin failure without mutating global actions", () => {
    const preflightCalls: string[][] = [];
    const globalMutationCalls: string[][] = [];
    mocks.execFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === "bin" && args[1] === "--global") {
        preflightCalls.push(args);
        throw Object.assign(new Error("Unable to find the global bin directory"), { status: 1 });
      }
      if (args[1] === "--global") globalMutationCalls.push(args);
      return "";
    });
    const pnpmBin = "C:\\tools\\pnpm.exe";
    const globalActions = ["install", "update", "remove"] as const;

    const globalResults = globalActions.map((action) => executePlaywrightToolAction(action, pnpmBin));

    expect(globalResults).toEqual(globalActions.map(() => ({ ok: false, reason: "pnpm-global-bin" })));
    expect(preflightCalls).toEqual(globalActions.map(() => ["bin", "--global"]));
    expect(globalMutationCalls).toEqual([]);
  });

  it("returns browser-launch when Chromium cannot launch after the pinned browser download", () => {
    const globalRoot = tempDir();
    const packageDir = path.join(globalRoot, "@playwright", "cli");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@playwright/cli", version: "0.1.18" }));

    let downloadCwd: string | undefined;
    mocks.execFileSync.mockImplementation((command, args: string[], options?: { cwd?: string }) => {
      if (args[0] === "dlx") {
        downloadCwd = options?.cwd;
        return "";
      }
      if (args[0] === "root" && args[1] === "--global") return `${globalRoot}\n`;
      if (command === process.execPath && args[0] === "-e") {
        throw Object.assign(new Error("Chromium failed to launch"), { status: 1 });
      }
      throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
    });

    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", PNPM_HOME: "/tmp/jx-pnpm", JX_TEST_ENV: "preserved" };
    expect(executePlaywrightToolAction("install-browser", "/usr/bin/pnpm", env)).toEqual({
      ok: false,
      reason: "browser-launch",
    });

    expect(downloadCwd).toBeDefined();
    expect(downloadCwd).not.toBe(process.cwd());
    expect(downloadCwd && fs.existsSync(downloadCwd)).toBe(false);
    const downloadCall = mocks.execFileSync.mock.calls.find(([, args]) => args?.[0] === "dlx");
    expect(downloadCall?.[1]).toEqual(["dlx", PINNED_PACKAGE, "install-browser", "chromium"]);
    expect(downloadCall?.[2]).toEqual(expect.objectContaining({
      cwd: downloadCwd,
      env: expect.objectContaining({ JX_TEST_ENV: "preserved", NO_UPDATE_NOTIFIER: "1" }),
    }));
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args?.[0] === "add" || args?.[0] === "remove")).toBe(false);
  });

  it("returns success only after the global CLI Chromium smoke test passes and cleans its temporary cwd", () => {
    const globalRoot = tempDir();
    const packageDir = path.join(globalRoot, "@playwright", "cli");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@playwright/cli", version: "0.1.18" }));

    let downloadCwd: string | undefined;
    mocks.execFileSync.mockImplementation((command, args: string[], options?: { cwd?: string }) => {
      if (args[0] === "dlx") {
        downloadCwd = options?.cwd;
        return "";
      }
      if (args[0] === "root" && args[1] === "--global") return `${globalRoot}\n`;
      if (command === process.execPath && args[0] === "-e") return "";
      throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
    });

    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", PNPM_HOME: "/tmp/jx-pnpm", JX_TEST_ENV: "preserved" };
    expect(executePlaywrightToolAction("install-browser", "/usr/bin/pnpm", env)).toEqual({ ok: true });

    expect(downloadCwd).toBeDefined();
    expect(downloadCwd && fs.existsSync(downloadCwd)).toBe(false);
    const smokeCall = mocks.execFileSync.mock.calls.find(([command, args]) => command === process.execPath && args?.[0] === "-e");
    expect(smokeCall?.[2]).toEqual(expect.objectContaining({
      cwd: downloadCwd,
      timeout: 25_000,
      env: expect.objectContaining({ JX_TEST_ENV: "preserved", NO_UPDATE_NOTIFIER: "1" }),
    }));
    expect(smokeCall?.[1]).toEqual(expect.arrayContaining([
      "-e",
      expect.stringContaining("chromium"),
    ]));
    expect(smokeCall?.[1]).toEqual(expect.arrayContaining([
      expect.stringContaining("about:blank"),
    ]));
  });

  it("exposes the Chromium verification helper as a boolean process boundary", () => {
    const globalRoot = tempDir();
    const packageDir = path.join(globalRoot, "@playwright", "cli");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@playwright/cli", version: "0.1.18" }));
    mocks.execFileSync.mockImplementation((command, args: string[]) => {
      if (args[0] === "root" && args[1] === "--global") return `${globalRoot}\n`;
      if (command === process.execPath && args[0] === "-e") return "";
      throw new Error(`unexpected process: ${command} ${args.join(" ")}`);
    });

    expect(verifyPlaywrightBrowser("/usr/bin/pnpm", { PATH: "/usr/bin:/bin" })).toBe(true);
  });

  it.each(["", " \n", "\t\n"])(
    "treats pnpm bin --global output %j as a global-bin failure without mutating global actions",
    (preflightOutput) => {
      const preflightCalls: string[][] = [];
      const globalMutationCalls: string[][] = [];
      mocks.execFileSync.mockImplementation((_command, args: string[]) => {
        if (args[0] === "bin" && args[1] === "--global") {
          preflightCalls.push(args);
          return preflightOutput;
        }
        if (args[1] === "--global") globalMutationCalls.push(args);
        return "/home/test/.local/share/pnpm\n";
      });

      const globalActions = ["install", "update", "remove"] as const;
      const results = globalActions.map((action) => executePlaywrightToolAction(action, "/usr/bin/pnpm"));

      expect(results).toEqual(globalActions.map(() => ({ ok: false, reason: "pnpm-global-bin" })));
      expect(preflightCalls).toEqual(globalActions.map(() => ["bin", "--global"]));
      expect(globalMutationCalls).toEqual([]);
    },
  );

  it("accepts a non-empty global-bin path for global package actions", () => {
    const calls: string[][] = [];
    mocks.execFileSync.mockImplementation((_command, args: string[]) => {
      calls.push(args);
      return "/home/test/.local/share/pnpm\n";
    });

    expect(executePlaywrightToolAction("install", "/usr/bin/pnpm")).toEqual({ ok: true });
    expect(calls).toEqual([
      ["bin", "--global"],
      ["add", "--global", PINNED_PACKAGE],
    ]);

  });

  it("passes the prepared child environment to pnpm preflight and action", () => {
    mocks.lookPath.mockReturnValue("/usr/bin/pnpm");
    mocks.execFileSync.mockReturnValue("/isolated/pnpm\n");
    const childEnv: NodeJS.ProcessEnv = {
      PNPM_HOME: "/isolated/pnpm",
      PATH: `/isolated/pnpm/bin${path.delimiter}/isolated/pnpm`,
    };

    expect(executePlaywrightToolAction("install", "/usr/bin/pnpm", childEnv)).toEqual({ ok: true });
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
    for (const [, , options] of mocks.execFileSync.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ env: childEnv }));
    }
  });

  it("prepares pnpm setup with a returned environment without mutating the parent process", () => {
    const pnpmHome = path.join(tempDir(), "pnpm-home");
    vi.stubEnv("PNPM_HOME", pnpmHome);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const parentPnpmHome = process.env.PNPM_HOME;
    const parentPath = process.env.PATH;
    mocks.execFileSync.mockReturnValue("");

    const result = setupPnpmGlobal("/usr/bin/pnpm");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PNPM_HOME).toBe(pnpmHome);
    const pathEntries = result.env.PATH?.split(path.delimiter) ?? [];
    expect(pathEntries).toEqual(expect.arrayContaining([pnpmHome, path.join(pnpmHome, "bin")]));
    expect(mocks.execFileSync.mock.calls.some(([, args]) => args?.[0] === "setup")).toBe(true);
    expect(process.env.PNPM_HOME).toBe(parentPnpmHome);
    expect(process.env.PATH).toBe(parentPath);
  });

  it.each(["ENOENT", "EACCES"] as const)("classifies a %s preflight spawn failure as a pnpm command error", (code) => {
    const globalMutationCalls: string[][] = [];
    mocks.execFileSync.mockImplementation((_command, args: string[]) => {
      if (args[0] === "bin" && args[1] === "--global") {
        throw Object.assign(new Error(`pnpm preflight ${code}`), { code });
      }
      if (args[1] === "--global") globalMutationCalls.push(args);
      return "";
    });

    expect(executePlaywrightToolAction("install", "C:\\tools\\pnpm.exe")).toEqual({
      ok: false,
      reason: "pnpm-command",
    });
    expect(globalMutationCalls).toEqual([]);
  });

  it.each([
    ["pnpm-unavailable", "Instala pnpm o añádelo a PATH antes de reintentar."],
    ["pnpm-command", "No se pudo ejecutar pnpm. Revisa su instalación, PATH y permisos antes de reintentar."],
    ["pnpm-global-bin", PNPM_GLOBAL_BIN_REMEDY],
    ["action-failed", null],
  ] as const)("maps %s to its reusable pnpm remedy", (reason, expected) => {
    expect(resolvePnpmFailureRemedy(reason)).toBe(expected);
  });

  it("does not resolve an unsupported pnpm.ps1 shim", () => {
    mocks.lookPath.mockImplementation((command) => command === "pnpm"
      ? "C:\\Users\\test\\AppData\\Local\\pnpm\\pnpm.ps1"
      : null);

    expect(resolvePnpmBin()).toBeNull();
    expect(mocks.lookPath).toHaveBeenCalledWith("pnpm");
    expect(mocks.lookPath).toHaveBeenCalledWith("pnpm.cmd");
  });

  it("reports a known pnpm-home Playwright shim outside PATH without executing it", () => {
    const pnpmHome = tempDir();
    const shim = path.join(pnpmHome, PLAYWRIGHT_CLI.bin);
    fs.writeFileSync(shim, "#!/bin/sh\n");
    vi.stubEnv("PNPM_HOME", pnpmHome);
    vi.stubEnv("PATH", "/empty");
    mocks.lookPath.mockReturnValue(null);

    expect(detectPlaywrightCli()).toEqual({
      status: "not-in-path",
      binPath: shim,
      detectedVersion: null,
    });
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    ["ENOENT", "missing"],
    ["ENOTDIR", "unreadable"],
  ] as const)("classifies a browser cache %s error with its path and code", (errorCode, status) => {
    const cachePath = path.join(tempDir(), "ms-playwright");
    if (errorCode === "ENOTDIR") fs.writeFileSync(cachePath, "not a directory");

    expect(isPlaywrightBrowserReady(
      { PLAYWRIGHT_BROWSERS_PATH: cachePath },
      "win32",
      "C:\\Users\\test",
    )).toEqual({ status, path: cachePath, errorCode });
  });

  it("classifies an unreadable browser cache with its path and EACCES code", () => {
    const cachePath = "C:\\Users\\test\\AppData\\Local\\ms-playwright";
    vi.spyOn(fs, "readdirSync").mockImplementation((() => {
      throw Object.assign(new Error("EACCES reading browser cache"), { code: "EACCES" });
    }) as typeof fs.readdirSync);

    expect(isPlaywrightBrowserReady(
      { PLAYWRIGHT_BROWSERS_PATH: cachePath },
      "win32",
      "C:\\Users\\test",
    )).toEqual({ status: "unreadable", path: cachePath, errorCode: "EACCES" });
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{not json"],
    ["an unsupported preference version", JSON.stringify({ version: 2, enabled: true })],
    ["a non-boolean choice", JSON.stringify({ version: 1, enabled: "true" })],
  ] as const)("never authorizes installation from a %s preference", (_name, raw) => {
    const stateDir = path.join(tempDir(), ".jorgex-stack");
    const file = playwrightCliPreferenceFile(stateDir);
    if (raw !== undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, raw, "utf8");
    }

    expect(loadPlaywrightCliPreference(file)).toBeUndefined();
    if (raw === undefined) expect(fs.existsSync(file)).toBe(false);
  });

  it.each([true, false])("persists an explicit enabled=%s choice in the versioned state file", (enabled) => {
    const stateDir = path.join(tempDir(), ".jorgex-stack");
    const file = playwrightCliPreferenceFile(stateDir);

    savePlaywrightCliPreference(file, enabled);

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, enabled });
    expect(loadPlaywrightCliPreference(file)).toBe(enabled);
  });
});
