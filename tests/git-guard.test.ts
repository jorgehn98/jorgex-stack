import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planAgents } from "../src/components/agents.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { stackRoot } from "../src/lib/paths.js";
import { GIT_GUARD_SCRIPT } from "../src/lib/git-guard.js";
import type { InstallContext } from "../src/adapters/types.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";

const SCRIPT = path.join(stackRoot(), "scripts", GIT_GUARD_SCRIPT);
const MODELS: RuntimeModelMap = {
  strong: { model: "fable" },
  standard: { model: "sonnet" },
  cheap: { model: "haiku" },
};

/** Lanza el guard con un payload de stdin y devuelve exit code (2 = bloqueado) + stderr. */
function runGuard(stdin: string): { code: number; stderr: string } {
  try {
    execFileSync("node", [SCRIPT], { input: stdin, stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer };
    return { code: e.status ?? -1, stderr: e.stderr?.toString() ?? "" };
  }
}

const withCommand = (command: string) => JSON.stringify({ tool_input: { command } });

describe("block-destructive-git guard", () => {
  it("bloquea (exit 2) las operaciones git destructivas, incl. bypasses comunes", () => {
    for (const command of [
      "git reset --hard HEAD~1",
      "git reset",
      "git clean -fd",
      "git checkout -- src/foo.ts",
      "git restore src/foo.ts",
      "git switch --discard-changes main",
      "git push --force origin main",
      "git push origin main --force-with-lease", // flag posicional
      "git push -f",
      "git push -fq origin", // short flag agrupado
      "git push origin +main", // refspec con + fuerza
      "cd packages/app && git reset --hard", // comando compuesto
      "git -C /repo reset --hard", // opción global -C antes del subcomando
      "git -c core.editor=vim reset --hard", // opción global -c
      "git --git-dir=.git checkout -- .", // opción global --git-dir
      "git checkout .", // descarta todo el working tree
      "git checkout HEAD -- .", // descarta con tree-ish explícito
      "git checkout -f main", // -f fuerza el descarte
    ]) {
      expect(runGuard(withCommand(command)).code, command).toBe(2);
    }
  });

  it("permite (exit 0) git seguro y comandos no-git (sin falsos positivos)", () => {
    for (const command of [
      "git status",
      "git diff",
      "git add -A && git commit -m 'wip'",
      'git commit -m "reset the broken flow"', // 'reset' dentro del mensaje, no es el subcomando
      "git checkout -b feature/x",
      "git checkout feature/x", // rama con slash, no es una ruta de descarte
      "git checkout --quiet main", // '--quiet' es flag, no separador de descarte
      "git switch main",
      "git push origin main",
      "pnpm test",
    ]) {
      expect(runGuard(withCommand(command)).code, command).toBe(0);
    }
  });

  it("normaliza command en forma de array (argv) y lo evalúa", () => {
    const payload = JSON.stringify({ tool_input: { command: ["git", "reset", "--hard", "HEAD~1"] } });
    expect(runGuard(payload).code).toBe(2);
  });

  it("también lee el comando del campo 'script' (tool PowerShell)", () => {
    expect(runGuard(JSON.stringify({ tool_input: { script: "git reset --hard" } })).code).toBe(2);
    expect(runGuard(JSON.stringify({ tool_input: { script: "git status" } })).code).toBe(0);
  });

  it("al bloquear, escribe un mensaje en stderr (motivo para el agente)", () => {
    const result = runGuard(withCommand("git reset --hard"));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/destructive git/i);
  });

  it("fail-open: payload ilegible o sin comando no bloquea (exit 0)", () => {
    expect(runGuard("no es json").code).toBe(0);
    expect(runGuard("{}").code).toBe(0);
    expect(runGuard(withCommand("   ")).code).toBe(0);
  });
});

describe("planAgents: resuelve {{SCRIPTS_DIR}} en el frontmatter del agente", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-scriptsdir-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("el hook del implementer apunta a la ruta real de scripts, sin placeholder", () => {
    const ctx: InstallContext = { stackDir: stackRoot(), configDir: tmp, engramBin: null, models: MODELS, warnings: [] };
    const actions = planAgents(claudeCodeAdapter, ctx);
    const implementer = actions.find((a) => a.kind === "write" && a.target.endsWith(`implementer.md`));
    expect(implementer).toBeDefined();
    const content = (implementer as { content: string }).content;

    const expectedScripts = path.join(tmp, "scripts").replace(/\\/g, "/");
    expect(content).not.toContain("{{SCRIPTS_DIR}}");
    expect(content).toContain(`${expectedScripts}/${GIT_GUARD_SCRIPT}`);
    expect(content).toContain("PreToolUse:");
  });
});
