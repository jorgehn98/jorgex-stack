import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const inspectPlaywrightCapability = vi.fn(() => ({
    cli: { status: "current", binPath: "/isolated/playwright-cli", detectedVersion: "0.1.18" },
    browserCache: { status: "ready", path: "/isolated/browser" },
    browserVerified: true,
    effective: true,
  }));
  const runInstall = vi.fn().mockResolvedValue(0);
  const runInteractiveUpdate = vi.fn().mockResolvedValue({ exitCode: 0, appliedUpdates: false, syncRequired: false });
  const runModelsPicker = vi.fn().mockResolvedValue(0);
  const detectPiRuntime = vi.fn().mockReturnValue({
    id: "pi",
    name: "Pi",
    installed: false,
    executable: null,
    version: null,
    codingAgentDir: "/isolated/pi-agent",
  });
  const hasManagedPiRuntime = vi.fn().mockReturnValue(false);
  const resolvePiEngramBin = vi.fn().mockReturnValue("/isolated/bin/engram");
  const resolvePiEngramRequirement = vi.fn();
  const runManagedPiSystem = vi.fn().mockResolvedValue({ kind: "healthy" });
  const piCapabilityMode = { value: "actual" as "actual" | "without-playwright" };
  const prompts = {
    confirm: vi.fn().mockResolvedValue(true),
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
    inspectPlaywrightCapability,
    runInteractiveUpdate,
    runInstall,
    runModelsPicker,
    detectPiRuntime,
    hasManagedPiRuntime,
    resolvePiEngramBin,
    resolvePiEngramRequirement,
    runManagedPiSystem,
    piCapabilityMode,
  };
});

vi.mock("../src/lib/playwright-capability.js", () => ({
  inspectPlaywrightCapability: mocks.inspectPlaywrightCapability,
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.prompts.confirm,
  intro: mocks.prompts.intro,
  isCancel: mocks.prompts.isCancel,
  log: mocks.prompts.log,
  multiselect: mocks.prompts.multiselect,
  outro: mocks.prompts.outro,
}));

vi.mock("../src/install.js", async () => {
  const actual = await vi.importActual<typeof import("../src/install.js")>("../src/install.js");
  return { ...actual, runInstall: mocks.runInstall };
});

vi.mock("../src/update.js", async () => {
  const actual = await vi.importActual<typeof import("../src/update.js")>("../src/update.js");
  return { ...actual, runInteractiveUpdate: mocks.runInteractiveUpdate };
});

vi.mock("../src/models-picker.js", async () => {
  const actual = await vi.importActual<typeof import("../src/models-picker.js")>("../src/models-picker.js");
  return { ...actual, runModelsPicker: mocks.runModelsPicker };
});

vi.mock("../src/lib/pi-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pi-runtime.js")>("../src/lib/pi-runtime.js");
  const contract = { ...actual.PI_RUNTIME_CANDIDATE.contract };
  Object.defineProperty(contract, "capabilities", {
    enumerable: true,
    get: () => mocks.piCapabilityMode.value === "without-playwright"
      ? actual.PI_RUNTIME_CANDIDATE.contract.capabilities.filter((capability) => String(capability) !== "playwright-handoff-v1")
      : actual.PI_RUNTIME_CANDIDATE.contract.capabilities,
  });
  return {
    ...actual,
    PI_RUNTIME_CANDIDATE: {
      ...actual.PI_RUNTIME_CANDIDATE,
      contract,
    },
    detectPiRuntime: mocks.detectPiRuntime,
    hasManagedPiRuntime: mocks.hasManagedPiRuntime,
    resolvePiEngramBin: mocks.resolvePiEngramBin,
    resolvePiEngramRequirement: mocks.resolvePiEngramRequirement,
  };
});

vi.mock("../src/lib/pi-managed-runtime.js", () => ({
  runManagedPiSystem: mocks.runManagedPiSystem,
}));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "src", "cli.ts");

function installModePreferenceFile(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "install-mode.json");
}

