import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stackRoot } from "../src/lib/paths.js";
import { loadCanonicalHooks } from "../src/lib/canonical.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import type { FileAction } from "../src/adapters/types.js";

const SCRIPT = path.join(stackRoot(), "scripts", "repair-worktree-config.cjs");
const SCRIPT_NAME = "repair-worktree-config.cjs";
const toSlash = (value: string) => value.replace(/\\/g, "/");

/** git en un cwd; lanza si falla (pasos de arrange). */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** git --get que devuelve null cuando la clave no existe (aserciones). */
function gitGet(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Ejecuta el guardián como lo haría un hook. `payload` = JSON de stdin (default "{}"),
 *  `env` para simular git ausente del PATH. node por ruta absoluta (independiente del PATH). */
function runRepair(cwd: string, opts: { payload?: unknown; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const input = opts.payload === undefined ? "{}" : JSON.stringify(opts.payload);
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@t.test"], dir);
  git(["config", "user.name", "Tester"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hi");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
}

const addWorktree = (repo: string, wtPath: string) =>
  git(["worktree", "add", "-q", "--detach", wtPath, "HEAD"], repo);
const sharedConfig = (repo: string) => path.join(repo, ".git", "config");
const worktreeConfig = (repo: string, name: string) =>
  path.join(repo, ".git", "worktrees", name, "config.worktree");

describe("repair-worktree-config guard", () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-repair-"));
    repo = path.join(tmp, "repo");
    initRepo(repo);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("quita core.worktree por-worktree (config.worktree) y restaura el toplevel", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "bogus"))], wt);
    expect(gitGet(["config", "--worktree", "--get", "core.worktree"], wt)).toBeTruthy();

    const { stdout } = runRepair(wt);

    expect(gitGet(["config", "--worktree", "--get", "core.worktree"], wt)).toBeNull();
    const top = toSlash(git(["rev-parse", "--show-toplevel"], wt)).toLowerCase();
    expect(top.endsWith("/wt")).toBe(true); // vuelve a apuntar al worktree, no al bogus
    expect(stdout).toContain("core.worktree(wt)");
  });

  it("quita core.worktree del config compartido (sin worktreeConfig)", () => {
    addWorktree(repo, path.join(tmp, "wt")); // el gate exige worktrees enlazados
    git(["config", "core.worktree", toSlash(path.join(tmp, "bogus"))], repo);
    expect(gitGet(["config", "--local", "--get", "core.worktree"], repo)).toBeTruthy();

    runRepair(repo);

    expect(gitGet(["config", "--local", "--get", "core.worktree"], repo)).toBeNull();
  });

  it("fuerza core.bare=false en el repo principal si quedó en true", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    git(["config", "core.bare", "true"], repo);

    const { stdout } = runRepair(wt); // desde el worktree: resuelve limpio pese al bare del principal

    expect(gitGet(["config", "--file", sharedConfig(repo), "--get", "core.bare"], tmp)).toBe("false");
    expect(stdout).toContain("core.bare");
  });

  it("repara core.bare y core.worktree a la vez en una sola pasada", () => {
    const wt1 = path.join(tmp, "wt1");
    const wt2 = path.join(tmp, "wt2");
    addWorktree(repo, wt1);
    addWorktree(repo, wt2);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "bogus"))], wt1);
    git(["config", "core.bare", "true"], repo); // inerte con worktreeConfig, pero el script lo limpia

    const { stdout } = runRepair(wt2); // worktree limpio: resolución sin problemas

    expect(gitGet(["config", "--file", sharedConfig(repo), "--get", "core.bare"], tmp)).toBe("false");
    expect(gitGet(["config", "--file", worktreeConfig(repo, "wt1"), "--get", "core.worktree"], tmp)).toBeNull();
    expect(stdout).toContain("core.bare");
    expect(stdout).toContain("core.worktree(wt1)");
  });

  it("repara varios worktrees envenenados en una sola pasada", () => {
    const wt1 = path.join(tmp, "wt1");
    const wt2 = path.join(tmp, "wt2");
    addWorktree(repo, wt1);
    addWorktree(repo, wt2);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "b1"))], wt1);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "b2"))], wt2);

    const { stdout } = runRepair(repo);

    expect(gitGet(["config", "--file", worktreeConfig(repo, "wt1"), "--get", "core.worktree"], tmp)).toBeNull();
    expect(gitGet(["config", "--file", worktreeConfig(repo, "wt2"), "--get", "core.worktree"], tmp)).toBeNull();
    expect(stdout).toContain("core.worktree(wt1)");
    expect(stdout).toContain("core.worktree(wt2)");
  });

  it("con dos worktrees, solo toca el envenenado (el limpio queda intacto)", () => {
    const dirty = path.join(tmp, "dirty");
    const clean = path.join(tmp, "clean");
    addWorktree(repo, dirty);
    addWorktree(repo, clean);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "bogus"))], dirty);

    const { stdout } = runRepair(repo);

    expect(gitGet(["config", "--file", worktreeConfig(repo, "dirty"), "--get", "core.worktree"], tmp)).toBeNull();
    expect(stdout).toContain("core.worktree(dirty)");
    expect(stdout).not.toContain("core.worktree(clean)");
  });

  it("honra el directorio del payload (caso OpenCode: cwd = dir de config, proyecto en stdin)", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "bogus"))], wt);

    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "jx-cfgdir-")); // simula ~/.config/opencode (no es repo)
    try {
      const { stdout } = runRepair(elsewhere, { payload: { tool: "bash", directory: wt } });
      expect(gitGet(["config", "--worktree", "--get", "core.worktree"], wt)).toBeNull();
      expect(stdout).toContain("core.worktree(wt)");
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("gate: un repo SIN worktrees no se toca aunque tenga core.worktree", () => {
    git(["config", "core.worktree", toSlash(path.join(tmp, "bogus"))], repo);

    const { stdout } = runRepair(repo);

    expect(gitGet(["config", "--local", "--get", "core.worktree"], repo)).toBeTruthy(); // intacto
    expect(stdout.trim()).toBe("");
  });

  it("no toca un config.worktree que existe pero no tiene core.worktree", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    const cw = worktreeConfig(repo, "wt");
    fs.writeFileSync(cw, "[core]\n\tlongpaths = true\n");

    const { stdout } = runRepair(wt);

    expect(stdout.trim()).toBe("");
    expect(fs.readFileSync(cw, "utf8")).toContain("longpaths");
  });

  it("es idempotente: re-ejecutar tras reparar no vuelve a emitir salida", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", "--worktree", "core.worktree", toSlash(path.join(tmp, "bogus"))], wt);

    expect(runRepair(wt).stdout).toContain("core.worktree");
    expect(runRepair(wt).stdout.trim()).toBe(""); // segunda pasada: nada que reparar
  });

  it("no-op silencioso (sin salida) si no hay nada que reparar", () => {
    addWorktree(repo, path.join(tmp, "wt"));
    expect(runRepair(repo).stdout.trim()).toBe("");
  });

  it("fail-open: fuera de un repo git no lanza y no repara nada", () => {
    const { stdout, status } = runRepair(tmp); // tmp no es un repo
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("fail-open diagnosticable: git ausente del PATH avisa en stderr, exit 0, sin reparar", () => {
    const wt = path.join(tmp, "wt");
    addWorktree(repo, wt);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-nogit-"));
    try {
      const { stdout, stderr, status } = runRepair(wt, { env: { ...process.env, PATH: emptyDir } });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("");
      expect(stderr.toLowerCase()).toContain("git");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
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
  const writeContent = (actions: FileAction[], suffix: string) =>
    (actions.find((a) => a.kind === "write" && a.target.endsWith(suffix)) as { content: string } | undefined)?.content ?? "";
  const copiesScript = (actions: FileAction[]) =>
    actions.some((a) => a.kind === "copy" && a.target.endsWith(SCRIPT_NAME));

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

  it("opencode: migra el filtro antiguo del mismo script sin duplicarlo ni borrar scripts de usuario", () => {
    fs.writeFileSync(path.join(cfg, "hooks.json"), JSON.stringify({
      "tool.execute.after": {
        bash: {
          "gh pr create": ["scripts/post-pr-review.cjs", "scripts/user.cjs"],
          "user command": ["scripts/user-only.cjs"],
        },
      },
    }));

    const actions = opencodeAdapter.planHooks(loadCanonicalHooks(stackRoot()), makeCtx("opencode"));
    const parsed = JSON.parse(writeContent(actions, "hooks.json"));
    const bash = parsed["tool.execute.after"].bash;

    expect(bash["gh pr create"]).toEqual(["scripts/user.cjs"]);
    expect(bash["gh"]).toContain("scripts/post-pr-review.cjs");
    expect(bash["user command"]).toEqual(["scripts/user-only.cjs"]);
    expect(Object.values(bash).flat().filter((script) => script === "scripts/post-pr-review.cjs")).toHaveLength(1);
  });
});
