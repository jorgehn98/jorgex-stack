import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executePlaywrightToolAction: vi.fn(() => false),
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
  });
});