function writePreference(homeDir: string, value: unknown): void {
  const file = installModePreferenceFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function writeOpenCodeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    opencode: {
      strong: { model: "provider/strong" },
      standard: { model: "provider/standard" },
      cheap: { model: "provider/cheap" },
    },
  }, null, 2) + "\n");
}

function setStdoutTty(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value, writable: true });
  return () => {
    if (original === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", original);
  };
}

async function runCli(args: string[], homeDir: string, tty = false): Promise<typeof process.exitCode> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const restoreTty = tty ? setStdoutTty(true) : null;
  let observedExitCode: typeof process.exitCode = undefined;
  const engram = path.join(homeDir, ".local", "bin", process.platform === "win32" ? "engram.exe" : "engram");
  fs.mkdirSync(path.dirname(engram), { recursive: true });
  fs.writeFileSync(engram, "fixture; never execute", { mode: 0o755 });

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
    restoreTty?.();
    vi.resetModules();
  }
  return observedExitCode;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.detectPiRuntime.mockReset().mockReturnValue({
    id: "pi",
    name: "Pi",
    installed: false,
    executable: null,
    version: null,
    codingAgentDir: "/isolated/pi-agent",
  });
  mocks.hasManagedPiRuntime.mockReset().mockReturnValue(false);
  mocks.resolvePiEngramBin.mockReset().mockReturnValue("/isolated/bin/engram");
  mocks.runManagedPiSystem.mockReset().mockResolvedValue({ kind: "healthy" });
  mocks.piCapabilityMode.value = "actual";
});

function collectedMessages(spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
  return spies.flatMap((spy) => spy.mock.calls.flat()).map((value) => String(value));
}

