import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stackRoot } from "../src/lib/paths.js";
import { loadCanonicalHooks } from "../src/lib/canonical.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import type { FileAction } from "../src/adapters/types.js";

const SCRIPT_NAME = "repair-worktree-config.cjs";
const writeContent = (actions: FileAction[], suffix: string) =>
  (actions.find((a) => a.kind === "write" && a.target.endsWith(suffix)) as { content: string } | undefined)?.content ?? "";
const copiesScript = (actions: FileAction[]) =>
  actions.some((a) => a.kind === "copy" && a.target.endsWith(SCRIPT_NAME));

const SCRIPT = path.join(stackRoot(), "scripts", "repair-worktree-config.cjs");
const toSlash = (value: string) => value.replace(/\\/g, "/");

/** git en un cwd; lanza si falla. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** git --get que devuelve null cuando la clave no existe (exit 1/5). */
function gitGet(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Ejecuta el guardián como lo haría el hook (stdin JSON, que el script ignora). */
function runRepair(cwd: string): string {
  return execFileSync("node", [SCRIPT], { cwd, input: "{}", encoding: "utf8" });
}

describe("repair-worktree-config guard", () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-repair-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Tester"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "init"], repo);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("quita core.worktree por-worktree (config.worktree) y restaura el toplevel", () => {
    const wt = path.join(tmp, "wt");
    git(["worktree", "add", "-q", "--detach", wt, "HEAD"], repo);
    git(["config", "extensions.worktreeConfig", "true"], repo);

    const bogus = toSlash(path.join(tmp, "bogus"));
    git(["config", "--worktree", "core.worktree", bogus], wt);

    // El bug: el toplevel del worktree resuelve al path envenenado, no a wt.
    const topBefore = git(["rev-parse", "--show-toplevel"], wt);
    expect(gitGet(["config", "--worktree", "--get", "core.worktree"], wt)).toBeTruthy();

    const out = runRepair(wt);

    expect(gitGet(["config", "--worktree", "--get", "core.worktree"], wt)).toBeNull();
    expect(git(["rev-parse", "--show-toplevel"], wt)).not.toBe(topBefore);
    expect(out).toContain("core.worktree");
  });

  it("quita core.worktree del config compartido (sin worktreeConfig)", () => {
    const bogus = toSlash(path.join(tmp, "bogus"));
    git(["config", "core.worktree", bogus], repo);
    expect(gitGet(["config", "--local", "--get", "core.worktree"], repo)).toBeTruthy();

    runRepair(repo);

    expect(gitGet(["config", "--local", "--get", "core.worktree"], repo)).toBeNull();
  });

  it("fuerza core.bare=false en el repo principal si quedó en true", () => {
    git(["config", "core.bare", "true"], repo);
    const out = runRepair(repo);
    expect(git(["config", "--get", "core.bare"], repo)).toBe("false");
    expect(out).toContain("core.bare");
  });

  it("no-op silencioso (sin salida) si no hay nada que reparar", () => {
    const out = runRepair(repo);
    expect(out.trim()).toBe("");
  });

  it("fail-open: fuera de un repo git no lanza y no repara nada", () => {
    let out = "";
    expect(() => {
      out = runRepair(tmp);
    }).not.toThrow();
    expect(out.trim()).toBe("");
  });
});

describe("repair-worktree-config: cableado en los 3 runtimes", () => {
  let cfg: string;
  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "jx-repair-wire-"));
  });
  afterEach(() => {
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  const makeCtx = (id: "claude-code" | "codex" | "opencode") => ({
    stackDir: stackRoot(),
    configDir: cfg,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[id]!,
    warnings: [] as string[],
  });

  it("claude code: hook en settings.json + script copiado", () => {
    const actions = claudeCodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), makeCtx("claude-code"));
    expect(writeContent(actions, "settings.json")).toContain(SCRIPT_NAME);
    expect(copiesScript(actions)).toBe(true);
  });

  it("codex: hook en hooks.json (matcher 'shell') + script copiado", () => {
    const actions = codexAdapter.planHooks(loadCanonicalHooks(stackRoot()), makeCtx("codex"));
    const content = writeContent(actions, "hooks.json");
    expect(content).toContain(SCRIPT_NAME);
    expect(content).toContain('"shell"');
    expect(copiesScript(actions)).toBe(true);
  });

  it("opencode: hook bajo tool.execute.after.bash['*'] + script copiado", () => {
    const actions = opencodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), makeCtx("opencode"));
    const parsed = JSON.parse(writeContent(actions, "hooks.json"));
    expect(parsed["tool.execute.after"].bash["*"]).toContain(`scripts/${SCRIPT_NAME}`);
    expect(copiesScript(actions)).toBe(true);
  });
});
