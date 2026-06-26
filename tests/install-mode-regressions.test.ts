import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeId } from "../src/adapters/types.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function preferenceFile(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "install-mode.json");
}

function writePreference(homeDir: string, value: unknown): void {
  const file = preferenceFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function runCli(args: string[], homeDir: string): Promise<void> {
  const originalArgv = [...process.argv];
  const originalExitCode = process.exitCode;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.exitCode = undefined;

  try {
    vi.resetModules();
    process.argv = [process.execPath, path.join(ROOT, "src", "cli.ts"), ...args];
    await import("../src/cli.js");
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

async function importInstallModule(homeDir: string): Promise<typeof import("../src/install.js")> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    vi.resetModules();
    return await import("../src/install.js");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

describe("install-mode regressions", () => {
  it("ignora la preferencia guardada cuando --target-dir debería forzar artefactos human", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-target-dir-"));
    const homeDir = path.join(tmp, "home");
    const targetDir = path.join(tmp, "target");

    writePreference(homeDir, { mode: "programmatic", subagentConcurrency: "parallel" });

    await runCli(["install", "--agents", "opencode", "--target-dir", targetDir, "--yes"], homeDir);

    const { opencodeAdapter } = await import("../src/adapters/opencode.js");
    const systemPrompt = fs.readFileSync(opencodeAdapter.paths(targetDir).systemPromptFile, "utf8");

    expect(systemPrompt).not.toContain("PROGRAMMATIC MODE");
    expect(systemPrompt).not.toContain("strict JSON object");
  });

  it("no escribe la preferencia antes de saber que la instalación ha terminado bien", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-save-timing-"));
    const homeDir = path.join(tmp, "home");

    writePreference(homeDir, { mode: "human", subagentConcurrency: "serial" });

    const { runInstall } = await importInstallModule(homeDir);
    await expect(
      runInstall({
        runtimes: ["does-not-exist" as RuntimeId],
        dryRun: false,
        yes: true,
        mode: { mode: "programmatic", subagentConcurrency: "parallel" },
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(fs.readFileSync(preferenceFile(homeDir), "utf8")) as { mode: string; subagentConcurrency: string }).toEqual({
      mode: "human",
      subagentConcurrency: "serial",
    });
  });
});
