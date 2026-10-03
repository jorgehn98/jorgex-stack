import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Presupuesto de la ruta Browser Control.
 *
 * `jorgex-stack browser control <args>` no hereda el timeout fijo de Playwright:
 * comandos foreground como `serve`, el handoff humano y la grabación pueden
 * durar más de dos minutos y Stack no debe matarlos con un presupuesto ajeno.
 * La ruta Playwright verificada conserva su presupuesto anterior (120 s).
 *
 * Seam: se observa la opción `timeout` que recibe el `spawnSync` externo. El
 * planner del guard se sustituye por un doble que solo compone la invocación;
 * los bytes del árbol verificado y el guard real los cubre el black-box
 * `browser-control-cli-dispatch.test.ts`. No se abre ningún proceso, relay ni
 * Chrome.
 */

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  planManagedBrowserInvocation: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: mocks.spawnSync };
});

vi.mock("../src/lib/browser-managed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/browser-managed.js")>();
  return { ...actual, planManagedBrowserInvocation: mocks.planManagedBrowserInvocation };
});

const BC_PACKAGE = "@opencode-ai/browser-control";
const PLAYWRIGHT_PACKAGE = "@playwright/cli";
const PLAYWRIGHT_TIMEOUT_MS = 120_000;

const tempDirs: string[] = [];

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-command-"));
  tempDirs.push(dir);
  return dir;
}

let stateDir = "";

type SpawnCall = [string, string[], { timeout?: number }];

function onlySpawnCall(): SpawnCall {
  expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  return mocks.spawnSync.mock.calls[0] as unknown as SpawnCall;
}

beforeEach(() => {
  stateDir = tempStateDir();
  mocks.spawnSync.mockReset();
  mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });
  mocks.planManagedBrowserInvocation.mockReset();
  mocks.planManagedBrowserInvocation.mockImplementation(
    (_stateDir: string, _packageName: string, args: readonly string[]) => ({
      command: process.execPath,
      args: ["--guarded-launcher", ...args],
    }),
  );
});

afterEach(() => {
  mocks.spawnSync.mockReset();
  mocks.planManagedBrowserInvocation.mockReset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("browser command timeout budget", () => {
  it.each([
    { subcommand: "serve", args: ["serve", "--session", "docs", "--json"] },
    {
      subcommand: "execute",
      args: ["execute", "--session", "docs", "--file", "script.js", "--help", "return page.getByText('Continue').click()"],
    },
  ])(
    "no impone el timeout fijo de Playwright a Browser Control ($subcommand)",
    async ({ args }) => {
      const { runManagedBrowserControlCommand } = await import("../src/lib/browser-command.js");

      const status = runManagedBrowserControlCommand(args, stateDir);

      expect(status).toBe(0);
      expect(mocks.planManagedBrowserInvocation).toHaveBeenCalledWith(stateDir, BC_PACKAGE, args);
      const [command, spawnedArgs, options] = onlySpawnCall();
      expect(command).toBe(process.execPath);
      expect(spawnedArgs).toEqual(["--guarded-launcher", ...args]);
      // RED actual: la ruta hereda 120000; el contrato exige que ningún deadline
      // artificial de Stack gobierne la operación.
      expect(options.timeout ?? 0).toBe(0);
    },
  );

  it("conserva el presupuesto de 120s en la ruta Playwright verificada", async () => {
    const { runVerifiedManagedPlaywright } = await import("../src/lib/browser-command.js");

    const result = runVerifiedManagedPlaywright(stateDir, ["--version"]);

    expect(result).toEqual({ status: 0, error: undefined });
    expect(mocks.planManagedBrowserInvocation).toHaveBeenCalledWith(stateDir, PLAYWRIGHT_PACKAGE, ["--version"]);
    const [command, spawnedArgs, options] = onlySpawnCall();
    expect(command).toBe(process.execPath);
    expect(spawnedArgs).toEqual(["--guarded-launcher", "--version"]);
    expect(options.timeout).toBe(PLAYWRIGHT_TIMEOUT_MS);
  });
});
