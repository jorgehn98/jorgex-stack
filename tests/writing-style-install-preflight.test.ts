import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-install-"));
  roots.push(root);
  return root;
}

function writeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    codex: {
      strong: { model: "provider/strong" },
      standard: { model: "provider/standard" },
      cheap: { model: "provider/cheap" },
    },
  }) + "\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("preflight de writing-style en runInstall", () => {
  it("rechaza una fuente inválida antes de crear cualquier archivo del destino", async () => {
    const targetDir = tempRoot();
    const source = path.join(targetDir, "writing-style.md");
    fs.writeFileSync(source, "<!-- jorgex:reserved -->\ntexto sintético\n");

    vi.resetModules();
    const install = await import("../src/install.js");
    await expect(install.runInstall({
      runtimes: ["codex"],
      targetDir,
      dryRun: false,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
      showSummary: false,
    })).resolves.toBe(1);

    expect(fs.readdirSync(targetDir)).toEqual(["writing-style.md"]);
  });

  it("dry-run valida y planifica el estilo aislado sin escribir el prompt", async () => {
    const targetDir = tempRoot();
    const source = path.join(targetDir, "writing-style.md");
    const style = "Preferencias sintéticas de dry-run.";
    fs.writeFileSync(source, style);

    vi.resetModules();
    const install = await import("../src/install.js");
    await expect(install.runInstall({
      runtimes: ["codex"],
      targetDir,
      dryRun: true,
      yes: true,
      mode: { mode: "human", subagentConcurrency: "serial" },
      showSummary: false,
    })).resolves.toBe(0);

    expect(fs.readFileSync(source, "utf8")).toBe(style);
    expect(fs.existsSync(path.join(targetDir, "AGENTS.md"))).toBe(false);
  });

  it("runInstall directo sin snapshot instala la fuente local canónica", async () => {
    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    writeModelMap(homeDir);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      vi.resetModules();
      const install = await import("../src/install.js");
      await expect(install.runInstall({
        runtimes: ["codex"],
        targetDir,
        dryRun: false,
        yes: true,
        mode: { mode: "human", subagentConcurrency: "serial" },
        showSummary: false,
      })).resolves.toBe(0);

      const source = path.join(targetDir, "writing-style.md");
      const installed = fs.readFileSync(source, "utf8");
      expect(installed).toContain("<!-- jorgex:writing-style-default -->");
      expect(installed).toContain("# Humanizer Jorge");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      vi.resetModules();
    }
  });

  it("runInstall directo en programmatic conserva la fuente pero omite la proyección de prosa", async () => {
    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    writeModelMap(homeDir);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      vi.resetModules();
      const install = await import("../src/install.js");
      await expect(install.runInstall({
        runtimes: ["codex"],
        targetDir,
        dryRun: false,
        yes: true,
        mode: { mode: "programmatic", subagentConcurrency: "serial" },
        showSummary: false,
      })).resolves.toBe(0);

      expect(fs.readFileSync(path.join(targetDir, "writing-style.md"), "utf8")).toContain("# Humanizer Jorge");
      expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).not.toContain("jorgex:writing-style");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      vi.resetModules();
    }
  });
});
