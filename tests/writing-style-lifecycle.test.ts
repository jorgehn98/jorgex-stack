import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listBackups } from "../src/lib/backup.js";
import { runPiProjectionLifecycleSystem } from "../src/lib/pi-projection-lifecycle.js";

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => prompts);

const tempRoots: string[] = [];
const HUMAN_MODE = { mode: "human" as const, subagentConcurrency: "serial" as const };
const MODELS = {
  strong: { model: "provider/strong" },
  standard: { model: "provider/standard" },
  cheap: { model: "provider/cheap" },
};

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-lifecycle-"));
  tempRoots.push(root);
  return root;
}

function writeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ codex: MODELS }) + "\n");
}

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    vi.resetModules();
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

describe("lifecycle del estilo global", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("instala el canon, desinstala y restaura con backup sin leer ni borrar la fuente", async () => {
    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".codex");
    const promptFile = path.join(configDir, "AGENTS.md");
    const backupsRoot = path.join(homeDir, ".jorgex-stack", "backups");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(promptFile, "# Instrucción propia\n\nConserva esta línea.\n");
    writeModelMap(homeDir);

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const uninstall = await import("../src/uninstall.js");
      const backup = await import("../src/lib/backup.js");
      const originalDetectors = Object.values(install.ADAPTERS).map((candidate) => [candidate, candidate.detect] as const);

      for (const candidate of Object.values(install.ADAPTERS)) {
        candidate.detect = () => ({
          id: candidate.id,
          name: candidate.name,
          installed: candidate.id === "codex",
          binPath: null,
          configDir: candidate.id === "codex" ? configDir : path.join(root, candidate.id),
        });
      }

      try {
        await expect(install.runInstall({
          runtimes: ["codex"],
          dryRun: false,
          yes: true,
          mode: HUMAN_MODE,
          engramBin: null,
          showSummary: false,
        })).resolves.toBe(0);

        const source = path.join(homeDir, ".jorgex-stack", "writing-style.md");
        const firstPrompt = fs.readFileSync(promptFile, "utf8");
        const firstSource = fs.readFileSync(source, "utf8");
        expect(firstSource).toContain("<!-- jorgex:writing-style-default -->");
        expect(firstSource).toContain("# Humanizer Jorge");
        expect(firstPrompt.match(/<!-- jorgex:writing-style -->/g)).toHaveLength(1);

        const unreadableSource = Buffer.from([0xc3, 0x28]);
        fs.writeFileSync(source, unreadableSource);

        await expect(uninstall.runUninstall({
          runtimes: ["codex"],
          dryRun: false,
          yes: true,
          removeEngram: false,
          removePlaywright: false,
        })).resolves.toBe(0);
        expect(fs.readFileSync(source)).toEqual(unreadableSource);
        expect(fs.readFileSync(promptFile, "utf8")).not.toContain("jorgex:writing-style");

        const uninstallBackup = backup.listBackups(backupsRoot).find((candidate) => candidate.files.some((file) =>
          file.original === promptFile && fs.readFileSync(file.stored, "utf8").includes("jorgex:writing-style")));
        expect(uninstallBackup).toBeDefined();

        const restored = backup.restoreBackup(uninstallBackup!.id, backupsRoot, homeDir);
        expect(restored).toBeGreaterThan(0);
        expect(fs.readFileSync(promptFile, "utf8")).toContain("jorgex:writing-style");
        expect(fs.readFileSync(source)).toEqual(unreadableSource);
      } finally {
        for (const [candidate, detect] of originalDetectors) candidate.detect = detect;
      }
    });
  });

  it("el lifecycle real de Pi respalda y retira solo sus marcadores, preservando la política del usuario y la fuente", () => {
    const root = tempRoot();
    const targetDir = path.join(root, "target");
    const sourcePath = path.join(root, "writing-style.md");
    const style = "Estilo sintético de Pi para lifecycle.";
    const agentPrompt = path.join(targetDir, "pi-agent", "AGENTS.md");
    const backupsRoot = path.join(targetDir, "backups");
    fs.writeFileSync(sourcePath, `${style}\n`);
    fs.mkdirSync(path.dirname(agentPrompt), { recursive: true });
    fs.writeFileSync(agentPrompt, "# Instrucciones de usuario\n\nNo elimines esta política.\n");

    const input = {
      targetDir,
      packageSource: "npm:jorgex-pi@test",
      engramBin: null,
      playwrightCliEnabled: false,
      writingStyle: { sourcePath, content: style },
    };

    expect(runPiProjectionLifecycleSystem({ operation: "install", ...input })).toMatchObject({ kind: "installed" });
    const installedPrompt = fs.readFileSync(agentPrompt, "utf8");
    expect(installedPrompt).toContain("<!-- jorgex:writing-style -->");
    expect(installedPrompt).toContain(style);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(`${style}\n`);

    expect(runPiProjectionLifecycleSystem({ operation: "uninstall", ...input })).toEqual({ kind: "uninstalled" });
    const uninstalledPrompt = fs.readFileSync(agentPrompt, "utf8");
    expect(uninstalledPrompt).toContain("# Instrucciones de usuario");
    expect(uninstalledPrompt).toContain("No elimines esta política.");
    expect(uninstalledPrompt).not.toContain("jorgex:writing-style");
    expect(uninstalledPrompt).not.toContain("jorgex:system-prompt");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(`${style}\n`);

    const promptBackups = listBackups(backupsRoot).flatMap((backup) => backup.files)
      .filter((file) => file.original === agentPrompt);
    expect(promptBackups.length).toBeGreaterThan(0);
    expect(promptBackups.some((file) => fs.readFileSync(file.stored, "utf8").includes("jorgex:writing-style"))).toBe(true);
  });
});
