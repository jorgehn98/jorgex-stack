import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runInstall = vi.fn().mockResolvedValue(0);
  const runInteractiveUpdate = vi.fn().mockResolvedValue({ exitCode: 0, appliedUpdates: false });
  const runModelsPicker = vi.fn().mockResolvedValue(0);
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
  return { prompts, runInteractiveUpdate, runInstall, runModelsPicker };
});

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
});

function collectedMessages(spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
  return spies.flatMap((spy) => spy.mock.calls.flat()).map((value) => String(value));
}

describe("CLI follow-up sync mode resolution", () => {
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

    mocks.runInteractiveUpdate.mockResolvedValueOnce({ exitCode: 0, appliedUpdates: true });

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
