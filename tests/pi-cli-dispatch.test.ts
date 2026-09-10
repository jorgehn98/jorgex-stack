import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const prompts = {
    confirm: vi.fn().mockResolvedValue(false),
    multiselect: vi.fn().mockResolvedValue([]),
    isCancel: vi.fn().mockReturnValue(false),
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
    },
  };
  return {
    prompts,
    runInstall: vi.fn().mockResolvedValue(0),
    runUninstall: vi.fn().mockResolvedValue(0),
    runDoctor: vi.fn().mockResolvedValue(0),
    runUpdateCheck: vi.fn().mockResolvedValue(0),
    runInteractiveUpdate: vi.fn().mockResolvedValue({ exitCode: 0, appliedUpdates: false, syncRequired: false }),
    updateEngram: vi.fn().mockResolvedValue(true),
    runModelsPicker: vi.fn().mockResolvedValue(0),
    detectPiRuntime: vi.fn().mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/opt/pi/bin/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    }),
    hasManagedPiRuntime: vi.fn().mockReturnValue(false),
    resolvePiEngramBin: vi.fn().mockReturnValue("/isolated/bin/engram"),
    resolvePiEngramRequirement: vi.fn(),
    installMissingEngram: vi.fn().mockResolvedValue({ ok: true, bin: "/isolated/bin/engram" }),
    // Keep the package-only boundary stubbed; dispatch assertions exercise the
    // managed lifecycle instead.
    runPiRuntimeSystem: vi.fn().mockReturnValue({ kind: "healthy" }),
    runManagedPiSystem: vi.fn().mockResolvedValue({ kind: "healthy" }),
  };
});

vi.mock("@clack/prompts", () => ({
  confirm: mocks.prompts.confirm,
  isCancel: mocks.prompts.isCancel,
  log: mocks.prompts.log,
  multiselect: mocks.prompts.multiselect,
  intro: mocks.prompts.intro,
  outro: mocks.prompts.outro,
}));

vi.mock("../src/lib/engram-install.js", () => ({
  installMissingEngram: mocks.installMissingEngram,
}));

vi.mock("../src/install.js", async () => {
  const actual = await vi.importActual<typeof import("../src/install.js")>("../src/install.js");
  return { ...actual, runInstall: mocks.runInstall };
});

vi.mock("../src/uninstall.js", async () => {
  const actual = await vi.importActual<typeof import("../src/uninstall.js")>("../src/uninstall.js");
  return { ...actual, runUninstall: mocks.runUninstall };
});

vi.mock("../src/doctor.js", async () => {
  const actual = await vi.importActual<typeof import("../src/doctor.js")>("../src/doctor.js");
  return { ...actual, runDoctor: mocks.runDoctor };
});

vi.mock("../src/update.js", async () => {
  const actual = await vi.importActual<typeof import("../src/update.js")>("../src/update.js");
  return {
    ...actual,
    runUpdateCheck: mocks.runUpdateCheck,
    runInteractiveUpdate: mocks.runInteractiveUpdate,
    updateEngram: mocks.updateEngram,
  };
});

vi.mock("../src/models-picker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/models-picker.js")>("../src/models-picker.js");
  return { ...actual, runModelsPicker: mocks.runModelsPicker };
});

vi.mock("../src/lib/pi-runtime.js", () => ({
  detectPiRuntime: mocks.detectPiRuntime,
  hasManagedPiRuntime: mocks.hasManagedPiRuntime,
  resolvePiEngramBin: mocks.resolvePiEngramBin,
  resolvePiEngramRequirement: mocks.resolvePiEngramRequirement,
  runPiRuntimeSystem: mocks.runPiRuntimeSystem,
}));

vi.mock("../src/lib/pi-managed-runtime.js", () => ({
  runManagedPiSystem: mocks.runManagedPiSystem,
}));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "src", "cli.ts");

