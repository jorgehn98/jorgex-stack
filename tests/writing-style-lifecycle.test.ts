import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeId } from "../src/adapters/types.js";
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
const STYLE_ONE = "Primera versión sintética del estilo.";
const STYLE_TWO = "Segunda versión sintética del estilo.";

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

function writeStyle(homeDir: string, content: string): string {
  const file = path.join(homeDir, ".jorgex-stack", "writing-style.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
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

  it("actualiza, desactiva, repite, desinstala y restaura con backup sin tocar la fuente", async () => {
    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".codex");
    const promptFile = path.join(configDir, "AGENTS.md");
    const backupsRoot = path.join(homeDir, ".jorgex-stack", "backups");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(promptFile, "# Instrucción propia\n\nConserva esta línea.\n");
    writeModelMap(homeDir);
    const source = writeStyle(homeDir, `${STYLE_ONE}\n`);

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const uninstall = await import("../src/uninstall.js");
      const backup = await import("../src/lib/backup.js");
      const style = await import("../src/lib/writing-style.js");
      const adapter = install.ADAPTERS.codex!;
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

      const runInstall = async (snapshot: { sourcePath: string; content: string | null }): Promise<void> => {
        await expect(install.runInstall({
          runtimes: ["codex"],
          writingStyle: snapshot,
          dryRun: false,
          yes: true,
          mode: HUMAN_MODE,
          engramBin: null,
          showSummary: false,
        })).resolves.toBe(0);
      };

      try {
        await runInstall(style.readWritingStyle(source));
        const firstPrompt = fs.readFileSync(promptFile, "utf8");
        expect(firstPrompt).toContain(STYLE_ONE);
        expect(firstPrompt.match(/<!-- jorgex:writing-style -->/g)).toHaveLength(1);
        expect(fs.readFileSync(source, "utf8")).toBe(`${STYLE_ONE}\n`);

        fs.writeFileSync(source, `${STYLE_TWO}\n`);
        await runInstall(style.readWritingStyle(source));
        const updateBackup = backup.listBackups(backupsRoot).find((candidate) => candidate.files.some((file) =>
          file.original === promptFile && fs.readFileSync(file.stored, "utf8").includes(STYLE_ONE)));
        expect(updateBackup).toBeDefined();
        expect(fs.readFileSync(promptFile, "utf8")).toContain(STYLE_TWO);
        expect(fs.readFileSync(promptFile, "utf8")).not.toContain(STYLE_ONE);
        expect(fs.readFileSync(source, "utf8")).toBe(`${STYLE_TWO}\n`);

        const backupsBeforeDisable = backup.listBackups(backupsRoot).length;
        fs.writeFileSync(source, " \n\t\n");
        await runInstall(style.readWritingStyle(source));
        expect(fs.readFileSync(promptFile, "utf8")).not.toContain("jorgex:writing-style");
        expect(fs.readFileSync(source, "utf8")).toBe(" \n\t\n");

        const backupsAfterDisable = backup.listBackups(backupsRoot).length;
        expect(backupsAfterDisable).toBeGreaterThan(backupsBeforeDisable);
        await runInstall(style.readWritingStyle(source));
        expect(backup.listBackups(backupsRoot).length).toBe(backupsAfterDisable);
        expect(fs.readFileSync(promptFile, "utf8")).not.toContain("jorgex:writing-style");

        await expect(uninstall.runUninstall({
          runtimes: ["codex"],
          dryRun: false,
          yes: true,
          removeEngram: false,
          removePlaywright: false,
        })).resolves.toBe(0);
        expect(fs.readFileSync(source, "utf8")).toBe(" \n\t\n");
        expect(fs.readFileSync(promptFile, "utf8")).not.toContain("jorgex:writing-style");

        const restored = backup.restoreBackup(updateBackup!.id, backupsRoot, homeDir);
        expect(restored).toBeGreaterThan(0);
        expect(fs.readFileSync(promptFile, "utf8")).toContain(STYLE_ONE);
        expect(fs.readFileSync(source, "utf8")).toBe(" \n\t\n");
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
