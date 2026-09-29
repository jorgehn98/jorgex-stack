import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T65 RED for deliberate Playwright refresh with a saved Pi opt-in.
 *
 * Intended code-facing contract (no production change in this RED):
 * - `refreshPiPlaywright({ stateDir, pnpmBin })` is exported from
 *   `src/lib/pi-browser-update.ts` and returns
 *   `{ observed: { version, integrity }, capability }`.
 * - It acquires the current `@playwright/cli` through the existing verified
 *   browser-provider lease, runs the verified version/Chromium smoke, and
 *   authenticates the managed receipt/capability before returning.
 * - It does not write runtime selections or global preference files; the
 *   caller persists the returned observation without changing other runtimes.
 * - A failed browser smoke/launch rolls back the managed activation and never
 *   returns a successful capability.
 */

type Observed = { version: string; integrity: string };
type Capability = {
  cli: { status: "current"; binPath: string; detectedVersion: string };
  browserCache: { status: "ready"; path: string };
  browserVerified: true;
  effective: true;
};
type RefreshModule = {
  refreshPiPlaywright(input: { stateDir: string; pnpmBin: string }): Promise<{
    observed: Observed;
    capability: Capability;
  }>;
};

const LATEST: Observed = {
  version: "0.1.21",
  integrity: `sha512-${Buffer.alloc(64, 71).toString("base64")}`,
};
const OLD: Observed = {
  version: "0.1.18",
  integrity: `sha512-${Buffer.alloc(64, 18).toString("base64")}`,
};

const mocks = vi.hoisted(() => ({
  prepareVerifiedBrowserRelease: vi.fn(),
  activateVerifiedBrowserArtifact: vi.fn(),
  activateManagedBrowserTree: vi.fn(),
  rollbackManagedBrowserActivation: vi.fn(),
  loadVerifiedManagedBrowserReceipt: vi.fn(),
  inspectManagedPlaywrightCapability: vi.fn(),
  isPlaywrightBrowserReady: vi.fn(),
  runVerifiedManagedPlaywright: vi.fn(),
  verifyManagedPlaywrightBrowser: vi.fn(),
  verifyPlaywrightPackageBrowser: vi.fn(),
  executePlaywrightToolAction: vi.fn(),
  resolvePnpmBin: vi.fn(),
}));

vi.mock("../src/lib/browser-provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/browser-provider.js")>()),
  prepareVerifiedBrowserRelease: mocks.prepareVerifiedBrowserRelease,
  activateVerifiedBrowserArtifact: mocks.activateVerifiedBrowserArtifact,
}));

vi.mock("../src/lib/browser-managed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/browser-managed.js")>()),
  activateManagedBrowserTree: mocks.activateManagedBrowserTree,
  rollbackManagedBrowserActivation: mocks.rollbackManagedBrowserActivation,
  loadVerifiedManagedBrowserReceipt: mocks.loadVerifiedManagedBrowserReceipt,
}));

vi.mock("../src/lib/playwright-capability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/playwright-capability.js")>()),
  inspectManagedPlaywrightCapability: mocks.inspectManagedPlaywrightCapability,
}));

vi.mock("../src/lib/browser-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/browser-command.js")>()),
  runVerifiedManagedPlaywright: mocks.runVerifiedManagedPlaywright,
  verifyManagedPlaywrightBrowser: mocks.verifyManagedPlaywrightBrowser,
}));

vi.mock("../src/lib/external-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/external-tools.js")>()),
  verifyPlaywrightPackageBrowser: mocks.verifyPlaywrightPackageBrowser,
  executePlaywrightToolAction: mocks.executePlaywrightToolAction,
  resolvePnpmBin: mocks.resolvePnpmBin,
  isPlaywrightBrowserReady: mocks.isPlaywrightBrowserReady,
}));

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.prepareVerifiedBrowserRelease.mockReset();
  mocks.activateVerifiedBrowserArtifact.mockReset();
  mocks.activateManagedBrowserTree.mockReset();
  mocks.rollbackManagedBrowserActivation.mockReset();
  mocks.loadVerifiedManagedBrowserReceipt.mockReset();
  mocks.inspectManagedPlaywrightCapability.mockReset();
  mocks.isPlaywrightBrowserReady.mockReset();
  mocks.runVerifiedManagedPlaywright.mockReset();
  mocks.verifyManagedPlaywrightBrowser.mockReset();
  mocks.verifyPlaywrightPackageBrowser.mockReset();
  mocks.executePlaywrightToolAction.mockReset();
  mocks.resolvePnpmBin.mockReset();
});

function fixture(): { root: string; stateDir: string; preferencePath: string; beforePreference: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-browser-update-"));
  roots.push(root);
  const stateDir = path.join(root, ".jorgex-stack");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const preferencePath = path.join(stateDir, "playwright-cli.json");
  const beforePreference = `${JSON.stringify({
    version: 2,
    enabled: { pi: true, codex: true },
    observed: OLD,
  })}\n`;
  fs.writeFileSync(preferencePath, beforePreference, { mode: 0o600 });
  return { root, stateDir, preferencePath, beforePreference };
}

