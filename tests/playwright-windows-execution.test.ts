import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  resolvePnpmBin: vi.fn<() => string | null>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mocks.execFileSync };
});

vi.mock("../src/lib/external-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/external-tools.js")>();
  return { ...actual, resolvePnpmBin: mocks.resolvePnpmBin };
});

const tempDirs: string[] = [];

afterEach(() => {
  mocks.execFileSync.mockReset();
  mocks.resolvePnpmBin.mockReset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.JX_PLAYWRIGHT_ACTION_FILE;
  vi.resetModules();
});

describe("Playwright pnpm execution on Windows", () => {
  // Synthetic test-only verified candidate shared by this file's Windows
  // contract. Fixture, never a version selector: the exact version travels
  // with its canonical scoped URL and SRI into the executed argv.
  const VERIFIED_CANDIDATE = {
    version: "9.9.10",
    tarballUrl: "https://registry.npmjs.org/@playwright/cli/-/cli-9.9.10.tgz",
    integrity: `sha512-${Buffer.alloc(64, 10).toString("base64")}`,
  };

  it.skipIf(process.platform !== "win32")("runs an injected real pnpm.cmd shim through cmd.exe without shell:true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-pnpm-cmd-"));
    tempDirs.push(dir);
    const shim = path.join(dir, "pnpm.cmd");
    const observedArgs = path.join(dir, "pnpm-args.txt");
    fs.writeFileSync(
      shim,
      '@echo off\r\nif "%1"=="bin" if "%2"=="--global" (\r\n'
        + '  echo C:\\Users\\test\\AppData\\Local\\pnpm\r\n'
        + '  exit /b 0\r\n'
        + ')\r\necho %* > "%JX_PLAYWRIGHT_ACTION_FILE%"\r\n',
    );
    process.env.JX_PLAYWRIGHT_ACTION_FILE = observedArgs;
    mocks.resolvePnpmBin.mockReturnValue(shim);

    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    mocks.execFileSync.mockImplementation(actualChildProcess.execFileSync);
    const { executePlaywrightToolAction } = await import("../src/install.js");

    expect(executePlaywrightToolAction("install", undefined, undefined, VERIFIED_CANDIDATE)).toEqual({ ok: true });
    expect(fs.readFileSync(observedArgs, "utf8").trim()).toBe("add --global @playwright/cli@9.9.10");

    const mutationCall = mocks.execFileSync.mock.calls.find(([, args]) =>
      Array.isArray(args) && args.at(-1)?.includes("add --global @playwright/cli@9.9.10"),
    );
    expect(mutationCall).toBeDefined();
    const [command, args, options] = mutationCall as [string, string[], { shell?: boolean }];
    expect(path.basename(command).toLowerCase()).toBe("cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args.at(-1)).toContain(shim);
    expect(options.shell).not.toBe(true);
  });
});
