import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaywrightToolActionResult } from "../src/lib/external-tools.js";

// Previously observed Playwright release shared by this file's update tests.
// Fixture, never a version selector: the update flow must verify the latest
// provider candidate instead of trusting it.
const PREVIOUS_OBSERVED = {
  version: "9.9.8",
  integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
};

// Unconditional test guard: no save may reach the real HOME. Every
// savePlaywrightCliPreference call must target a strict child of the
// currently active fake HOME before the real implementation runs.
const guard = vi.hoisted(() => ({ allowedHome: null as string | null }));

const mocks = vi.hoisted(() => ({
  executePlaywrightToolAction: vi.fn<(action: string, ...rest: unknown[]) => PlaywrightToolActionResult>(() => ({ ok: true })),
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
  const pathMod = await import("node:path");
  function assertSandboxed(file: string): void {
    const allowed = guard.allowedHome;
    if (allowed === null) {
      throw new Error(`test guard: savePlaywrightCliPreference blocked outside sandbox (no allowedHome) for ${file}`);
    }
    const normalizedFile = pathMod.resolve(file);
    const normalizedHome = pathMod.resolve(allowed);
    const relative = pathMod.relative(normalizedHome, normalizedFile);
    const isStrictChild = relative !== ""
      && relative !== ".."
      && !relative.startsWith(`..${pathMod.sep}`)
      && !pathMod.isAbsolute(relative);
    if (!isStrictChild) {
      throw new Error(`test guard: savePlaywrightCliPreference blocked outside sandbox: ${file} not under ${allowed}`);
    }
  }
  return {
    ...actual,
    loadPlaywrightCliPreference: () => true,
    loadPlaywrightCliObservation: () => ({ ...PREVIOUS_OBSERVED }),
    savePlaywrightCliPreference: (...args: Parameters<typeof actual.savePlaywrightCliPreference>) => {
      assertSandboxed(args[0]);
      return actual.savePlaywrightCliPreference(...args);
    },
  };
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

function isStrictChild(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  guard.allowedHome = path.resolve(homeDir);
  try {
    vi.resetModules();
    return await run();
  } finally {
    guard.allowedHome = null;
    homedirSpy.mockRestore();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    vi.resetModules();
    // Temp root cleanup belongs to the caller (rmSync after readback);
    // this finally only restores HOME/spy/guard/module registry.
  }
}

function withTty<T>(run: () => Promise<T>): Promise<T> {
  const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
  return run().finally(() => {
    if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", originalTty);
  });
}

// Synthetic test-only latest release for sandboxed update flows. The exact
// version/URL/SRI travel together from the stubbed registry; the update must
// verify them before touching global pnpm, then persist the observed 9.9.10
// only after package and browser both succeed. Fixture, never a selector.
const SANDBOX_VERSION = "9.9.10";
const SANDBOX_TARBALL = "https://registry.npmjs.org/@playwright/cli/-/cli-9.9.10.tgz";
const SANDBOX_BYTES = Buffer.from("synthetic-playwright-cli-tarball-9.9.10\n");
const SANDBOX_INTEGRITY = `sha512-${createHash("sha512").update(SANDBOX_BYTES).digest("base64")}`;
const SANDBOX_CANDIDATE = {
  version: SANDBOX_VERSION,
  tarballUrl: SANDBOX_TARBALL,
  integrity: SANDBOX_INTEGRITY,
};
const SANDBOX_METADATA_URL = "https://registry.npmjs.org/@playwright/cli";

function sandboxPackument(): unknown {
  return {
    name: "@playwright/cli",
    "dist-tags": { latest: SANDBOX_VERSION },
    versions: {
      [SANDBOX_VERSION]: {
        name: "@playwright/cli",
        version: SANDBOX_VERSION,
        dist: { tarball: SANDBOX_TARBALL, integrity: SANDBOX_INTEGRITY },
      },
    },
  };
}

function stubSandboxFetch(events: string[], tarballBytes: Buffer): void {
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    events.push(`fetch ${url}`);
    if (url === SANDBOX_TARBALL) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(tarballBytes.slice());
          controller.close();
        },
      });
      const tarball = new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
      Object.defineProperty(tarball, "url", { value: url });
      return tarball;
    }
    if (url.includes("jorgex-stack")) {
      return new Response(JSON.stringify({ version: "1.1.0" }));
    }
    if (url === SANDBOX_METADATA_URL) {
      const metadata = new Response(JSON.stringify(sandboxPackument()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      Object.defineProperty(metadata, "url", { value: url });
      return metadata;
    }
    return new Response("not found", { status: 404 });
  };
  vi.stubGlobal("fetch", stub);
}