describe("CLI follow-up sync mode resolution", () => {
  it("fresh interactive OpenCode install requires provider-aware model selection first", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-model-picker-"));
    const homeDir = path.join(tmp, "home");
    mocks.runModelsPicker.mockImplementationOnce(async () => {
      writeOpenCodeModelMap(homeDir);
      return 0;
    });

    const exitCode = await runCli(["install", "--agents", "opencode", "--mode", "human"], homeDir, true);

    expect(exitCode).toBe(0);
    expect(mocks.runModelsPicker).toHaveBeenCalledWith({ yes: false, runtimes: ["opencode"] });
    expect(mocks.runInstall).toHaveBeenCalledTimes(1);
  });

  it("OpenCode reinstall preserves an existing model selection without reopening the picker", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-model-existing-"));
    const homeDir = path.join(tmp, "home");
    writeOpenCodeModelMap(homeDir);

    const exitCode = await runCli(["install", "--agents", "opencode", "--mode", "human"], homeDir, true);

    expect(exitCode).toBe(0);
    expect(mocks.runModelsPicker).not.toHaveBeenCalled();
    expect(mocks.runInstall).toHaveBeenCalledTimes(1);
  });

  it("fresh non-interactive OpenCode install fails instead of inventing a provider", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-model-required-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["install", "--agents", "opencode", "--mode", "human", "--yes"], homeDir);

      expect(exitCode).toBe(1);
      expect(mocks.runModelsPicker).not.toHaveBeenCalled();
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/OpenCode.*models/i));
    } finally {
      error.mockRestore();
    }
  });

  it("update reusa el modo explícito programmatic/parallel al lanzar el sync", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-mode-"));
    const homeDir = path.join(tmp, "home");
    writePreference(homeDir, { mode: "human", subagentConcurrency: "serial" });

    await runCli(["update", "--agents", "opencode", "--mode", "programmatic", "--subagent-concurrency", "parallel", "--yes"], homeDir);

    expect(mocks.runInstall).toHaveBeenCalledTimes(1);
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      mode: { mode: "programmatic", subagentConcurrency: "parallel" },
    }));
  });

  it("update mixto reutiliza la instantánea inicial y el modo explícito al sincronizar Pi", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-style-snapshot-mixed-"));
    const homeDir = path.join(tmp, "home");
    const styleFile = path.join(homeDir, ".jorgex-stack", "writing-style.md");
    const originalStyle = "Estilo sintético inicial de update.";
    const changedStyle = "Estilo sintético cambiado durante update.";
    fs.mkdirSync(path.dirname(styleFile), { recursive: true });
    fs.writeFileSync(styleFile, `${originalStyle}\n`);
    writeOpenCodeModelMap(homeDir);
    mocks.detectPiRuntime.mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/isolated/bin/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    });
    mocks.runInteractiveUpdate.mockImplementationOnce(async () => {
      fs.writeFileSync(styleFile, `${changedStyle}\n`);
      return { exitCode: 0, appliedUpdates: false, syncRequired: false };
    });

    try {
      await runCli([
        "update",
        "--agents",
        "opencode,pi",
        "--mode",
        "programmatic",
        "--subagent-concurrency",
        "parallel",
        "--yes",
      ], homeDir);

      const expectedStyle = expect.objectContaining({
        sourcePath: styleFile,
        content: expect.stringContaining(originalStyle),
        canonicalPath: expect.stringContaining("stack/system-prompt/writing-style.md"),
        installedContent: expect.stringContaining("jorgex:writing-style-default"),
      });
      expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
        writingStyle: expectedStyle,
        mode: { mode: "programmatic", subagentConcurrency: "parallel" },
      }));
      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
        operation: "update",
        writingStyle: expectedStyle,
        writingStyleMode: "programmatic",
      }));
      expect(mocks.runManagedPiSystem.mock.calls[0]?.[0]?.writingStyle)
        .toBe(mocks.runInstall.mock.calls[0]?.[0]?.writingStyle);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("update solo Pi conserva la instantánea y el modo explícito", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-style-snapshot-pi-"));
    const homeDir = path.join(tmp, "home");
    const styleFile = path.join(homeDir, ".jorgex-stack", "writing-style.md");
    const style = "Estilo sintético solo para Pi.";
    fs.mkdirSync(path.dirname(styleFile), { recursive: true });
    fs.writeFileSync(styleFile, `${style}\n`);
    mocks.detectPiRuntime.mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/isolated/bin/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    });

    try {
      await runCli([
        "update",
        "--agents",
        "pi",
        "--mode",
        "programmatic",
        "--subagent-concurrency",
        "parallel",
        "--yes",
      ], homeDir);

      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
        operation: "update",
        writingStyle: expect.objectContaining({
          sourcePath: styleFile,
          content: expect.stringContaining(style),
          canonicalPath: expect.stringContaining("stack/system-prompt/writing-style.md"),
          installedContent: expect.stringContaining("jorgex:writing-style-default"),
        }),
        writingStyleMode: "programmatic",
      }));
      expect(mocks.runInteractiveUpdate).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("update omite el sync previo cuando no hay preferencia guardada y sigue con el update", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-missing-mode-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["update", "--agents", "opencode"], homeDir);

      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(mocks.runInteractiveUpdate).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/modo.*guardad|expl[ií]cit/i));
    } finally {
      error.mockRestore();
    }
  });

  it("update con cambios aplicados y sin modo guardado deja el sync pendiente", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-pending-sync-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.runInteractiveUpdate.mockResolvedValueOnce({ exitCode: 0, appliedUpdates: true, syncRequired: true });

    try {
      const exitCode = await runCli(["update", "--agents", "opencode"], homeDir, true);

      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(mocks.runInteractiveUpdate).toHaveBeenCalledTimes(1);
      expect(exitCode).toBe(0);
      expect(
        collectedMessages([error, log, mocks.prompts.log.warn, mocks.prompts.log.info]).some((message) =>
          /pendiente.*sync|sync.*pendiente|pending sync/i.test(message),
        ),
      ).toBe(true);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("update binario-only no anuncia un sync pendiente", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-binary-only-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    mocks.runInteractiveUpdate.mockResolvedValueOnce({ exitCode: 0, appliedUpdates: true, syncRequired: false });

    try {
      const exitCode = await runCli(["update", "--agents", "opencode"], homeDir, true);

      expect(exitCode).toBe(0);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(mocks.runInteractiveUpdate).toHaveBeenCalledTimes(1);
      expect(
        collectedMessages([error, log, mocks.prompts.log.warn, mocks.prompts.log.info]).some((message) =>
          /pendiente.*sync|sync.*pendiente|pending sync/i.test(message),
        ),
      ).toBe(false);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("models pasa el modo explícito al sync posterior", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-models-mode-"));
    const homeDir = path.join(tmp, "home");

    await runCli(["models", "--agents", "opencode", "--mode", "programmatic", "--subagent-concurrency", "parallel"], homeDir, true);

    expect(mocks.runModelsPicker).toHaveBeenCalledTimes(1);
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      mode: { mode: "programmatic", subagentConcurrency: "parallel" },
    }));
  });

  it("models opcionalmente salta el sync cuando falta una preferencia guardada y conserva el exit code de éxito", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-models-missing-mode-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["models", "--agents", "opencode"], homeDir, true);

      expect(mocks.runModelsPicker).toHaveBeenCalledTimes(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(exitCode).toBe(0);
      expect(
        collectedMessages([error, log, mocks.prompts.log.warn, mocks.prompts.log.info]).some((message) =>
          /se omite el sync|sync omitid|skip/i.test(message),
        ),
      ).toBe(true);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("install con --target-dir fuerza el modo human aunque exista una preferencia programmatic", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-target-dir-human-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");

    writePreference(homeDir, { mode: "programmatic", subagentConcurrency: "parallel" });
    writeOpenCodeModelMap(homeDir);

    await runCli(["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"], homeDir);

    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      targetDir,
      mode: { mode: "human", subagentConcurrency: "serial" },
    }));
    expect(mocks.prompts.log.info).toHaveBeenCalledWith(expect.stringMatching(/--target-dir.*human.*--mode programmatic/i));
  });

  it("update con --target-dir puede sincronizar en modo human aislado aunque no haya preferencia guardada", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-update-target-dir-human-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");

    await runCli(["update", "--agents", "opencode", "--target-dir", targetDir], homeDir);

    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      targetDir,
      mode: { mode: "human", subagentConcurrency: "serial" },
    }));
    expect(mocks.runInteractiveUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.prompts.log.info).toHaveBeenCalledWith(expect.stringMatching(/--target-dir.*human.*--mode programmatic/i));
  });
});