function configureSuccess(stateDir: string): void {
  const artifactPath = path.join(stateDir, "verified-playwright-cli.tgz");
  fs.writeFileSync(artifactPath, "verified browser artifact\n", { mode: 0o600 });
  mocks.prepareVerifiedBrowserRelease.mockImplementation(async (_packageName: string, options: {
    withVerifiedArtifact?: (context: unknown) => Promise<void>;
  }) => {
    expect(options.withVerifiedArtifact).toBeTypeOf("function");
    await options.withVerifiedArtifact?.({
      packageName: "@playwright/cli",
      release: { version: LATEST.version, tarballUrl: "https://registry.npmjs.org/@playwright/cli/-/cli-0.1.21.tgz", integrity: LATEST.integrity },
      artifactPath,
      stageDir: path.dirname(artifactPath),
    });
    return LATEST;
  });
  let activated = false;
  const nextReceipt = { ...LATEST, rootPath: "/isolated/new-release", launcherPath: "/isolated/new-launcher" };
  const previousReceipt = { ...OLD, rootPath: "/isolated/old-release", launcherPath: "/isolated/old-launcher" };
  mocks.activateVerifiedBrowserArtifact.mockImplementation(async () => { activated = true; return nextReceipt; });
  mocks.activateManagedBrowserTree.mockResolvedValue({ version: LATEST.version, integrity: LATEST.integrity });
  mocks.rollbackManagedBrowserActivation.mockResolvedValue(undefined);
  mocks.loadVerifiedManagedBrowserReceipt.mockImplementation(() => activated ? nextReceipt : previousReceipt);
  mocks.inspectManagedPlaywrightCapability.mockReturnValue({
    cli: { status: "outdated", binPath: "/isolated/playwright-cli", detectedVersion: LATEST.version },
    browserCache: { status: "ready", path: "/isolated/ms-playwright" },
    browserVerified: false,
    effective: false,
  });
  mocks.runVerifiedManagedPlaywright.mockImplementation((_stateDir: string, args: readonly string[]) => ({
    status: 0,
    stdout: args.includes("--version") ? `playwright-cli ${LATEST.version}\n` : "",
    stderr: "",
  }));
  mocks.isPlaywrightBrowserReady.mockReturnValue({ status: "ready", path: "/isolated/ms-playwright" });
  mocks.verifyManagedPlaywrightBrowser.mockReturnValue(true);
  mocks.verifyPlaywrightPackageBrowser.mockReturnValue(true);
  mocks.executePlaywrightToolAction.mockReturnValue({ ok: true });
  mocks.resolvePnpmBin.mockReturnValue("/isolated/bin/pnpm");
}

async function loadRefresh(): Promise<RefreshModule> {
  const mod = (await import(/* @vite-ignore */ new URL("../src/lib/pi-browser-update.js", import.meta.url).href)) as Partial<RefreshModule>;
  expect(mod.refreshPiPlaywright, "refreshPiPlaywright must be exported from src/lib/pi-browser-update.ts").toBeTypeOf("function");
  return mod as RefreshModule;
}

describe("[T65-RED] Pi Playwright provider refresh", () => {
  it("refreshes the saved opt-in through the verified lease and returns capability without writing preferences", async () => {
    const sandbox = fixture();
    configureSuccess(sandbox.stateDir);
    const refresh = await loadRefresh();

    const result = await refresh.refreshPiPlaywright({ stateDir: sandbox.stateDir, pnpmBin: "/isolated/bin/pnpm" });

    expect(result.observed).toEqual(LATEST);
    expect(result.capability).toMatchObject({ effective: true, browserVerified: true, cli: { detectedVersion: LATEST.version } });
    expect(mocks.prepareVerifiedBrowserRelease).toHaveBeenCalledWith("@playwright/cli", expect.objectContaining({ withVerifiedArtifact: expect.any(Function) }));
    expect(mocks.activateVerifiedBrowserArtifact).toHaveBeenCalled();
    expect(fs.readFileSync(sandbox.preferencePath, "utf8")).toBe(sandbox.beforePreference);
  });

  it("rolls back when the actual Chromium launch fails despite a correct version", async () => {
    const sandbox = fixture(); configureSuccess(sandbox.stateDir);
    mocks.verifyManagedPlaywrightBrowser.mockReturnValue(false);
    const refresh = await loadRefresh();
    await expect(refresh.refreshPiPlaywright({ stateDir: sandbox.stateDir, pnpmBin: "/isolated/bin/pnpm" })).rejects.toThrow(/Chromium|smoke/);
    expect(mocks.rollbackManagedBrowserActivation).toHaveBeenCalledWith(sandbox.stateDir, "@playwright/cli", expect.objectContaining(LATEST), expect.objectContaining(OLD));
    expect(fs.readFileSync(sandbox.preferencePath, "utf8")).toBe(sandbox.beforePreference);
  });

  it("fails closed and rolls back when the verified Chromium smoke fails", async () => {
    const sandbox = fixture();
    configureSuccess(sandbox.stateDir);
    mocks.runVerifiedManagedPlaywright.mockImplementation(() => ({
      status: 1,
      stdout: "",
      stderr: "chromium launch failed",
      error: new Error("chromium launch failed"),
    }));
    const refresh = await loadRefresh();

    await expect(refresh.refreshPiPlaywright({ stateDir: sandbox.stateDir, pnpmBin: "/isolated/bin/pnpm" })).rejects.toThrow(/chromium|browser|launch|smoke/i);
    expect(mocks.rollbackManagedBrowserActivation).toHaveBeenCalled();
    expect(fs.readFileSync(sandbox.preferencePath, "utf8")).toBe(sandbox.beforePreference);
  });
});
