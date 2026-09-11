import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runInstall: vi.fn().mockResolvedValue(0),
  runManagedPiSystem: vi.fn().mockResolvedValue({ kind: "healthy" }),
  detectPiRuntime: vi.fn().mockReturnValue({
    id: "pi",
    name: "Pi",
    installed: true,
    executable: "/isolated/bin/pi",
    version: "0.84.2",
    codingAgentDir: "/isolated/pi-agent",
  }),
  hasManagedPiRuntime: vi.fn().mockReturnValue(false),
  resolvePiEngramBin: vi.fn().mockReturnValue("/isolated/bin/engram"),
  resolvePiEngramRequirement: vi.fn(),
  prompts: {
    intro: vi.fn(),
    outro: vi.fn(),
    confirm: vi.fn().mockResolvedValue(false),
    multiselect: vi.fn().mockResolvedValue([]),
    isCancel: vi.fn().mockReturnValue(false),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock("@clack/prompts", () => mocks.prompts);

vi.mock("../src/install.js", async () => {
  const actual = await vi.importActual<typeof import("../src/install.js")>("../src/install.js");
  return { ...actual, runInstall: mocks.runInstall };
});

vi.mock("../src/lib/pi-managed-runtime.js", () => ({
  runManagedPiSystem: mocks.runManagedPiSystem,
}));

vi.mock("../src/lib/pi-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pi-runtime.js")>("../src/lib/pi-runtime.js");
  return {
    ...actual,
    detectPiRuntime: mocks.detectPiRuntime,
    hasManagedPiRuntime: mocks.hasManagedPiRuntime,
    resolvePiEngramBin: mocks.resolvePiEngramBin,
    resolvePiEngramRequirement: mocks.resolvePiEngramRequirement,
  };
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "src", "cli.ts");
const STYLE = "Prefiere una prosa directa y conectada.\nRespeta siempre el formato pedido.";

const tempRoots: string[] = [];

function tempRoot(prefix = "jx-writing-style-preflight-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeStateStyle(home: string, content: string | Buffer): string {
  const source = path.join(home, ".jorgex-stack", "writing-style.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, content);
  return source;
}

function writeTargetStyle(targetDir: string, content: string | Buffer): string {
  const source = path.join(targetDir, "writing-style.md");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(source, content);
  return source;
}

async function runCli(args: string[], homeDir: string): Promise<typeof process.exitCode> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.exitCode = undefined;
  try {
    vi.resetModules();
    process.argv = [process.execPath, CLI_PATH, ...args];
    await import("../src/cli.js");
    return process.exitCode;
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.runInstall.mockResolvedValue(0);
  mocks.runManagedPiSystem.mockResolvedValue({ kind: "healthy" });
  mocks.detectPiRuntime.mockReturnValue({
    id: "pi",
    name: "Pi",
    installed: true,
    executable: "/isolated/bin/pi",
    version: "0.84.2",
    codingAgentDir: "/isolated/pi-agent",
  });
  mocks.resolvePiEngramBin.mockReturnValue("/isolated/bin/engram");
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preflight de estilo antes del coordinador de runtimes", () => {
  it("lee una sola instantánea y la entrega idéntica a los runtimes de archivo y Pi", async () => {
    const home = tempRoot();
    const source = writeStateStyle(home, STYLE);

    await expect(runCli(["install", "--agents", "codex,pi", "--mode", "human", "--yes"], home)).resolves.toBe(0);

    const installInput = mocks.runInstall.mock.calls[0]?.[0] as {
      writingStyle?: { sourcePath: string; content: string | null };
    } | undefined;
    const piInput = mocks.runManagedPiSystem.mock.calls[0]?.[0] as {
      writingStyle?: { sourcePath: string; content: string | null };
      writingStyleMode?: string;
    } | undefined;
    expect(installInput?.writingStyle).toEqual({ sourcePath: source, content: STYLE });
    expect(piInput?.writingStyle).toBe(installInput?.writingStyle);
    expect(piInput?.writingStyleMode).toBe("human");
  });

  it("bloquea una fuente inválida antes de runInstall, Engram o el lifecycle de Pi", async () => {
    const home = tempRoot();
    writeStateStyle(home, Buffer.from([0xc3, 0x28]));

    await expect(runCli(["install", "--agents", "codex,pi", "--mode", "human", "--yes"], home)).resolves.toBe(1);

    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });

  it("en Pi-only programmatic conserva la instantánea pero ordena filtrar la proyección", async () => {
    const home = tempRoot();
    const source = writeStateStyle(home, STYLE);

    await expect(runCli(["install", "--agents", "pi", "--mode", "programmatic", "--yes"], home)).resolves.toBe(0);

    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: { sourcePath: source, content: STYLE },
      writingStyleMode: "programmatic",
    }));
  });

  it("target-dir usa solo su fuente y no filtra el estilo del HOME real", async () => {
    const home = tempRoot();
    const targetDir = path.join(home, "target");
    const realSource = writeStateStyle(home, "ESTILO REAL QUE NO DEBE APARECER");
    const targetSource = writeTargetStyle(targetDir, STYLE);

    await expect(runCli(["install", "--agents", "pi", "--target-dir", targetDir, "--yes"], home)).resolves.toBe(0);

    expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
      targetDir,
      writingStyle: { sourcePath: targetSource, content: STYLE },
    }));
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: expect.objectContaining({ sourcePath: realSource, content: expect.stringContaining("ESTILO REAL") }),
    }));
  });

  it("dry-run valida la fuente aunque no ejecute ningún lifecycle ni escriba destinos", async () => {
    const home = tempRoot();
    const source = writeStateStyle(home, STYLE);

    await expect(runCli(["install", "--agents", "pi", "--mode", "programmatic", "--dry-run", "--yes"], home)).resolves.toBe(0);

    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });
});
