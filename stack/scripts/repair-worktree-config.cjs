#!/usr/bin/env node
// Repara la config de git que el harness de worktrees de los agentes puede dejar
// corrupta cuando hay varios worktrees activos en la misma sesion:
//   - core.bare=true en el repo principal  -> rompe rev-parse --show-toplevel / marca (bare)
//   - core.worktree apuntando a OTRO worktree -> show-toplevel/status/add operan sobre
//     el working-tree equivocado (branch/HEAD/git-dir siguen correctos: sintoma enganoso)
//
// GATE DE ALCANCE: el bug SOLO lo causa el harness de worktrees, asi que este guardian
// solo actua en repos con worktrees ENLAZADOS. Un repo normal (o uno con layout legitimo
// --separate-git-dir sin worktrees) NUNCA se toca, aunque el hook se publique y corra en
// cada tool call de cualquier repo.
//
// El directorio del proyecto se toma del payload de stdin (data.cwd/directory/
// activeWorktreePath), igual que post-pr-review.cjs: en OpenCode el hook se ejecuta con
// cwd = dir de config, no el del proyecto, asi que fiarse de process.cwd() no repararia
// el repo correcto. Fallback a process.cwd() (Claude Code / Codex ya corren ahi).
//
// Cross-agent (Claude Code / Codex / OpenCode) y cross-platform: node puro, sin deps.
// Idempotente, INDEPENDIENTE del cwd de escritura (opera con --file sobre rutas absolutas),
// fail-open y exit 0 SIEMPRE (un guardian nunca debe bloquear una tool). Como el guardian
// hermano (block-destructive-git.cjs), un fail-open deja rastro en stderr para ser diagnosticable.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TAG = "[repair-worktree-config]";

/** Ejecuta git en `cwd` y devuelve stdout recortado, o null si falla (fail-open). */
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd: cwd || undefined,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Diagnostico a stderr (no bloquea): un no-op/fallo silencioso es indetectable. */
function warn(message) {
  try {
    process.stderr.write(`${TAG} ${message}\n`);
  } catch {
    /* stderr cerrado: no hay nada que hacer */
  }
}

/** .git comun (compartido por todos los worktrees). Fiable aun con core.worktree
 *  envenenado: este afecta al work-tree, no al git-dir. */
function gitCommonDir(cwd) {
  const abs = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (abs) return abs;
  const rel = git(["rev-parse", "--git-common-dir"], cwd);
  return rel ? path.resolve(cwd, rel) : null;
}

/** Quita core.worktree de `file` si esta puesto. Devuelve la etiqueta reparada o null.
 *  Verifica el resultado: un unset fallido se avisa por stderr y NO se reporta reparado.
 *  Las ops --file son independientes del cwd (rutas absolutas). */
function unsetWorktree(file, label) {
  if (!git(["config", "--file", file, "--get", "core.worktree"])) return null;
  if (git(["config", "--file", file, "--unset-all", "core.worktree"]) === null) {
    warn(`fallo al quitar core.worktree(${label}) - sigue puesto en ${file}`);
    return null;
  }
  return `core.worktree(${label})`;
}

function repair(cwd) {
  const common = gitCommonDir(cwd);
  if (!common) {
    // Distinguir "git no disponible" de "no es un repo": un guardian muerto por
    // falta de git seria un no-op PERMANENTE e invisible en cada tool call.
    if (git(["--version"], cwd) === null) {
      warn("git no esta disponible en el PATH - el guardian no puede reparar");
    }
    return;
  }
  if (!fs.existsSync(common)) return;

  // Gate de alcance: solo repos con worktrees enlazados (donde el bug es posible).
  let entries = [];
  try {
    entries = fs
      .readdirSync(path.join(common, "worktrees"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    /* repo sin worktrees enlazados */
  }
  if (entries.length === 0) return;

  const sharedCfg = path.join(common, "config");
  const repaired = [];

  // 1) core.bare -> false si quedo en true. Solo en layout normal (.git): nunca
  //    tocamos un repo genuinamente bare (cuyo git-dir no se llama ".git").
  if (
    path.basename(common) === ".git" &&
    git(["config", "--file", sharedCfg, "--get", "core.bare"]) === "true"
  ) {
    if (git(["config", "--file", sharedCfg, "core.bare", "false"]) === null) {
      warn(`fallo al forzar core.bare=false en ${sharedCfg}`);
    } else {
      repaired.push("core.bare(shared)");
    }
  }

  // 2) core.worktree en el config compartido (caso sin extensions.worktreeConfig)
  const shared = unsetWorktree(sharedCfg, "shared");
  if (shared) repaired.push(shared);

  // 3) core.worktree en cada config.worktree por-worktree (caso worktreeConfig activo)
  for (const entry of entries) {
    const cw = path.join(common, "worktrees", entry.name, "config.worktree");
    if (!fs.existsSync(cw)) continue;
    const perWorktree = unsetWorktree(cw, entry.name);
    if (perWorktree) repaired.push(perWorktree);
  }

  if (repaired.length > 0) {
    process.stdout.write(`${TAG} reparado: ${repaired.join(", ")}\n`);
  }
}

/** Directorio del proyecto desde el payload del hook; fallback a process.cwd(). */
function resolveCwd(data) {
  const candidate =
    data && (data.activeWorktreePath || data.worktreePath || data.cwd || data.directory);
  return typeof candidate === "string" && candidate ? candidate : process.cwd();
}

function run(data) {
  try {
    repair(resolveCwd(data));
  } catch (error) {
    // fail-open: nunca bloquear una tool, pero deja rastro del fallo del propio guardian.
    warn(`error inesperado: ${error && error.message ? error.message : String(error)}`);
  }
  process.exit(0);
}

// Los 3 runtimes entregan el payload del hook por stdin (JSON). Sin stdin (ejecucion
// manual/TTY) no bloqueamos: reparamos contra process.cwd().
if (process.stdin.isTTY) {
  run({});
} else {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    let data = {};
    try {
      data = JSON.parse(raw || "{}");
    } catch {
      data = {};
    }
    run(data);
  });
  process.stdin.on("error", () => run({}));
}