describe("rechazo de flags desconocidos en main()", () => {
  it("un flag desconocido sale con código 1 sin ejecutar install y avisa en singular", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-unknown-flag-single-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["install", "--frobnicate"], homeDir);

      expect(exitCode).toBe(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      const messages = collectedMessages([error]);
      expect(messages.some((m) => /Flag no reconocido: --frobnicate/.test(m))).toBe(true);
      expect(messages.some((m) => /no reconoce ese flag/.test(m))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("varios flags desconocidos salen con código 1 y avisan en plural con la lista", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-unknown-flag-multi-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["install", "--foo", "--bar"], homeDir);

      expect(exitCode).toBe(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      const messages = collectedMessages([error]);
      expect(messages.some((m) => /Flags no reconocidos: --foo, --bar/.test(m))).toBe(true);
      expect(messages.some((m) => /no reconoce esos flags/.test(m))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe("opciones de navegador en main()", () => {
  it("muestra las opciones de Playwright y DevTools en la ayuda", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-help-"));
    const homeDir = path.join(tmp, "home");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(["--help"], homeDir);

      expect(exitCode).toBeUndefined();
      const output = collectedMessages([log]);
      for (const flag of ["--playwright", "--playwright-runtimes", "--remove-playwright", "--devtools", "--no-devtools"]) {
        expect(output.some((line) => line.includes(flag))).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("rechaza seleccionar DevTools y no-devtools a la vez", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-devtools-conflict-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli(
        ["install", "--agents", "opencode", "--mode", "human", "--devtools", "--no-devtools"],
        homeDir,
      );

      expect(exitCode).toBe(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(collectedMessages([error]).some((message) => /solo uno de --devtools o --no-devtools/i.test(message))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("entrega el consentimiento de Playwright y la selección DevTools a install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-install-flags-"));
    const homeDir = path.join(tmp, "home");
    writeOpenCodeModelMap(homeDir);

    await runCli(
      ["install", "--agents", "opencode", "--mode", "human", "--yes", "--playwright", "--devtools"],
      homeDir,
    );

    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      playwrightToolConsent: expect.objectContaining({
        command: "install",
        explicitToolSelection: true,
      }),
      devtoolsMcpSelection: { opencode: true },
    }));
  });

  it("accepts --playwright-runtimes with --playwright and passes true/false for current agents", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-runtime-flag-"));
    const homeDir = path.join(tmp, "home");
    writeOpenCodeModelMap(homeDir);

    const exitCode = await runCli([
      "install",
      "--agents",
      "opencode,claude-code,codex",
      "--mode",
      "human",
      "--yes",
      "--playwright",
      "--playwright-runtimes=opencode,codex",
    ], homeDir);

    expect(exitCode).toBe(0);
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      playwrightToolConsent: expect.objectContaining({
        explicitToolSelection: true,
        runtimeSelection: { opencode: true, "claude-code": false, codex: true },
      }),
    }));
  });

  it("opens the runtime selector only after Playwright consent and passes partial choices", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-runtime-picker-"));
    const homeDir = path.join(tmp, "home");
    writeOpenCodeModelMap(homeDir);
    mocks.prompts.confirm.mockResolvedValueOnce(true);
    mocks.prompts.multiselect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["codex"]);

    const exitCode = await runCli([
      "install",
      "--agents",
      "opencode,claude-code,codex",
      "--mode",
      "human",
    ], homeDir, true);

    expect(exitCode).toBe(0);
    const playwrightPicker = mocks.prompts.multiselect.mock.calls.find(([input]) =>
      typeof input === "object" && input !== null && "message" in input
        && /Playwright/i.test(String(Reflect.get(input, "message"))),
    );
    expect(playwrightPicker?.[0]).toMatchObject({ required: false });
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      playwrightToolConsent: expect.objectContaining({
        confirmed: true,
        runtimeSelection: { opencode: false, "claude-code": false, codex: true },
      }),
    }));
    const playwrightPickerIndex = mocks.prompts.multiselect.mock.calls.findIndex(([input]) =>
      typeof input === "object" && input !== null
      && /Playwright/i.test(String(Reflect.get(input, "message"))),
    );
    expect(playwrightPickerIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.prompts.confirm.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.prompts.multiselect.mock.invocationCallOrder[playwrightPickerIndex]!,
    );
  });

  it("rejects --playwright-runtimes without --playwright before runInstall", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-runtime-no-consent-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await runCli([
        "install",
        "--agents",
        "opencode",
        "--mode",
        "human",
        "--playwright-runtimes=opencode",
      ], homeDir);

      expect(exitCode).toBe(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(collectedMessages([error])).toEqual(expect.arrayContaining([
        expect.stringMatching(/--playwright-runtimes.*--playwright/i),
      ]));
    } finally {
      error.mockRestore();
    }
  });

  it("rejects unknown and out-of-agents Playwright runtimes before runInstall", async () => {
    const cases = [
      { name: "unknown", agents: "opencode", selection: "opencode,wat", pattern: /runtime.*wat|desconocido.*wat/i },
      { name: "outside agents", agents: "opencode", selection: "codex", pattern: /codex.*agents|codex.*destino|no est[aá].*agents/i },
    ] as const;

    for (const testCase of cases) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `jx-playwright-runtime-${testCase.name}-`));
      const homeDir = path.join(tmp, "home");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const exitCode = await runCli([
          "install",
          "--agents",
          testCase.agents,
          "--mode",
          "human",
          "--yes",
          "--playwright",
          `--playwright-runtimes=${testCase.selection}`,
        ], homeDir);

        expect(exitCode, testCase.name).toBe(1);
        expect(mocks.runInstall, testCase.name).not.toHaveBeenCalled();
        const messages = collectedMessages([error]);
        expect(messages.some((message) => /Flag no reconocido/i.test(message)), testCase.name).toBe(false);
        expect(messages.some((message) => testCase.pattern.test(message)), testCase.name).toBe(true);
      } finally {
        error.mockRestore();
      }
    }
  });

  it("rejects Playwright for Pi before any install when the candidate lacks playwright-handoff-v1", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-playwright-runtime-pi-"));
    const homeDir = path.join(tmp, "home");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.detectPiRuntime.mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/opt/pi/bin/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    });
    mocks.piCapabilityMode.value = "without-playwright";

    try {
      const exitCode = await runCli([
        "install",
        "--agents",
        "pi",
        "--mode",
        "human",
        "--yes",
        "--playwright",
        "--playwright-runtimes=pi",
      ], homeDir);

      expect(exitCode).toBe(1);
      expect(mocks.runInstall).not.toHaveBeenCalled();
      expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
      expect(collectedMessages([error]).some((message) => /Pi.*playwright-handoff-v1|playwright-handoff-v1.*Pi/i.test(message))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});