function observedCandidateOf(args: unknown[]): unknown {
  return args.find(
    (value) => typeof value === "object" && value !== null && (value as { version?: unknown }).version === SANDBOX_VERSION,
  );
}

afterEach(() => {
  mocks.executePlaywrightToolAction.mockClear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  guard.allowedHome = null;
  vi.resetModules();
});

describe("Playwright update", () => {
  it("reports unavailable provider discovery instead of calling an observed local version current", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-discovery-offline-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    try {
      await withTempHome(homeDir, async () => {
        vi.doMock("../src/lib/external-tools.js", async (importOriginal) => ({
          ...(await importOriginal<typeof import("../src/lib/external-tools.js")>()),
          detectPlaywrightCli: () => ({
            status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: PREVIOUS_OBSERVED.version,
          }),
        }));
        const { runInteractiveUpdate } = await import("../src/update.js");
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/@playwright/cli/latest")) return new Response("unavailable", { status: 503 });
          return new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });
        });
        try {
          await withTty(() => runInteractiveUpdate("1.1.0", false));
          expect(mocks.prompts.log.warn).toHaveBeenCalledWith(expect.stringContaining("no se pudo consultar npm"));
        } finally {
          vi.unstubAllGlobals();
          vi.doMock("../src/lib/external-tools.js", async (importOriginal) => ({
            ...(await importOriginal<typeof import("../src/lib/external-tools.js")>()),
            detectPlaywrightCli: () => ({
              status: "outdated", binPath: "C:/pnpm/playwright-cli.cmd", detectedVersion: "0.1.16",
            }),
          }));
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates the pinned package and browser without requiring a runtime sync", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-update-sandbox-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const inspectCalls: unknown[][] = [];
    let preferenceRaw: string | null = null;

    try {
      await withTempHome(homeDir, async () => {
        vi.doMock("../src/lib/playwright-capability.js", async (importOriginal) => {
          const actual = await importOriginal<typeof import("../src/lib/playwright-capability.js")>();
          return {
            ...actual,
            inspectPlaywrightCapability: (...args: unknown[]) => {
              inspectCalls.push(args);
              return {
                cli: { status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: SANDBOX_VERSION },
                browserCache: { status: "ready", path: "/isolated/browser" },
                browserVerified: true,
                effective: true,
              };
            },
          };
        });
        try {
          const { runInteractiveUpdate } = await import("../src/update.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { playwrightCliPreferenceFile } = await import("../src/lib/tool-preferences.js");
          const preferenceFile = playwrightCliPreferenceFile(dataDir());
          expect(isStrictChild(preferenceFile, homeDir)).toBe(true);
          stubSandboxFetch(events, SANDBOX_BYTES);
          mocks.executePlaywrightToolAction.mockImplementation((action: string) => {
            events.push(`pnpm ${action}`);
            return { ok: true };
          });
          try {
            await withTty(() => runInteractiveUpdate("1.1.0", false)).then((result) => {
              expect(result).toMatchObject({ exitCode: 0, appliedUpdates: true, syncRequired: false });
            });
          } finally {
            vi.unstubAllGlobals();
          }
          expect(mocks.prompts.multiselect).toHaveBeenCalledWith(
            expect.objectContaining({
              options: expect.arrayContaining([
                expect.objectContaining({
                  value: "playwright-cli",
                  hint: "pnpm add --global @playwright/cli (verificado)",
                }),
              ]),
            }),
          );
          expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual([
            "update",
            "install-browser",
          ]);
          // Readback inside the sandbox BEFORE rmSync(root).
          preferenceRaw = fs.readFileSync(preferenceFile, "utf8");
        } finally {
          vi.doUnmock("../src/lib/playwright-capability.js");
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const metaIdx = events.indexOf(`fetch ${SANDBOX_METADATA_URL}`);
    const tarballIdx = events.indexOf(`fetch ${SANDBOX_TARBALL}`);
    const firstPnpmIdx = events.findIndex((event) => event.startsWith("pnpm "));
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(tarballIdx).toBeGreaterThan(metaIdx);
    expect(firstPnpmIdx).toBeGreaterThan(tarballIdx);
    const calls = mocks.executePlaywrightToolAction.mock.calls;
    expect(calls.map((args) => observedCandidateOf(args))).toEqual([SANDBOX_CANDIDATE, SANDBOX_CANDIDATE]);
    expect(inspectCalls).toHaveLength(1);
    expect(inspectCalls[0]).toEqual([expect.objectContaining({ expectedVersion: SANDBOX_VERSION })]);
    expect(preferenceRaw).not.toBeNull();
    expect(preferenceRaw).toContain(SANDBOX_VERSION);
    expect(preferenceRaw).toContain(SANDBOX_INTEGRITY);
  });

  it.each([
    { reason: "action-failed", remedy: /install --playwright/i },
    { reason: "pnpm-command", remedy: /revisa su instalación, PATH y permisos.*jorgex-stack update/i },
  ] as const)("reports a browser-only $reason failure with its remedy", async ({ reason, remedy }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-update-failure-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    let preferenceExists: boolean | null = null;

    try {
      await withTempHome(homeDir, async () => {
        const { runInteractiveUpdate } = await import("../src/update.js");
        const { dataDir } = await import("../src/lib/paths.js");
        const { playwrightCliPreferenceFile } = await import("../src/lib/tool-preferences.js");
        const preferenceFile = playwrightCliPreferenceFile(dataDir());
        expect(isStrictChild(preferenceFile, homeDir)).toBe(true);
        stubSandboxFetch(events, SANDBOX_BYTES);
        mocks.executePlaywrightToolAction.mockImplementation((action) => {
          events.push(`pnpm ${action}`);
          return action === "install-browser" ? { ok: false, reason } : { ok: true };
        });
        try {
          await withTty(() => runInteractiveUpdate("1.1.0", false)).then((result) => {
            expect(result).toMatchObject({ exitCode: 1, appliedUpdates: false, syncRequired: false });
          });
          expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual([
            "update",
            "install-browser",
          ]);
          expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(remedy));
          // No persistence on failure: readback inside sandbox BEFORE rmSync.
          preferenceExists = fs.existsSync(preferenceFile);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(events).toContain(`fetch ${SANDBOX_TARBALL}`);
    expect(preferenceExists).toBe(false);
    const calls = mocks.executePlaywrightToolAction.mock.calls;
    expect(calls.map((args) => observedCandidateOf(args))).toEqual([SANDBOX_CANDIDATE, SANDBOX_CANDIDATE]);
  });

  it("short-circuits a global-bin failure and gives the update remedy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-global-bin-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    let preferenceExists: boolean | null = null;

    try {
      await withTempHome(homeDir, async () => {
        const { runInteractiveUpdate } = await import("../src/update.js");
        const { dataDir } = await import("../src/lib/paths.js");
        const { playwrightCliPreferenceFile } = await import("../src/lib/tool-preferences.js");
        const preferenceFile = playwrightCliPreferenceFile(dataDir());
        expect(isStrictChild(preferenceFile, homeDir)).toBe(true);
        stubSandboxFetch(events, SANDBOX_BYTES);
        mocks.executePlaywrightToolAction.mockImplementation((action: string) => {
          events.push(`pnpm ${action}`);
          return { ok: false, reason: "pnpm-global-bin" };
        });
        try {
          await withTty(() => runInteractiveUpdate("1.1.0", false)).then((result) => {
            expect(result).toMatchObject({ exitCode: 1, appliedUpdates: false, syncRequired: false });
          });
          expect(mocks.executePlaywrightToolAction.mock.calls.map(([action]) => action)).toEqual(["update"]);
          expect(mocks.prompts.log.error).toHaveBeenCalledWith(
            expect.stringMatching(/pnpm setup.*jorgex-stack update/i),
          );
          preferenceExists = fs.existsSync(preferenceFile);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(events).toContain(`fetch ${SANDBOX_TARBALL}`);
    expect(preferenceExists).toBe(false);
  });
});

describe("Playwright verified update [T14-RED]", () => {
  // Synthetic test-only latest release for the update flow. The exact
  // version/URL/SRI travel together from the stubbed registry; the update
  // must verify them before touching global pnpm, then persist the observed
  // 9.9.10 only after package and browser both succeed.
  const LATEST_VERSION = "9.9.10";
  const LATEST_TARBALL = "https://registry.npmjs.org/@playwright/cli/-/cli-9.9.10.tgz";
  const LATEST_BYTES = Buffer.from("synthetic-playwright-cli-tarball-9.9.10\n");
  const LATEST_INTEGRITY = `sha512-${createHash("sha512").update(LATEST_BYTES).digest("base64")}`;
  const LATEST_CANDIDATE = {
    version: LATEST_VERSION,
    tarballUrl: LATEST_TARBALL,
    integrity: LATEST_INTEGRITY,
  };
  const METADATA_URL = "https://registry.npmjs.org/@playwright/cli";

  function latestPackument(): unknown {
    return {
      name: "@playwright/cli",
      "dist-tags": { latest: LATEST_VERSION },
      versions: {
        [LATEST_VERSION]: {
          name: "@playwright/cli",
          version: LATEST_VERSION,
          dist: { tarball: LATEST_TARBALL, integrity: LATEST_INTEGRITY },
        },
      },
    };
  }

  function stubUpdateFetch(events: string[], tarballBytes: Buffer): void {
    const stub = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      events.push(`fetch ${url}`);
      if (url === LATEST_TARBALL) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(tarballBytes.slice());
            controller.close();
          },
        });
        const tarball = new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
        Object.defineProperty(tarball, "url", { value: url });
        return tarball;
      }
      if (url.includes("jorgex-stack")) {
        return new Response(JSON.stringify({ version: "1.1.0" }));
      }
      if (url === METADATA_URL) {
        const metadata = new Response(JSON.stringify(latestPackument()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        Object.defineProperty(metadata, "url", { value: url });
        return metadata;
      }
      return new Response("not found", { status: 404 });
    };
    vi.stubGlobal("fetch", stub);
  }

  it("verifies the latest release before global pnpm and persists the observed candidate only after both succeed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-verified-update-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    const inspectCalls: unknown[][] = [];
    let preferenceRaw: string | null = null;

    try {
      await withTempHome(homeDir, async () => {
        vi.doMock("../src/lib/playwright-capability.js", async (importOriginal) => {
          const actual = await importOriginal<typeof import("../src/lib/playwright-capability.js")>();
          return {
            ...actual,
            inspectPlaywrightCapability: (...args: unknown[]) => {
              inspectCalls.push(args);
              return {
                cli: { status: "current", binPath: "/isolated/bin/playwright-cli", detectedVersion: LATEST_VERSION },
                browserCache: { status: "ready", path: "/isolated/browser" },
                browserVerified: true,
                effective: true,
              };
            },
          };
        });
        try {
          const { runInteractiveUpdate } = await import("../src/update.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { playwrightCliPreferenceFile } = await import("../src/lib/tool-preferences.js");
          const preferenceFile = playwrightCliPreferenceFile(dataDir());
          expect(isStrictChild(preferenceFile, homeDir)).toBe(true);
          stubUpdateFetch(events, LATEST_BYTES);
          mocks.executePlaywrightToolAction.mockImplementation((action: string) => {
            events.push(`pnpm ${action}`);
            return { ok: true };
          });
          try {
            await withTty(() => runInteractiveUpdate("1.1.0", false)).then((result) => {
              expect(result).toMatchObject({ exitCode: 0, appliedUpdates: true });
            });
          } finally {
            vi.unstubAllGlobals();
          }
          // Readback inside the sandbox BEFORE rmSync(root).
          preferenceRaw = fs.readFileSync(preferenceFile, "utf8");
        } finally {
          vi.doUnmock("../src/lib/playwright-capability.js");
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const metaIdx = events.indexOf(`fetch ${METADATA_URL}`);
    const tarballIdx = events.indexOf(`fetch ${LATEST_TARBALL}`);
    const firstPnpmIdx = events.findIndex((event) => event.startsWith("pnpm "));
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(tarballIdx).toBeGreaterThan(metaIdx);
    expect(firstPnpmIdx).toBeGreaterThan(tarballIdx);
    const calls = mocks.executePlaywrightToolAction.mock.calls;
    expect(calls.map(([action]) => action)).toEqual(["update", "install-browser"]);
    expect(calls.map((args) => observedCandidateOf(args))).toEqual([LATEST_CANDIDATE, LATEST_CANDIDATE]);
    expect(inspectCalls).toHaveLength(1);
    expect(inspectCalls[0]).toEqual([expect.objectContaining({ expectedVersion: LATEST_VERSION })]);
    expect(preferenceRaw).not.toBeNull();
    expect(preferenceRaw).toContain(LATEST_VERSION);
    expect(preferenceRaw).toContain(LATEST_INTEGRITY);
  });

  it("blocks before global pnpm and preference when the tarball integrity mismatches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-update-sri-mismatch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const events: string[] = [];
    let preferenceExists: boolean | null = null;

    try {
      await withTempHome(homeDir, async () => {
        try {
          const { runInteractiveUpdate } = await import("../src/update.js");
          const { dataDir } = await import("../src/lib/paths.js");
          const { playwrightCliPreferenceFile } = await import("../src/lib/tool-preferences.js");
          const preferenceFile = playwrightCliPreferenceFile(dataDir());
          expect(isStrictChild(preferenceFile, homeDir)).toBe(true);
          stubUpdateFetch(events, Buffer.from("tampered-tarball-bytes\n"));
          mocks.executePlaywrightToolAction.mockImplementation((action: string) => {
            events.push(`pnpm ${action}`);
            return { ok: true };
          });
          try {
            const outcome = await withTty(() => runInteractiveUpdate("1.1.0", false)).then(
              (result: { exitCode: number }) => ({ code: result.exitCode as number | "threw" }),
              () => ({ code: "threw" as const }),
            );

            expect(outcome.code === "threw" || outcome.code !== 0).toBe(true);
            expect(events.filter((event) => event.startsWith("pnpm "))).toEqual([]);
            // Wrong SRI must not write: check inside sandbox BEFORE rmSync.
            preferenceExists = fs.existsSync(preferenceFile);
            expect(preferenceExists).toBe(false);
          } finally {
            vi.unstubAllGlobals();
          }
        } finally {
          vi.doUnmock("../src/lib/playwright-capability.js");
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(events).toContain(`fetch ${LATEST_TARBALL}`);
    expect(preferenceExists).toBe(false);
  });

  it("keeps update --check discovery-only: never fetches the tarball nor installs", async () => {
    const events: string[] = [];
    stubUpdateFetch(events, LATEST_BYTES);
    try {
      const { runUpdateCheck } = await import("../src/update.js");
      await runUpdateCheck("1.1.0", false);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(events.filter((event) => event === `fetch ${LATEST_TARBALL}`)).toEqual([]);
    expect(mocks.executePlaywrightToolAction).not.toHaveBeenCalled();
  });
});
