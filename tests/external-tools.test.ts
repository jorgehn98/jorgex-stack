import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAYWRIGHT_CLI,
  isPlaywrightBrowserReady,
  planPlaywrightCliCommand,
  resolvePnpmBin,
  resolvePlaywrightCliState,
} from "../src/lib/external-tools.js";
import {
  loadPlaywrightCliPreference,
  playwrightCliPreferenceFile,
  savePlaywrightCliPreference,
} from "../src/lib/tool-preferences.js";

const PINNED_PACKAGE = "@playwright/cli@0.1.17";
const WINDOWS_PLAYWRIGHT_BIN = "C:\\Users\\test\\AppData\\Local\\pnpm\\playwright-cli.cmd";
const WINDOWS_PNPM_BIN = "C:\\Users\\test\\AppData\\Local\\pnpm\\pnpm.cmd";
const tempDirs: string[] = [];
const mocks = vi.hoisted(() => ({
  lookPath: vi.fn<(command: string) => string | null>(),
}));

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
  mocks.lookPath.mockReset();
  vi.restoreAllMocks();
});

describe("Playwright CLI external tool core", () => {
  it("defines the approved package, binary, and release pin", () => {
    expect(PLAYWRIGHT_CLI).toMatchObject({
      packageName: "@playwright/cli",
      bin: "playwright-cli",
      version: "0.1.17",
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
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "playwright-cli 0.1.17\n" },
      expected: { status: "current", detectedVersion: "0.1.17", binPath: WINDOWS_PLAYWRIGHT_BIN },
    },
    {
      name: "current when the CLI reports the bare approved release",
      input: { binPath: WINDOWS_PLAYWRIGHT_BIN, versionOutput: "0.1.17" },
      expected: { status: "current", detectedVersion: "0.1.17", binPath: WINDOWS_PLAYWRIGHT_BIN },
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
    ["install-browser", ["dlx", PINNED_PACKAGE, "install-browser"]],
  ] as const)("plans %s as direct pinned pnpm argv", (action, args) => {
    expect(planPlaywrightCliCommand(action, WINDOWS_PNPM_BIN)).toEqual({
      command: WINDOWS_PNPM_BIN,
      args,
    });
  });

  it("does not resolve an unsupported pnpm.ps1 shim", () => {
    mocks.lookPath.mockImplementation((command) => command === "pnpm"
      ? "C:\\Users\\test\\AppData\\Local\\pnpm\\pnpm.ps1"
      : null);

    expect(resolvePnpmBin()).toBeNull();
    expect(mocks.lookPath).toHaveBeenCalledWith("pnpm");
    expect(mocks.lookPath).toHaveBeenCalledWith("pnpm.cmd");
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
