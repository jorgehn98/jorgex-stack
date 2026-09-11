import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "../src/install.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-install-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preflight de writing-style en runInstall", () => {
  it("rechaza una fuente inválida antes de crear cualquier archivo del destino", async () => {
    const targetDir = tempRoot();
    const source = path.join(targetDir, "writing-style.md");
    fs.writeFileSync(source, "<!-- jorgex:reserved -->\ntexto sintético\n");

    await expect(runInstall({
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

    await expect(runInstall({
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
});

