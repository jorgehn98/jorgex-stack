import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightToolActionResult } from "../src/lib/external-tools.js";

const mocks = vi.hoisted(() => ({
  executePlaywrightToolAction: vi.fn<() => PlaywrightToolActionResult>(() => ({ ok: false, reason: "action-failed" })),
  savePlaywrightCliPreference: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock("@clack/prompts", () => mocks.prompts);

vi.mock("../src/install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/install.js")>();
  return { ...actual, executePlaywrightToolAction: mocks.executePlaywrightToolAction };
});

vi.mock("../src/lib/tool-preferences.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tool-preferences.js")>();
  return {
    ...actual,
    browserPreferenceErrors: () => [],
    savePlaywrightCliPreference: mocks.savePlaywrightCliPreference,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Playwright uninstall failure", () => {
  it("does not finish with a success outro when package removal fails", async () => {
    const { runUninstall } = await import("../src/uninstall.js");

    await expect(runUninstall({
      runtimes: [],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: true,
    })).resolves.toBe(1);

    expect(mocks.prompts.outro).toHaveBeenCalledWith(expect.stringMatching(/errores/i));
    expect(mocks.prompts.outro).not.toHaveBeenCalledWith(expect.stringMatching(/^Hecho\./i));
    expect(mocks.prompts.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/jorgex-stack uninstall --remove-playwright/i),
    );
  });

  it("reports the partial state when package removal succeeds but preference persistence fails", async () => {
    mocks.executePlaywrightToolAction.mockReturnValueOnce({ ok: true });
    mocks.savePlaywrightCliPreference.mockImplementationOnce(() => {
      throw new Error("preference write failed");
    });
    const { runUninstall } = await import("../src/uninstall.js");

    await expect(runUninstall({
      runtimes: [],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: true,
    })).resolves.toBe(1);

    expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(/paquete.*retirado.*preferencia/i));
    expect(mocks.prompts.outro).toHaveBeenCalledWith(expect.stringMatching(/errores/i));
  });

  it("keeps the preference unpersisted and gives the setup remedy when the global bin is unavailable", async () => {
    mocks.executePlaywrightToolAction.mockReturnValueOnce({ ok: false, reason: "pnpm-global-bin" });
    const { runUninstall } = await import("../src/uninstall.js");

    await expect(runUninstall({
      runtimes: [],
      dryRun: false,
      yes: true,
      removeEngram: false,
      removePlaywright: true,
    })).resolves.toBe(1);

    expect(mocks.executePlaywrightToolAction).toHaveBeenCalledTimes(1);
    expect(mocks.executePlaywrightToolAction).toHaveBeenCalledWith("remove");
    expect(mocks.savePlaywrightCliPreference).not.toHaveBeenCalled();
    expect(mocks.prompts.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/pnpm setup.*jorgex-stack uninstall --remove-playwright/i),
    );
  });
});
