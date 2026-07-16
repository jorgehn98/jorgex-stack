import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightToolActionResult } from "../src/lib/external-tools.js";

const mocks = vi.hoisted(() => ({
  executePlaywrightToolAction: vi.fn<(action: string) => PlaywrightToolActionResult>(() => ({ ok: true })),
  prompts: {
    confirm: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    intro: vi.fn(),
    isCancel: vi.fn(() => false),
    multiselect: vi.fn<() => Promise<string[]>>().mockResolvedValue(["playwright-cli"]),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    log: {
      error: vi.fn(),
      info: vi.fn(),
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

vi.mock("../src/lib/external-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/external-tools.js")>();
  return {
    ...actual,
    detectPlaywrightCli: () => ({
      status: "outdated" as const,
      binPath: "C:/pnpm/playwright-cli.cmd",
      detectedVersion: "0.1.16",
    }),
  };
});

vi.mock("../src/lib/tool-preferences.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/tool-preferences.js")>();
  return { ...actual, loadPlaywrightCliPreference: () => true };
});

vi.mock("../src/lib/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/github.js")>();
  return {
    ...actual,
    ghPresentButTokenFailed: () => false,
    githubRateLimited: () => false,
    latestGithubCommit: async () => null,
    latestGithubRelease: async () => null,
  };
});

afterEach(() => {
  mocks.executePlaywrightToolAction.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Playwright update", () => {
  it("updates the pinned package and browser without requiring a runtime sync", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "1.1.0" }))));
    const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
    try {
      const { runInteractiveUpdate } = await import("../src/update.js");

      await expect(runInteractiveUpdate("1.1.0", false)).resolves.toMatchObject({
        exitCode: 0,
        appliedUpdates: true,
        syncRequired: false,
      });
      expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual([
        "update",
        "install-browser",
      ]);
    } finally {
      if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", originalTty);
    }
  });

  it.each([
    { reason: "action-failed", remedy: /install --playwright/i },
    { reason: "pnpm-command", remedy: /revisa su instalación, PATH y permisos.*jorgex-stack update/i },
  ] as const)("reports a browser-only $reason failure with its remedy", async ({ reason, remedy }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "1.1.0" }))));
    mocks.executePlaywrightToolAction.mockImplementation((action) => action === "install-browser"
      ? { ok: false, reason }
      : { ok: true });
    const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
    try {
      const { runInteractiveUpdate } = await import("../src/update.js");

      await expect(runInteractiveUpdate("1.1.0", false)).resolves.toMatchObject({
        exitCode: 1,
        appliedUpdates: false,
        syncRequired: false,
      });
      expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual([
        "update",
        "install-browser",
      ]);
      expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(remedy));
    } finally {
      if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", originalTty);
    }
  });

  it("short-circuits a global-bin failure and gives the update remedy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "1.1.0" }))));
    mocks.executePlaywrightToolAction.mockReturnValue({ ok: false, reason: "pnpm-global-bin" });
    const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
    try {
      const { runInteractiveUpdate } = await import("../src/update.js");

      await expect(runInteractiveUpdate("1.1.0", false)).resolves.toMatchObject({
        exitCode: 1,
        appliedUpdates: false,
        syncRequired: false,
      });
      expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual(["update"]);
      expect(mocks.prompts.log.error).toHaveBeenCalledWith(
        expect.stringMatching(/pnpm setup.*jorgex-stack update/i),
      );
    } finally {
      if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stdout, "isTTY", originalTty);
    }
  });
});
