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
const CANONICAL_STYLE = path.join(ROOT, "stack", "system-prompt", "writing-style.md");
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
  it("bloquea desde el CLI un prompt browser ambiguo antes de preparar estilo o ejecutar runtimes", async () => {
    const home = tempRoot();
    const targetDir = path.join(home, "target");
    const prompt = path.join(targetDir, "AGENTS.md");
    const ambiguous = "# User prompt\n\n<!-- jorgex:browser -->\nLegacy content without a closing marker.\n";
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(prompt, ambiguous);

    await expect(runCli(["install", "--agents", "codex", "--target-dir", targetDir, "--yes"], home)).resolves.toBe(1);

    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(fs.readFileSync(prompt, "utf8")).toBe(ambiguous);
    expect(fs.readdirSync(targetDir)).toEqual(["AGENTS.md"]);
    expect(mocks.prompts.log.error).toHaveBeenCalledWith(expect.stringMatching(/browser|marcador|marker|ambig/i));
  });

  it("instala el estilo canónico en la fuente local en un install nuevo", async () => {
    const home = tempRoot();
    const source = path.join(home, ".jorgex-stack", "writing-style.md");

    await expect(runCli(["install", "--agents", "codex", "--yes"], home)).resolves.toBe(0);

    expect(fs.existsSync(source)).toBe(true);
    const installed = fs.readFileSync(source, "utf8");
    const canonical = fs.readFileSync(CANONICAL_STYLE, "utf8");
    expect(installed).toContain("<!-- jorgex:writing-style-default -->");
    expect(installed).toContain(canonical.trim());
    expect(installed).toContain("<!-- /jorgex:writing-style-default -->");
    expect(installed.match(/<!-- jorgex:writing-style-default -->/g)).toHaveLength(1);
    expect(installed.match(/<!-- \/jorgex:writing-style-default -->/g)).toHaveLength(1);
    expect(installed).not.toContain("<!-- jorgex:writing-style -->");
    expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: expect.objectContaining({
        sourcePath: source,
        content: canonical.trim(),
      }),
    }));
  });

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
    expect(installInput?.writingStyle).toEqual(expect.objectContaining({
      sourcePath: source,
      content: expect.stringContaining(STYLE),
      canonicalPath: CANONICAL_STYLE,
      originalContent: STYLE,
      installedContent: expect.stringContaining("jorgex:writing-style-default"),
    }));
    expect(installInput?.writingStyle?.content).toContain("# Writing style");
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
      writingStyle: expect.objectContaining({
        sourcePath: source,
        content: expect.stringContaining(STYLE),
        canonicalPath: CANONICAL_STYLE,
      }),
      writingStyleMode: "programmatic",
    }));
  });

  it.each(["pi", "codex"] as const)("target-dir usa solo su fuente y no filtra el estilo del HOME real en %s", async (runtime) => {
    const home = tempRoot();
    const targetDir = path.join(home, "target");
    const realSource = writeStateStyle(home, "ESTILO REAL QUE NO DEBE APARECER");
    const targetSource = writeTargetStyle(targetDir, STYLE);

    await expect(runCli(["install", "--agents", runtime, "--target-dir", targetDir, "--yes"], home)).resolves.toBe(0);

    if (runtime === "pi") {
      expect(mocks.runManagedPiSystem).toHaveBeenCalledWith(expect.objectContaining({
        targetDir,
        writingStyle: expect.objectContaining({
          sourcePath: targetSource,
          content: expect.stringContaining(STYLE),
          canonicalPath: CANONICAL_STYLE,
        }),
      }));
      expect(mocks.runManagedPiSystem).not.toHaveBeenCalledWith(expect.objectContaining({
        writingStyle: expect.objectContaining({ sourcePath: realSource }),
      }));
    } else {
      expect(mocks.runInstall).toHaveBeenCalledWith(expect.objectContaining({
        runtimes: ["codex"],
        targetDir,
        writingStyle: expect.objectContaining({
          sourcePath: targetSource,
          content: expect.stringContaining(STYLE),
          canonicalPath: CANONICAL_STYLE,
        }),
      }));
      expect(mocks.runInstall).not.toHaveBeenCalledWith(expect.objectContaining({
        writingStyle: expect.objectContaining({ sourcePath: realSource }),
      }));
    }
  });

  it("dry-run valida la fuente aunque no ejecute ningún lifecycle ni escriba destinos", async () => {
    const home = tempRoot();
    const source = writeStateStyle(home, STYLE);

    await expect(runCli(["install", "--agents", "pi", "--mode", "programmatic", "--dry-run", "--yes"], home)).resolves.toBe(0);

    expect(mocks.runInstall).not.toHaveBeenCalled();
    expect(mocks.runManagedPiSystem).not.toHaveBeenCalled();
  });
});
