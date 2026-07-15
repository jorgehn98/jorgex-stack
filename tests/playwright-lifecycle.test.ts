import { describe, expect, it } from "vitest";

type PlaywrightToolAction = "install" | "install-browser" | "remove";

interface PlaywrightToolPlan {
  actions: PlaywrightToolAction[];
  persistEnabledOnSuccess?: boolean;
}

interface PlaywrightToolPlanDeps {
  run: (action: Exclude<PlaywrightToolAction, "remove">) => Promise<boolean>;
  persistEnabled: (enabled: boolean) => void;
}

type PlaywrightToolFailure = Exclude<PlaywrightToolAction, "remove"> | "persist";

interface PlaywrightToolConsent {
  command: "install" | "sync";
  interactive: boolean;
  yes: boolean;
  targetDir: boolean;
  explicitToolSelection: boolean;
  confirmed: boolean;
}

interface PlaywrightDoctorState {
  enabled: boolean | undefined;
  cli: { status: "absent" | "broken" | "current" | "outdated" };
  browserReady: boolean;
  browserCache?: { status: "ready" | "missing" | "unreadable"; path: string; errorCode?: string };
}

async function resolveToolPlan(input: PlaywrightToolConsent): Promise<PlaywrightToolPlan> {
  const mod = await import("../src/install.js") as {
    resolvePlaywrightToolPlan?: (input: PlaywrightToolConsent) => PlaywrightToolPlan;
  };

  expect(mod.resolvePlaywrightToolPlan).toBeTypeOf("function");
  return mod.resolvePlaywrightToolPlan!(input);
}

async function runToolPlan(
  plan: PlaywrightToolPlan,
  deps: PlaywrightToolPlanDeps,
): Promise<{ ok: boolean; failedAction?: PlaywrightToolFailure }> {
  const mod = await import("../src/install.js") as {
    runPlaywrightToolPlan?: (
      plan: PlaywrightToolPlan,
      deps: PlaywrightToolPlanDeps,
    ) => Promise<{ ok: boolean; failedAction?: PlaywrightToolFailure }>;
  };

  expect(mod.runPlaywrightToolPlan).toBeTypeOf("function");
  return mod.runPlaywrightToolPlan!(plan, deps);
}

async function doctorState(input: PlaywrightDoctorState): Promise<{
  status: string;
  missing?: string;
  path?: string;
  errorCode?: string;
}> {
  const mod = await import("../src/doctor.js") as {
    resolvePlaywrightDoctorState?: (input: PlaywrightDoctorState) => {
      status: string;
      missing?: string;
      path?: string;
      errorCode?: string;
    };
  };

  expect(mod.resolvePlaywrightDoctorState).toBeTypeOf("function");
  return mod.resolvePlaywrightDoctorState!(input);
}

async function updateSyncRequired(updated: string[]): Promise<boolean> {
  const mod = await import("../src/update.js") as {
    resolveUpdateSyncRequired?: (updated: string[]) => boolean;
  };

  expect(mod.resolveUpdateSyncRequired).toBeTypeOf("function");
  return mod.resolveUpdateSyncRequired!(updated);
}

async function uninstallToolPlan(removePackage: boolean): Promise<{ actions: PlaywrightToolAction[]; preserveBrowserData: boolean }> {
  const mod = await import("../src/uninstall.js") as {
    resolvePlaywrightUninstallPlan?: (input: { removePackage: boolean }) => {
      actions: PlaywrightToolAction[];
      preserveBrowserData: boolean;
    };
  };

  expect(mod.resolvePlaywrightUninstallPlan).toBeTypeOf("function");
  return mod.resolvePlaywrightUninstallPlan!({ removePackage });
}

