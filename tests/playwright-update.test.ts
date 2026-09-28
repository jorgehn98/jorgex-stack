import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runInstall: vi.fn(),
  observed: { version: "9.9.8", integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` },
  healthy: false,
  detectManaged: vi.fn(() => ({ status: "outdated" as const, binPath: null, detectedVersion: "9.9.8" })),
  prompts: {
    confirm: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    intro: vi.fn(), isCancel: vi.fn(() => false),
    multiselect: vi.fn<() => Promise<string[]>>().mockResolvedValue(["playwright-cli"]),
    outro: vi.fn(), spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock("@clack/prompts", () => mocks.prompts);
vi.mock("../src/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/install.js")>()),
  runInstall: mocks.runInstall,
}));
vi.mock("../src/lib/playwright-capability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/playwright-capability.js")>()),
  detectManagedPlaywrightCli: mocks.detectManaged,
  inspectManagedPlaywrightCapability: () => ({
    cli: { status: mocks.healthy ? "current" : "outdated", binPath: "/isolated/launcher", detectedVersion: mocks.observed.version },
    browserCache: { status: mocks.healthy ? "ready" : "missing", path: "/isolated/browser" },
    browserVerified: mocks.healthy, effective: mocks.healthy,
  }),
}));
vi.mock("../src/lib/tool-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/tool-preferences.js")>()),
  browserPreferenceErrors: () => [],
  loadPlaywrightCliPreference: () => true,
  loadPlaywrightCliObservation: () => ({ ...mocks.observed }),
}));
vi.mock("../src/lib/github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/github.js")>()),
  ghPresentButTokenFailed: () => false,
  githubRateLimited: () => false,
  latestGithubCommit: async () => null,
  latestGithubRelease: async () => null,
}));

let root: string;
let previousHome: string | undefined;
let previousProfile: string | undefined;
let originalTty: PropertyDescriptor | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-managed-update-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  previousHome = process.env.HOME;
  previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
  mocks.observed = { version: "9.9.8", integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}` };
  mocks.healthy = false;
  mocks.prompts.confirm.mockResolvedValue(true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://registry.npmjs.org/@playwright/cli/latest") {
      return new Response(JSON.stringify({ version: "9.9.10" }), { status: 200 });
    }
    if (url === "https://registry.npmjs.org/jorgex-stack/latest") {
      return new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", originalTty);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("managed Playwright update", () => {
  it("checks the managed receipt offline without global package actions", async () => {
    const { runUpdateCheck } = await import("../src/update.js");
    await runUpdateCheck("1.1.0", true);
    expect(mocks.detectManaged).toHaveBeenCalled();
    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.prompts.log.warn).toHaveBeenCalledWith(expect.stringMatching(/Playwright CLI/i));
  });

  it("delegates selected update to verified managed install and reports no runtime sync", async () => {
    mocks.runInstall.mockImplementationOnce(async () => {
      mocks.observed = { version: "9.9.10", integrity: `sha512-${Buffer.alloc(64, 10).toString("base64")}` };
      mocks.healthy = true;
      return 0;
    });
    const { runInteractiveUpdate } = await import("../src/update.js");
    const result = await runInteractiveUpdate("1.1.0", false);
    expect(result).toMatchObject({ exitCode: 0, appliedUpdates: true, syncRequired: false });
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      runtimes: [], dryRun: false, yes: true,
      playwrightToolConsent: expect.objectContaining({ command: "install", explicitToolSelection: true }),
    }));
    expect(mocks.prompts.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({
        value: "playwright-cli", hint: "árbol Stack gestionado con cierre verificado",
      })]),
    }));
  });

  it("reports managed activation failure without claiming an update", async () => {
    mocks.runInstall.mockResolvedValueOnce(1);
    const { runInteractiveUpdate } = await import("../src/update.js");
    const result = await runInteractiveUpdate("1.1.0", false);
    expect(result).toMatchObject({ exitCode: 1, appliedUpdates: false, syncRequired: false });
    expect(mocks.observed.version).toBe("9.9.8");
    expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(/candidato gestionado/i));
  });

  it("does not call install when the second confirmation is declined", async () => {
    mocks.prompts.confirm.mockResolvedValueOnce(false);
    const { runInteractiveUpdate } = await import("../src/update.js");
    const result = await runInteractiveUpdate("1.1.0", false);
    expect(result).toMatchObject({ exitCode: 0, appliedUpdates: false });
    expect(mocks.runInstall).not.toHaveBeenCalled();
  });
});
