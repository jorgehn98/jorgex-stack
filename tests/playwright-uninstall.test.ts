import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preferenceFile: "",
  savePreference: vi.fn(),
  createBackup: vi.fn(),
  globalRemoval: vi.fn(),
  prompts: {
    intro: vi.fn(), outro: vi.fn(),
    log: { error: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn() },
  },
}));

vi.mock("@clack/prompts", () => mocks.prompts);
vi.mock("../src/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/install.js")>()),
  executePlaywrightToolAction: mocks.globalRemoval,
}));
vi.mock("../src/lib/tool-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/tool-preferences.js")>()),
  browserPreferenceErrors: () => [],
  playwrightCliPreferenceFile: () => mocks.preferenceFile,
  savePlaywrightCliPreference: mocks.savePreference,
}));
vi.mock("../src/lib/backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/backup.js")>()),
  createBackup: mocks.createBackup,
}));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-managed-playwright-uninstall-"));
  mocks.preferenceFile = path.join(root, "playwright-cli.json");
  fs.writeFileSync(mocks.preferenceFile, '{"version":1,"enabled":true}\n');
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

const options = { runtimes: [], dryRun: false, yes: true, removeEngram: false, removePlaywright: true } as const;

describe("managed Playwright uninstall", () => {
  it("backs up and disables the preference without removing any global package", async () => {
    const { runUninstall } = await import("../src/uninstall.js");
    await expect(runUninstall({ ...options, runtimes: [] })).resolves.toBe(0);
    expect(mocks.createBackup).toHaveBeenCalledWith([mocks.preferenceFile], "uninstall-playwright-preference");
    expect(mocks.savePreference).toHaveBeenCalledWith(mocks.preferenceFile, false);
    expect(mocks.globalRemoval).not.toHaveBeenCalled();
    expect(mocks.prompts.outro).toHaveBeenCalledWith(expect.stringMatching(/^Hecho\./i));
  });

  it("reports failure if the preference cannot be disabled, without touching globals", async () => {
    mocks.savePreference.mockImplementationOnce(() => { throw new Error("preference write failed"); });
    const { runUninstall } = await import("../src/uninstall.js");
    await expect(runUninstall({ ...options, runtimes: [] })).resolves.toBe(1);
    expect(mocks.globalRemoval).not.toHaveBeenCalled();
    expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(/preferencia.*preference write failed/i));
  });

  it("keeps the preference in dry-run and target-dir", async () => {
    const { runUninstall } = await import("../src/uninstall.js");
    await expect(runUninstall({ ...options, runtimes: [], dryRun: true })).resolves.toBe(0);
    await expect(runUninstall({ ...options, runtimes: [], targetDir: path.join(root, "target") })).resolves.toBe(0);
    expect(mocks.createBackup).not.toHaveBeenCalled();
    expect(mocks.savePreference).not.toHaveBeenCalled();
    expect(mocks.globalRemoval).not.toHaveBeenCalled();
  });
});