describe("Playwright lifecycle contracts", () => {
  it("resolves the interactive, --yes, non-TTY, target-dir, and sync consent matrix", async () => {
    const cases = [
      {
        input: { command: "install", interactive: true, yes: false, targetDir: false, explicitToolSelection: false, confirmed: true },
        expected: { actions: ["install", "install-browser"], persistEnabledOnSuccess: true },
      },
      {
        input: { command: "install", interactive: true, yes: false, targetDir: false, explicitToolSelection: false, confirmed: false },
        expected: { actions: [] },
      },
      {
        input: { command: "install", interactive: false, yes: false, targetDir: false, explicitToolSelection: false, confirmed: false },
        expected: { actions: [] },
      },
      {
        input: { command: "install", interactive: false, yes: true, targetDir: false, explicitToolSelection: false, confirmed: false },
        expected: { actions: [] },
      },
      {
        input: { command: "install", interactive: false, yes: true, targetDir: false, explicitToolSelection: true, confirmed: false },
        expected: { actions: ["install", "install-browser"], persistEnabledOnSuccess: true },
      },
      {
        input: { command: "install", interactive: true, yes: false, targetDir: true, explicitToolSelection: true, confirmed: true },
        expected: { actions: [] },
      },
      {
        input: { command: "sync", interactive: false, yes: true, targetDir: false, explicitToolSelection: true, confirmed: false },
        expected: { actions: [] },
      },
    ] as const;

    await expect(Promise.all(cases.map(({ input }) => resolveToolPlan(input)))).resolves.toEqual(
      cases.map(({ expected }) => expect.objectContaining(expected)),
    );
  });

  it("persists enabled only after both injected global actions succeed", async () => {
    const plan: PlaywrightToolPlan = { actions: ["install", "install-browser"], persistEnabledOnSuccess: true };
    const successfulActions: PlaywrightToolAction[] = [];
    const persistedOnSuccess: boolean[] = [];

    await expect(runToolPlan(plan, {
      run: async (action) => {
        successfulActions.push(action);
        return true;
      },
      persistEnabled: (enabled) => persistedOnSuccess.push(enabled),
    })).resolves.toEqual({ ok: true });

    expect(successfulActions).toEqual(["install", "install-browser"]);
    expect(persistedOnSuccess).toEqual([true]);

    const persistedOnFailure: boolean[] = [];
    const failedActions: PlaywrightToolAction[] = [];

    await expect(runToolPlan(plan, {
      run: async (action) => {
        failedActions.push(action);
        return action !== "install-browser";
      },
      persistEnabled: (enabled) => persistedOnFailure.push(enabled),
    })).resolves.toEqual({ ok: false, failedAction: "install-browser" });

    expect(failedActions).toEqual(["install", "install-browser"]);
    expect(persistedOnFailure).toEqual([]);
  });

  it.each([
    {
      name: "the package action",
      failedAction: "install",
      run: async (action: Exclude<PlaywrightToolAction, "remove">) => action !== "install",
      persistEnabled: () => undefined,
    },
    {
      name: "the browser action",
      failedAction: "install-browser",
      run: async (action: Exclude<PlaywrightToolAction, "remove">) => action !== "install-browser",
      persistEnabled: () => undefined,
    },
    {
      name: "preference persistence",
      failedAction: "persist",
      run: async () => true,
      persistEnabled: () => { throw new Error("preference write failed"); },
    },
  ] as const)("reports failedAction when $name fails", async ({ failedAction, run, persistEnabled }) => {
    const plan: PlaywrightToolPlan = { actions: ["install", "install-browser"], persistEnabledOnSuccess: true };

    await expect(runToolPlan(plan, { run, persistEnabled })).resolves.toEqual({ ok: false, failedAction });
  });

  it("reports the disabled, healthy, missing, broken, and browser-not-ready doctor states", async () => {
    const cases = [
      { input: { enabled: false, cli: { status: "current" }, browserReady: true }, expected: { status: "disabled" } },
      { input: { enabled: true, cli: { status: "current" }, browserReady: true }, expected: { status: "healthy" } },
      { input: { enabled: true, cli: { status: "absent" }, browserReady: true }, expected: { status: "missing", missing: "package" } },
      { input: { enabled: true, cli: { status: "broken" }, browserReady: true }, expected: { status: "broken" } },
      { input: { enabled: true, cli: { status: "current" }, browserReady: false }, expected: { status: "missing", missing: "browser" } },
      {
        input: {
          enabled: true,
          cli: { status: "current" },
          browserReady: true,
          browserCache: {
            status: "unreadable",
            path: "C:/Users/test/AppData/Local/ms-playwright",
            errorCode: "EACCES",
          },
        },
        expected: {
          status: "unreadable",
          path: "C:/Users/test/AppData/Local/ms-playwright",
          errorCode: "EACCES",
        },
      },
    ] as const;

    await expect(Promise.all(cases.map(({ input }) => doctorState(input)))).resolves.toEqual(
      cases.map(({ expected }) => expect.objectContaining(expected)),
    );
  });

  it("distinguishes binary-only updates from stack and skill changes that require sync", async () => {
    const cases = [
      { updated: ["playwright-cli"], expected: false },
      { updated: ["engram"], expected: false },
      { updated: ["playwright-cli", "engram"], expected: false },
      { updated: ["stack"], expected: true },
      { updated: ["skill"], expected: true },
    ];

    await expect(Promise.all(cases.map(({ updated }) => updateSyncRequired(updated)))).resolves.toEqual(
      cases.map(({ expected }) => expected),
    );
  });

  it("uninstall preserves browser data and removes the package only when explicit", async () => {
    await expect(Promise.all([uninstallToolPlan(false), uninstallToolPlan(true)])).resolves.toEqual([
      { actions: [], preserveBrowserData: true },
      { actions: ["remove"], preserveBrowserData: true },
    ]);
  });
});
