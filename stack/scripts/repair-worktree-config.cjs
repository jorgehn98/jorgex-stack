#!/usr/bin/env node
// Repara la config de git que el harness de worktrees de los agentes puede dejar
// corrupta cuando hay varios worktrees activos en la misma sesion:
//   - core.bare=true en el repo principal  -> rompe rev-parse --show-toplevel / marca (bare)
//   - core.worktree apuntando a OTRO worktree -> show-toplevel/status/add operan sobre
//     el working-tree equivocado (branch/HEAD/git-dir siguen correctos: sintoma enganoso)
//
// Un worktree estandar NUNCA necesita core.worktree, asi que quitarlo siempre es seguro.
// Cross-agent (Claude Code / Codex / OpenCode) y cross-platform: node puro, sin deps.
// Idempotente, INDEPENDIENTE del cwd (opera con --file sobre rutas absolutas),
// fail-open y exit 0 SIEMPRE (un guardian nunca debe bloquear una tool).

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Ejecuta git y devuelve stdout recortado, o null si falla (fail-open). */
function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** .git comun (compartido por todos los worktrees). Fiable aun con core.worktree
 *  envenenado: este afecta al work-tree, no al git-dir. */
function gitCommonDir() {
  const abs = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (abs) return abs;
  const rel = git(["rev-parse", "--git-common-dir"]);
  return rel ? path.resolve(rel) : null;
}

function unsetIfPresent(file, repaired, label) {
  if (git(["config", "--file", file, "--get", "core.worktree"])) {
    git(["config", "--file", file, "--unset-all", "core.worktree"]);
    repaired.push(`core.worktree(${label})`);
  }
}

function main() {
  const common = gitCommonDir();
  if (!common || !fs.existsSync(common)) return; // no es un repo git -> no-op

  const sharedCfg = path.join(common, "config");
  const repaired = [];

  // 1) core.bare -> false si quedo en true
  if (git(["config", "--file", sharedCfg, "--get", "core.bare"]) === "true") {
    git(["config", "--file", sharedCfg, "core.bare", "false"]);
    repaired.push("core.bare(shared)");
  }

  // 2) core.worktree en el config compartido (caso sin extensions.worktreeConfig)
  unsetIfPresent(sharedCfg, repaired, "shared");

  // 3) core.worktree en cada config.worktree por-worktree (caso worktreeConfig activo)
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(common, "worktrees"), { withFileTypes: true });
  } catch {
    /* repo sin worktrees enlazados */
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const cw = path.join(common, "worktrees", entry.name, "config.worktree");
    if (fs.existsSync(cw)) unsetIfPresent(cw, repaired, entry.name);
  }

  if (repaired.length > 0) {
    process.stdout.write(`[repair-worktree-config] reparado: ${repaired.join(", ")}\n`);
  }
}

try {
  main();
} catch {
  /* fail-open: un fallo del guardian nunca debe bloquear la tool */
}
process.exit(0);
