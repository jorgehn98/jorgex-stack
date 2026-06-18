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

/** Lanza el guard con un payload de stdin y devuelve su exit code (2 = bloqueado). */
function runGuard(stdin: string): number {
  try {
    execFileSync("node", [SCRIPT], { input: stdin, stdio: ["pipe", "pipe", "pipe"] });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

const withCommand = (command: string) => JSON.stringify({ tool_input: { command } });

describe("block-destructive-git guard", () => {
  it("bloquea (exit 2) las operaciones git destructivas", () => {
    for (const command of [
      "git reset --hard HEAD~1",
      "git reset",
      "git clean -fd",
      "git checkout -- src/foo.ts",
      "git restore src/foo.ts",
      "git push --force origin main",
      "git push origin main --force-with-lease",
      "git push -f",
      "cd packages/app && git reset --hard", // comando compuesto: el guard ve la cadena completa
    ]) {
      expect(runGuard(withCommand(command)), command).toBe(2);
    }
  });

  it("permite (exit 0) git seguro y comandos no-git", () => {
    for (const command of [
      "git status",
      "git diff",
      "git add -A && git commit -m 'wip'",
      "git checkout -b feature/x",
      "git checkout --quiet main", // '--' como flag, no como separador de descarte
      "git push origin main",
      "pnpm test",
    ]) {
      expect(runGuard(withCommand(command)), command).toBe(0);
    }
  });

  it("fail-open: payload ilegible o sin comando no bloquea (exit 0)", () => {
    expect(runGuard("no es json")).toBe(0);
    expect(runGuard("{}")).toBe(0);
    expect(runGuard(withCommand("   "))).toBe(0);
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