async function runCli(args: string[], homeDir: string): Promise<typeof process.exitCode> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let observedExitCode: typeof process.exitCode = undefined;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.exitCode = undefined;
  try {
    vi.resetModules();
    process.argv = [process.execPath, CLI_PATH, ...args];
    await import("../src/cli.js");
    observedExitCode = process.exitCode;
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
  return observedExitCode;
}

function writeCorruptBrowserPreference(homeDir: string): string {
  const preferenceFile = path.join(homeDir, ".jorgex-stack", "playwright-cli.json");
  fs.mkdirSync(path.dirname(preferenceFile), { recursive: true });
  fs.writeFileSync(preferenceFile, "{not-json\n");
  return preferenceFile;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.installMissingEngram.mockReset().mockResolvedValue({ ok: true, bin: "/isolated/bin/engram" });
  mocks.resolvePiEngramBin.mockReset().mockReturnValue("/isolated/bin/engram");
});

describe("CLI Pi package-runtime dispatch", () => {
  it("splits a mixed install so only file runtimes reach the adapter pipeline and Pi reaches its package lifecycle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-mixed-"));

    const exitCode = await runCli(["install", "--agents", "codex,pi", "--mode", "human", "--yes"], home);

    expect(exitCode).toBe(0);
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({ runtimes: ["codex"] }));
    expect(mocks.runInstall).not.toHaveBeenCalledWith(expect.objectContaining({ runtimes: expect.arrayContaining(["pi"]) }));
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith({
      operation: "install",
      targetDir: undefined,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    });
  });

  it("keeps Pi-only target-dir model selection out of adapter and model-map flows", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-target-"));
    const targetDir = path.join(home, "target");

    const exitCode = await runCli(["models", "--agents", "pi", "--target-dir", targetDir, "--yes"], home);

    expect(exitCode).toBe(0);
    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runModelsPicker).not.toHaveBeenCalled();
    expect(mocks.resolvePiEngramBin).toHaveBeenCalledWith(targetDir);
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith({
      operation: "models",
      targetDir,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    });
  });

  it("keeps Pi-only target-dir doctor out of the global Stack doctor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-doctor-"));
    const targetDir = path.join(home, "target");

    const exitCode = await runCli(["doctor", "--agents", "pi", "--target-dir", targetDir], home);

    expect(exitCode).toBe(0);
    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "doctor", targetDir }));
  });

  it("keeps Pi-only update and update --check out of the global Stack updater", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-update-"));

    expect(await runCli(["update", "--agents", "pi", "--yes"], home)).toBe(0);
    expect(mocks.runInteractiveUpdate).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "update" }));

    vi.clearAllMocks();
    mocks.detectPiRuntime.mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/opt/pi/bin/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    });
    mocks.resolvePiEngramBin.mockReturnValue("/isolated/bin/engram");
    mocks.runManagedPiSystem.mockResolvedValue({ kind: "healthy" });

    expect(await runCli(["update", "--check", "--agents", "pi"], home)).toBe(0);
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({ operation: "doctor" }));
  });

  it("does not select Pi implicitly from the CLI alone when Stack owns no Pi package state", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-unmanaged-"));

    expect(await runCli(["doctor"], home)).toBe(0);
    expect(mocks.runDoctor).toHaveBeenCalledOnce();
    expect(mocks.hasManagedPiRuntime).toHaveBeenCalledWith(undefined);
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });

  it("includes a detected Pi runtime in the explicit first Stack install even before a receipt exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-first-install-"));
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(home, "empty-path");

    try {
      expect(await runCli(["install", "--mode", "human", "--yes"], home)).toBe(0);
      expect(mocks.hasManagedPiRuntime).not.toHaveBeenCalled();
      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith({
        operation: "install",
        targetDir: undefined,
        detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
        engramBin: "/isolated/bin/engram",
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("installs the opted-in Playwright tool before the Pi-only managed install without using the real home", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-playwright-"));

    expect(await runCli(["install", "--playwright", "--agents", "pi", "--yes"], home)).toBe(0);

    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      runtimes: [],
      targetDir: undefined,
      playwrightToolConsent: {
        command: "install",
        interactive: false,
        yes: true,
        targetDir: false,
        explicitToolSelection: true,
        confirmed: false,
      },
    }));
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith({
      operation: "install",
      targetDir: undefined,
      detected: { executable: "/opt/pi/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    });
    expect(mocks.runInstall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runManagedPiSystem.mock.invocationCallOrder[0]!,
    );
  });

  it("resolves the host Engram before configuring a mixed install", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-engram-order-"));
    let engramAvailable = false;
    mocks.resolvePiEngramBin.mockImplementation(() => engramAvailable ? "/isolated/bin/engram" : null);
    mocks.installMissingEngram.mockImplementation(async () => {
      engramAvailable = true;
      return { ok: true, bin: "/isolated/bin/engram" };
    });

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex,pi",
      "--mode",
      "human",
      "--yes",
      "--engram",
    ], home);

    expect(exitCode).toBe(0);
    expect(mocks.installMissingEngram).toHaveBeenCalledOnce();
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({ runtimes: ["codex"] }));
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
      operation: "install",
      engramBin: "/isolated/bin/engram",
    }));
    expect(mocks.installMissingEngram.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runInstall.mock.invocationCallOrder[0]!,
    );
    expect(mocks.installMissingEngram.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runManagedPiSystem.mock.invocationCallOrder[0]!,
    );
  });

  it("aborts before configuring runtimes when host Engram installation fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-engram-failure-"));
    mocks.resolvePiEngramBin.mockReturnValue(null);
    mocks.installMissingEngram.mockResolvedValue({ ok: false, reason: "download-failed" });

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex,pi",
      "--mode",
      "human",
      "--yes",
      "--engram",
    ], home);

    expect(exitCode).toBe(1);
    expect(mocks.installMissingEngram).toHaveBeenCalledOnce();
    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });

  it.each([
    ["dry-run", ["--dry-run"]],
    ["target-dir", ["--target-dir", "TARGET"]],
  ] as const)("does not download host Engram in %s", async (name, extraArgs) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `jx-pi-cli-engram-${name}-`));
    const targetArgs = extraArgs[0] === "--target-dir"
      ? [extraArgs[0], path.join(home, "target")]
      : extraArgs;

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex",
      "--mode",
      "human",
      "--yes",
      "--engram",
      ...targetArgs,
    ], home);

    expect(exitCode).toBe(0);
    expect(mocks.installMissingEngram).not.toHaveBeenCalled();
    if (name === "target-dir") {
      expect(mocks.resolvePiEngramBin.mock.calls.some(([root]) => root === undefined)).toBe(false);
    }
  });

  it("passes the existing host Engram to runInstall during dry-run without downloading", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-engram-dry-run-bin-"));
    const existingEngram = "/isolated/bin/engram";
    mocks.resolvePiEngramBin.mockReturnValue(existingEngram);

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex",
      "--mode",
      "human",
      "--yes",
      "--engram",
      "--dry-run",
    ], home);

    expect(exitCode).toBe(0);
    expect(mocks.installMissingEngram).not.toHaveBeenCalled();
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      runtimes: ["codex"],
      dryRun: true,
      engramBin: existingEngram,
    }));
  });

  it("preserves exit code 1 for an invalid mode after the final summary", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-invalid-mode-"));

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex",
      "--mode",
      "invalid",
      "--yes",
    ], home);

    expect(exitCode).toBe(1);
    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.prompts.outro).toHaveBeenCalledWith(expect.stringMatching(/errores/i));
  });

  it("does not treat --yes as consent to download missing Engram", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-engram-no-consent-"));
    mocks.resolvePiEngramBin.mockReturnValue(null);

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex",
      "--mode",
      "human",
      "--yes",
    ], home);

    expect(exitCode).toBe(1);
    expect(mocks.installMissingEngram).not.toHaveBeenCalled();
    expect(mocks.runInstall).not.toHaveBeenCalled();
  });

  it("resolves host Engram for a file-only install before runInstall", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-engram-file-only-"));
    let engramAvailable = false;
    mocks.resolvePiEngramBin.mockImplementation(() => engramAvailable ? "/isolated/bin/engram" : null);
    mocks.installMissingEngram.mockImplementation(async () => {
      engramAvailable = true;
      return { ok: true, bin: "/isolated/bin/engram" };
    });

    const exitCode = await runCli([
      "install",
      "--agents",
      "codex",
      "--mode",
      "human",
      "--yes",
      "--engram",
    ], home);

    expect(exitCode).toBe(0);
    expect(mocks.installMissingEngram).toHaveBeenCalledOnce();
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      runtimes: ["codex"],
      engramBin: "/isolated/bin/engram",
    }));
    expect(mocks.installMissingEngram.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runInstall.mock.invocationCallOrder[0]!,
    );
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });

  it("emits the final summary after Pi completes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-summary-order-"));

    const exitCode = await runCli(["install", "--agents", "pi", "--yes"], home);

    expect(exitCode).toBe(0);
    expect(mocks.prompts.outro).toHaveBeenCalledOnce();
    expect(mocks.prompts.outro.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.runManagedPiSystem.mock.invocationCallOrder[0]!,
    );
  });

  it("does not run the Pi lifecycle when Pi-only Playwright setup fails", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-playwright-failure-"));
    mocks.runInstall.mockResolvedValueOnce(1);

    const exitCode = await runCli(["install", "--playwright", "--agents", "pi", "--yes"], home);

    expect(exitCode).toBe(1);
    expect(mocks.runInstall).toHaveBeenCalledOnce();
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });

  it("keeps a Pi-only target-dir Playwright install out of the global installer and real browser preferences", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-target-playwright-"));
    const targetDir = path.join(home, "target");
    writeCorruptBrowserPreference(home);

    const exitCode = await runCli(["install", "--playwright", "--agents", "pi", "--target-dir", targetDir, "--yes"], home);

    expect(exitCode).toBe(0);
    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
      operation: "install",
      targetDir,
    }));
  });

  it.each(["install", "sync", "update", "uninstall"] as const)(
    "blocks Pi-only real %s before the managed lifecycle when browser preferences are corrupt",
    async (command) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `jx-pi-cli-corrupt-preference-${command}-`));
      writeCorruptBrowserPreference(home);

      const exitCode = await runCli([command, "--agents", "pi", "--yes"], home);

      expect({
        exitCode,
        managedLifecycleCalls: mocks.runManagedPiSystem.mock.calls.length,
      }).toEqual({
        exitCode: 1,
        managedLifecycleCalls: 0,
      });
    },
  );

  it("reports corrupt real browser preferences through Pi-only doctor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-doctor-corrupt-preference-"));
    const preferenceFile = writeCorruptBrowserPreference(home);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["doctor", "--agents", "pi"], home);

      expect({
        exitCode,
        reportsPreference: error.mock.calls.some(([message]) => String(message).includes(preferenceFile)),
      }).toEqual({
        exitCode: 1,
        reportsPreference: true,
      });
    } finally {
      error.mockRestore();
    }
  });

  it("reports every blocked Pi operation with its reason, paths, and remedy", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-cli-blocked-paths-"));
    const receipt = path.join(home, ".jorgex-stack", "pi-projection-receipt.json");
    const remedy = "Revisa los permisos del receipt antes de reintentar.";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runManagedPiSystem.mockResolvedValueOnce({
      kind: "blocked",
      reason: "projection-receipt-unreadable",
      paths: [receipt],
      remedy,
    });

    try {
      const exitCode = await runCli(["sync", "--agents", "pi", "--yes"], home);

      expect(exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(`Pi: projection-receipt-unreadable: ${receipt}. ${remedy}`);
    } finally {
      error.mockRestore();
    }
  });
});