describe("CLI effective browser capability", () => {
  it("update Playwright exitoso reconcilia la guía sin pedir un sync manual", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-update-playwright-reconcile-"));
    const homeDir = path.join(tmp, "home");
    const beforeUpdate = {
      cli: { status: "current" as const, binPath: "/isolated/playwright-cli", detectedVersion: "0.1.18" },
      browserCache: { status: "ready" as const, path: "/isolated/browser" },
      browserVerified: false,
      effective: false,
    };
    const afterUpdate = { ...beforeUpdate, browserVerified: true, effective: true };

    try {
      writeOpenCodeModelMap(homeDir);
      fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".jorgex-stack", "playwright-cli.json"), JSON.stringify({
        version: 2,
        enabled: { opencode: true },
      }) + "\n");
      mocks.inspectPlaywrightCapability
        .mockReturnValueOnce(beforeUpdate);
      mocks.runInteractiveUpdate.mockResolvedValueOnce({
        exitCode: 0,
        appliedUpdates: true,
        syncRequired: false,
        playwrightCapability: afterUpdate,
      });

      await runCli(["update", "--agents", "opencode", "--mode", "human"], homeDir, true);

      expect(mocks.inspectPlaywrightCapability).toHaveBeenCalledTimes(1);
      expect(mocks.runInstall).toHaveBeenCalledTimes(2);
      expect(mocks.runInstall.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        playwrightCapability: beforeUpdate,
      }));
      expect(mocks.runInstall.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        playwrightCapability: afterUpdate,
      }));
      expect(mocks.runInstall.mock.invocationCallOrder[1]!).toBeGreaterThan(
        mocks.runInteractiveUpdate.mock.invocationCallOrder[0]!,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("doctor --dry-run no convierte una comprobación omitida en paquete ausente", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-doctor-dry-run-browser-"));
    const homeDir = path.join(tmp, "home");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".jorgex-stack", "playwright-cli.json"), JSON.stringify({
        version: 2,
        enabled: { opencode: true },
      }) + "\n");

      await runCli(["doctor", "--agents", "opencode", "--dry-run"], homeDir);

      expect(mocks.inspectPlaywrightCapability).not.toHaveBeenCalled();
      const output = collectedMessages([log, mocks.prompts.log.info, mocks.prompts.log.warn, mocks.prompts.log.error]);
      expect(output.some((message) => /Playwright CLI.*falta.*paquete|Playwright CLI.*missing.*package/i.test(message))).toBe(false);
      expect(output.some((message) => /dry.?run|comprobaci[oó]n.*omit|sin.*comprobar/i.test(message))).toBe(true);
    } finally {
      log.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("update --check de Pi no ejecuta el smoke de Playwright", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-update-check-pi-browser-"));
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(path.join(homeDir, ".jorgex-stack"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".jorgex-stack", "playwright-cli.json"), JSON.stringify({
      version: 2,
      enabled: { pi: true },
    }) + "\n");
    mocks.detectPiRuntime.mockReturnValue({
      id: "pi",
      name: "Pi",
      installed: true,
      executable: "/isolated/pi",
      version: "0.84.2",
      codingAgentDir: "/isolated/pi-agent",
    });

    try {
      await runCli(["update", "--check", "--agents", "pi"], homeDir);

      expect(mocks.inspectPlaywrightCapability).not.toHaveBeenCalled();
      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
        operation: "doctor",
      }));
      expect(mocks.runManagedPiSystem.mock.calls[0]?.[0]).not.toHaveProperty("playwrightCapability");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("install Playwright de Pi reenvía la snapshot verificada y su ruta absoluta al lifecycle", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-install-playwright-pi-handoff-"));
    const homeDir = path.join(tmp, "home");
    const capability = {
      cli: {
        status: "current" as const,
        binPath: path.join(tmp, "pnpm-home", "playwright-cli"),
        detectedVersion: "0.1.18",
      },
      browserCache: { status: "ready" as const, path: path.join(tmp, "browser-cache") },
      browserVerified: true,
      effective: true,
    };

    try {
      mocks.detectPiRuntime.mockReturnValue({
        id: "pi",
        name: "Pi",
        installed: true,
        executable: "/isolated/pi",
        version: "0.84.2",
        codingAgentDir: "/isolated/pi-agent",
      });
      mocks.runInstall.mockImplementationOnce(async (options: {
        onPlaywrightCapability?: (snapshot: typeof capability) => void;
      }) => {
        options.onPlaywrightCapability?.(capability);
        return 0;
      });

      await runCli(["install", "--agents", "pi", "--playwright", "--yes"], homeDir);

      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
        operation: "install",
        playwrightCapability: capability,
      }));
      const piInput = mocks.runManagedPiSystem.mock.calls[0]?.[0] as { playwrightCapability?: typeof capability };
      expect(piInput.playwrightCapability?.cli.binPath).toBe(capability.cli.binPath);
      expect(path.isAbsolute(piInput.playwrightCapability?.cli.binPath ?? "")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { args: ["sync", "--agents", "opencode,pi", "--mode", "human", "--yes"], probes: 1, pi: true },
    { args: ["doctor", "--agents", "pi", "--dry-run"], probes: 0, pi: false },
    { args: ["update", "--agents", "pi", "--dry-run"], probes: 0, pi: false },
    { args: ["sync", "--agents", "opencode", "--mode", "human", "--yes", "--target-dir"], probes: 0, pi: false },
  ])("shares one probe or skips it for $args", async ({ args, probes, pi }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cli-browser-capability-"));
    const homeDir = path.join(tmp, "home");
    try {
      writeOpenCodeModelMap(homeDir);
      fs.writeFileSync(path.join(homeDir, ".jorgex-stack", "playwright-cli.json"), JSON.stringify({
        version: 2, enabled: { opencode: true, pi: true },
      }));
      mocks.detectPiRuntime.mockReturnValue({
        id: "pi", name: "Pi", installed: true,
        executable: "/isolated/pi", version: "0.84.2", codingAgentDir: path.join(homeDir, ".pi", "agent"),
      });
      mocks.hasManagedPiRuntime.mockReturnValue(true);
      const actualArgs = args.at(-1) === "--target-dir" ? [...args, path.join(tmp, "target")] : args;
      await runCli(actualArgs, homeDir);
      expect(mocks.inspectPlaywrightCapability).toHaveBeenCalledTimes(probes);
      if (pi) {
        const snapshot = mocks.inspectPlaywrightCapability.mock.results[0]!.value;
        expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({ playwrightCapability: snapshot }));
        expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({ playwrightCapability: snapshot }));
      } else {
        expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
