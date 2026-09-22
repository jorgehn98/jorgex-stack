import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBackup, restoreBackup } from "./backup.js";
import { isContainedIn } from "./fsx.js";
import { HOME } from "./paths.js";

/**
 * Coordinador común de `engram setup` oficial.
 *
 * Solo install real ejecuta setup (nunca sync/dry-run/target-dir/uninstall/
 * doctor). Secuencia por runtime independiente: backup → setup → verifier;
 * un fallo intenta restaurar los preexistentes, elimina los targets creados
 * por el setup y no transfiere ownership; si no puede recomponer todo, lo
 * informa. Subprocess con argv fijo, sin shell, un único intento y
 * stdout/stderr capturados. Nunca toca `~/.engram` ni el binario existente.
 *
 * Los verificadores específicos por runtime se registran vía
 * `registerOfficialSetupVerifier`; sin verificador, un install real falla
 * cerrado y los modos que no mutan siguen omitiendo el setup.
 */

/**
 * Parche de entorno para el subprocess oficial.
 *
 * Una clave presente con valor `undefined` se elimina del entorno hijo;
 * `spawnOfficialSetupBin` aplica esta semántica en lugar de serializarla como
 * `"undefined"`.
 */
export type OfficialSetupEnvPatch = Record<string, string | undefined>;

export type OfficialSetupRuntime = "claude-code" | "codex" | "opencode" | "pi";

export const OFFICIAL_SETUP_RUNTIMES: readonly OfficialSetupRuntime[] = [
  "claude-code",
  "codex",
  "opencode",
  "pi",
] as const;

export function isOfficialSetupRuntime(runtime: string): runtime is OfficialSetupRuntime {
  return (OFFICIAL_SETUP_RUNTIMES as readonly string[]).includes(runtime);
}

/** Argv fijo del setup oficial; sin aliases (`claude` no existe). */
export function resolveOfficialSetupArgv(runtime: string): string[] {
  switch (runtime) {
    case "claude-code":
      return ["setup", "claude-code"];
    case "codex":
      return ["setup", "codex"];
    case "opencode":
      return ["setup", "opencode"];
    case "pi":
      return ["setup", "pi"];
    default:
      throw new Error(`Runtime setup oficial desconocido: ${runtime}.`);
  }
}

/** Gate install-only: solo install real (sin dry-run ni target-dir). */
export function shouldRunOfficialSetup(opts: {
  command?: string;
  dryRun?: boolean;
  targetDir?: string | undefined;
}): boolean {
  return opts.command === "install" && opts.dryRun === false && opts.targetDir === undefined;
}

export interface OfficialSetupSpawnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface OfficialSetupVerifyResult {
  ok: boolean;
  layers?: string[];
  ownershipTransferred?: boolean;
  reason?: string;
  stderr?: string;
}

export interface OfficialSetupDeps {
  homeDir: string;
  engramBin: string;
  backup: () => Promise<{ id: string }>;
  spawn: (bin: string, argv: string[], options: { shell: false; env?: OfficialSetupEnvPatch }) => Promise<OfficialSetupSpawnResult>;
  verify: () => Promise<OfficialSetupVerifyResult>;
  restore?: () => Promise<unknown>;
  /** Ficheros que el setup puede crear/modificar. Obligatorio y no vacío. */
  targets: string[];
}

/**
 * Snapshot recursivo de un directorio target (solo descendientes, rutas
 * absolutas). Devuelve null si el árbol no puede leerse (desconocido,
 * fail-closed: no borrar a ciegas).
 */
function snapshotDirEntries(dir: string): Set<string> | null {
  const out = new Set<string>();
  try {
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.resolve(path.join(current, entry.name));
        out.add(full);
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(path.resolve(dir));
    return out;
  } catch {
    return null;
  }
}

function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code as string
    : "UNKNOWN";
}

/**
 * Raíz npm trusted solo para runtime Pi (provider-owned `<configDir>/npm`).
 * Otros runtimes devuelven vacío y conservan rechazo total. Se identifica por
 * basename `npm` entre los targets explícitos ya contenidos en HOME.
 */
function resolveTrustedNpmRoots(runtime: string, preciseTargets: string[]): string[] {
  if (runtime !== "pi") return [];
  const roots = new Set<string>();
  for (const t of preciseTargets) {
    const resolved = path.resolve(t);
    if (path.basename(resolved) === "npm") roots.add(resolved);
  }
  return [...roots];
}

function findTrustedRootFor(linkPath: string, trustedRoots: string[]): string | null {
  const resolved = path.resolve(linkPath);
  for (const root of trustedRoots) {
    if (isContainedIn(resolved, root)) return root;
  }
  return null;
}

/**
 * Valida un symlink bajo npm trusted: solo relativo cuyo destino lógico queda
 * bajo la misma raíz y cuyo realpath resuelve sin roto/ciclo y permanece
 * dentro. Absolutos, escapes, rotos y ciclos son violación. Todo mensaje
 * incluye `symlink` más la causa (escape/fuera, roto/broken, ciclo/cycle/loop,
 * ilegible) para fail-closed accionable.
 */
function validateTrustedNpmSymlink(linkPath: string, trustedRoots: string[]): string | null {
  const resolvedLink = path.resolve(linkPath);
  const root = findTrustedRootFor(resolvedLink, trustedRoots);
  if (root === null) return `${resolvedLink}: symlink fuera de npm trusted (rechazado)`;
  let raw: string;
  try {
    raw = fs.readlinkSync(resolvedLink);
  } catch (error) {
    return `${resolvedLink}: symlink ilegible (${errnoCode(error)}, no se puede descartar alias)`;
  }
  if (path.isAbsolute(raw)) {
    return `${resolvedLink}: symlink absoluto con escape fuera de npm trusted (rechazado)`;
  }
  const logical = path.resolve(path.dirname(resolvedLink), raw);
  if (logical !== root && !isContainedIn(logical, root)) {
    return `${resolvedLink}: symlink con escape fuera de npm trusted (${raw}, rechazado)`;
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolvedLink);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") {
      return `${resolvedLink}: symlink roto/broken hacia ${raw} (rechazado, no resuelve)`;
    }
    if (code === "ELOOP" || code === "EAGAIN" || code === "ENAMETOOLONG") {
      return `${resolvedLink}: symlink con ciclo/cycle/loop hacia ${raw} (rechazado)`;
    }
    return `${resolvedLink}: symlink ilegible (${code}, no se puede descartar alias)`;
  }
  if (canonical !== root && !isContainedIn(canonical, root)) {
    return `${resolvedLink}: symlink con escape fuera de npm trusted tras resolver (rechazado)`;
  }
  return null;
}

/**
 * Recorre un árbol existente sin seguir symlinks (lstat en cada entrada).
 * Devuelve la primera entrada symlink/ilegible, o null si está limpio.
 * Con raíces trusted (solo Pi+npm), un symlink relativo interno cuyo destino
 * lógico y canónico permanecen bajo la raíz se permite; el resto falla
 * cerrado. Best-effort contra TOCTOU: solo reduce la ventana, no la elimina;
 * el resultado se revalida antes de restore/cleanup y todo fallo es incompleto.
 */
function findSymlinkInTree(root: string, trustedRoots: string[] = []): string | null {
  const resolvedRoot = path.resolve(root);
  try {
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
      return `${resolvedRoot}: el target es un symlink (no se respalda ni se ejecuta setup)`;
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      return `${resolvedRoot}: ilegible (${errnoCode(error)}, no se puede descartar alias)`;
    }
    return null;
  }
  const stack: string[] = [resolvedRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }) as fs.Dirent[];
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      return `${current}: ilegible (${errnoCode(error)}, no se puede descartar alias)`;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        return `${full}: ilegible (${errnoCode(error)}, no se puede descartar alias)`;
      }
      if (st.isSymbolicLink()) {
        if (trustedRoots.length > 0) {
          const allowed = validateTrustedNpmSymlink(full, trustedRoots);
          if (allowed === null) continue;
          return allowed;
        }
        return `${full}: es un symlink (no se sigue ni se copia)`;
      }
      if (st.isDirectory()) stack.push(full);
    }
  }
  return null;
}

/**
 * Snapshot de symlinks preexistentes bajo raíces trusted (path absoluto +
 * target textual exacto, sin seguir enlaces). Devuelve null si el árbol no
 * puede leerse (desconocido, fail-closed: sin restore a ciegas).
 */
function snapshotTrustedSymlinks(trustedRoots: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  try {
    for (const root of trustedRoots) {
      const resolvedRoot = path.resolve(root);
      try {
        if (fs.lstatSync(resolvedRoot).isSymbolicLink()) return null;
      } catch (error) {
        if (errnoCode(error) === "ENOENT") continue;
        return null;
      }
      let isDir = false;
      try {
        isDir = fs.statSync(resolvedRoot).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const stack: string[] = [resolvedRoot];
      while (stack.length > 0) {
        const current = stack.pop()!;
        let names: string[];
        try {
          names = fs.readdirSync(current);
        } catch (error) {
          if (errnoCode(error) === "ENOENT") continue;
          return null;
        }
        for (const name of names) {
          const full = path.join(current, name);
          let st: fs.Stats;
          try {
            st = fs.lstatSync(full);
          } catch (error) {
            if (errnoCode(error) === "ENOENT") continue;
            return null;
          }
          if (st.isSymbolicLink()) {
            try {
              out.set(path.resolve(full), fs.readlinkSync(full));
            } catch {
              return null;
            }
            continue;
          }
          if (st.isDirectory()) stack.push(full);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Restaura symlinks preexistentes (cambiados o borrados) a su target textual
 * original sin seguir enlaces. No elimina creados (lo hace el cleanup). Cada
 * escritura revalida contención trusted, target relativo interno y ancestros
 * sin alias (TOCTOU). Cualquier duda falla cerrado.
 */
function restoreTrustedSymlinks(
  snapshot: Map<string, string> | null,
  trustedRoots: string[],
): { ok: boolean; error?: string } {
  if (snapshot === null) {
    return { ok: false, error: "symlink snapshot ilegible (no se puede restaurar a ciegas)" };
  }
  for (const [linkPath, rawTarget] of snapshot) {
    const resolvedLink = path.resolve(linkPath);
    const root = findTrustedRootFor(resolvedLink, trustedRoots);
    if (root === null) {
      return { ok: false, error: `symlink ${resolvedLink} fuera de npm trusted (restore omitido)` };
    }
    if (path.isAbsolute(rawTarget)) {
      return { ok: false, error: `symlink ${resolvedLink} con target absoluto (restore omitido)` };
    }
    const logical = path.resolve(path.dirname(resolvedLink), rawTarget);
    const stop = path.resolve(root);
    if (logical !== stop && !isContainedIn(logical, stop)) {
      return { ok: false, error: `symlink ${resolvedLink} con escape fuera de npm trusted (restore omitido)` };
    }
    let dir = path.dirname(resolvedLink);
    let unsafe: string | null = null;
    while (true) {
      if (dir === stop) {
        try {
          if (fs.lstatSync(dir).isSymbolicLink()) unsafe = dir;
        } catch (error) {
          unsafe = errnoCode(error) === "ENOENT" ? `${dir}: raíz ausente` : `${dir}: ilegible`;
        }
        break;
      }
      if (!isContainedIn(dir, stop)) break;
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) {
          unsafe = dir;
          break;
        }
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          unsafe = `${dir}: ilegible`;
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (unsafe !== null) {
      return { ok: false, error: `symlink ${resolvedLink}: ancestro inseguro ${unsafe} (restore omitido)` };
    }
    try {
      // Mutación única: el pre-remove redundante previo al recheck del padre
      // se colapsa aquí (tras mkdir + recheck) para preservar TOCTOU con una
      // sola escritura; el estado final es idéntico (T48).
      fs.mkdirSync(path.dirname(resolvedLink), { recursive: true });
      try {
        if (fs.lstatSync(path.dirname(resolvedLink)).isSymbolicLink()) {
          return { ok: false, error: `symlink ${resolvedLink}: padre es symlink tras mkdir (restore omitido)` };
        }
      } catch (error) {
        return { ok: false, error: `symlink ${resolvedLink}: padre ilegible tras mkdir (${errnoCode(error)})` };
      }
      try {
        const re = fs.lstatSync(resolvedLink);
        if (re.isSymbolicLink()) {
          try {
            if (fs.readlinkSync(resolvedLink) === rawTarget) continue;
          } catch {
            // Releer falló: reintentar reemplazo seguro abajo.
          }
          fs.rmSync(resolvedLink, { recursive: true, force: true });
        } else {
          fs.rmSync(resolvedLink, { recursive: true, force: true });
        }
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          return { ok: false, error: `symlink ${resolvedLink} ilegible antes de recrear (${errnoCode(error)})` };
        }
      }
      try {
        fs.symlinkSync(rawTarget, resolvedLink);
      } catch (error) {
        return { ok: false, error: `symlink ${resolvedLink}: no se pudo restaurar target (${errnoCode(error)})` };
      }
    } catch (error) {
      return { ok: false, error: `symlink ${resolvedLink}: restore falló (${errnoCode(error)})` };
    }
  }
  return { ok: true };
}

/**
 * Valida que ningún target, ancestro existente ni entrada de árbol sea un
 * symlink (lstat, sin seguir) antes de mutar. Rechaza también lo ilegible
 * (no se puede descartar alias hacia fuera de HOME o ~/.engram). Devuelve la
 * primera violación o null si está limpio. La puerta léxica HOME se conserva
 * aparte; esto la complementa, no la sustituye. Con raíces trusted (solo
 * Pi+npm) los symlinks relativos internos contenidos se permiten; el resto
 * (absolutos, escapes, rotos, ciclos) y cualquier symlink fuera de npm
 * siguen rechazados.
 */
function findSetupSymlinkViolation(targets: string[], homeDir: string, trustedRoots: string[] = []): string | null {
  const homeResolved = path.resolve(homeDir);
  for (const target of targets) {
    const resolved = path.resolve(target);
    try {
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        return `${resolved}: el target es un symlink (no se respalda ni se ejecuta setup)`;
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        return `${resolved}: ilegible (${errnoCode(error)}, no se puede descartar alias)`;
      }
    }
    let dir = path.dirname(resolved);
    while (dir !== homeResolved && isContainedIn(dir, homeResolved)) {
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) {
          return `${dir}: ancestro existente es un symlink (no se atraviesa)`;
        }
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") {
          return `${dir}: ilegible (${errnoCode(error)}, no se puede descartar alias)`;
        }
        // Intermedio ausente: seguir ascendiendo; un symlink superior
        // existente debe detectarse igualmente.
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    try {
      if (fs.statSync(resolved).isDirectory()) {
        const bad = findSymlinkInTree(resolved, trustedRoots);
        if (bad !== null) return bad;
      }
    } catch {
      // Ausente o ilegible: el lstat previo ya dictaminó; sin árbol que mirar.
    }
  }
  return null;
}

export type OfficialSetupRecovery = "complete" | "incomplete" | "none";

export interface OfficialSetupResult {
  ok: boolean;
  ownershipTransferred: boolean;
  stdout?: string;
  stderr?: string;
  reason?: string;
  layers?: string[];
  /** true solo cuando el rollback no pudo recomponer todo lo mutado. */
  incompleteRecovery?: boolean;
  recovery?: OfficialSetupRecovery;
  backupId?: string | null;
  backupError?: string;
  restoreError?: string;
}

/**
 * Núcleo inyectable: backup → spawn (un intento, shell false) → verify.
 * Verify siempre se ejecuta tras el spawn (aunque el spawn falle) para
 * diagnosticar por capas; cualquier fallo intenta restaurar preexistentes,
 * elimina los targets explícitos creados por el setup y no transfiere
 * ownership.
 */
export async function runOfficialSetup(
  runtime: string,
  deps: OfficialSetupDeps,
): Promise<OfficialSetupResult> {
  if (typeof deps.engramBin !== "string" || !path.isAbsolute(deps.engramBin)) {
    throw new Error(`runOfficialSetup: engramBin absoluto requerido (runtime ${runtime}).`);
  }
  const argv = resolveOfficialSetupArgv(runtime);
  if (!Array.isArray(deps.targets) || deps.targets.length === 0) {
    throw new Error(`runOfficialSetup: targets explícitos no vacíos requeridos (runtime ${runtime}).`);
  }
  const preciseTargets = [...new Set(deps.targets.map((t) => path.resolve(t)))];
  const homeResolved = path.resolve(deps.homeDir);

  // Frontera de restore: ningún target fuera de homeDir puede recomponerse
  // con el restore acotado a HOME. Bloquear antes de cualquier mutación
  // (backup o spawn).
  const outside = preciseTargets.filter(
    (t) => path.resolve(t) !== homeResolved && !isContainedIn(t, homeResolved),
  );
  if (outside.length > 0) {
    const detail = `runOfficialSetup: target fuera de la frontera de restore (${homeResolved}): ${outside[0]}. Bloqueado antes del setup.`;
    return {
      ok: false,
      ownershipTransferred: false,
      stderr: detail,
      reason: detail,
      recovery: "none",
      backupId: null,
    };
  }

  // Raíz npm trusted solo para Pi: los symlinks relativos internos contenidos
  // se permiten; absolutos, escapes, rotos y ciclos siguen siendo violación.
  // Otros runtimes/targets conservan rechazo total (lista vacía).
  const trustedNpmRoots = resolveTrustedNpmRoots(runtime, preciseTargets);
  // Seguridad symlink (lstat, sin seguir): ni el target, ni un ancestro, ni
  // una entrada del árbol pueden ser alias hacia fuera de HOME o ~/.engram,
  // salvo closure npm interno trusted en Pi. Bloquea antes del backup: no se
  // respalda ni se ejecuta nada con alias no confiable.
  const preViolation = findSetupSymlinkViolation(preciseTargets, homeResolved, trustedNpmRoots);
  if (preViolation !== null) {
    const detail = `runOfficialSetup: symlink rechazado antes del setup (${preViolation}). Bloqueado antes del backup.`;
    return {
      ok: false,
      ownershipTransferred: false,
      stderr: detail,
      reason: detail,
      recovery: "none",
      backupId: null,
    };
  }

  let backupId: string | null = null;
  try {
    const backup = await deps.backup();
    backupId = (backup as { id?: unknown } | null)?.id !== undefined
      ? String((backup as { id: unknown }).id)
      : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ownershipTransferred: false,
      stderr: detail,
      reason: detail,
      recovery: "none",
      backupId: null,
      backupError: detail,
    };
  }

  // Existencia previa capturada tras el backup y antes del spawn.
  const existedBefore = new Set(preciseTargets.filter((t) => {
    try {
      return fs.existsSync(t);
    } catch {
      return false;
    }
  }));
  // Snapshot recursivo pre-spawn para directorios ya existentes (p.ej.
  // Claude `plugins/marketplaces/engram`): en fallo solo se eliminan los
  // descendientes nuevos, preservando/restaurando preexistentes.
  const dirSnapshots = new Map<string, Set<string> | null>();
  for (const t of preciseTargets) {
    if (!existedBefore.has(t)) continue;
    try {
      if (fs.statSync(t).isDirectory()) dirSnapshots.set(t, snapshotDirEntries(t));
    } catch {
      // stat ilegible: no snapshot; el cleanup marcará incompleto sin borrar.
      dirSnapshots.set(t, null);
    }
  }
  // Snapshot de symlinks trusted preexistentes (path + raw target, sin seguir):
  // el backup de ficheros no conserva metadata de symlink, así que la
  // transacción los restaura explícitamente. Nunca se excluye el árbol a
  // ciegas ni se sigue durante el snapshot (lstat).
  const trustedSymlinkSnapshot = snapshotTrustedSymlinks(trustedNpmRoots);

  let spawnResult: OfficialSetupSpawnResult;
  try {
    spawnResult = await deps.spawn(deps.engramBin, argv, { shell: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    spawnResult = { ok: false, stdout: "", stderr: detail };
  }

  let verifyResult: OfficialSetupVerifyResult;
  try {
    verifyResult = await deps.verify();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    verifyResult = { ok: false, reason: detail };
  }

  // Revalidación post-spawn antes de declarar éxito: si queda un symlink en un
  // target o en sus ancestros, el run no puede declararse ok aunque spawn y
  // verify lo indiquen. Es una comprobación best effort contra TOCTOU. En Pi
  // se permite el closure npm interno trusted (misma regla que pre-check).
  const postViolation = findSetupSymlinkViolation(preciseTargets, homeResolved, trustedNpmRoots);
  const tainted = new Set<string>();
  if (postViolation !== null) {
    for (const t of preciseTargets) {
      if (findSetupSymlinkViolation([t], homeResolved, trustedNpmRoots) !== null) tainted.add(t);
    }
  }
  const ok = spawnResult.ok === true && verifyResult.ok === true && postViolation === null;
  if (ok) {
    return {
      ok: true,
      ownershipTransferred: verifyResult.ownershipTransferred ?? true,
      stdout: spawnResult.stdout,
      stderr: spawnResult.stderr,
      ...(verifyResult.layers === undefined ? {} : { layers: verifyResult.layers }),
      recovery: "none",
      backupId,
    };
  }

  // Con una violación post-setup, se omiten restore y cleanup para ese target:
  // ambas operaciones podrían atravesar el enlace. El backupId orienta la
  // recuperación manual y el target exterior queda intacto.
  let restoreError: string | undefined;
  let restoreFailed = false;
  let symlinkRestoreFailed = false;
  let symlinkRestoreError: string | undefined;
  if (postViolation !== null) {
    restoreFailed = true;
    restoreError = `symlink post-setup (${postViolation}); restore omitido para no escribir a través del enlace`;
  } else {
    try {
      await deps.restore?.();
    } catch (error) {
      restoreFailed = true;
      restoreError = error instanceof Error ? error.message : String(error);
    }
    // Rollback de symlinks trusted: restaura cambiados/borrados a su target
    // textual original con revalidación TOCTOU; los creados los
    // elimina el cleanup. Solo complete si ficheros, symlinks y cleanup ok.
    if (trustedNpmRoots.length > 0) {
      const symRes = restoreTrustedSymlinks(trustedSymlinkSnapshot, trustedNpmRoots);
      if (!symRes.ok) {
        symlinkRestoreFailed = true;
        symlinkRestoreError = symRes.error;
      }
    } else if (trustedSymlinkSnapshot !== null && trustedSymlinkSnapshot.size > 0) {
      symlinkRestoreFailed = true;
      symlinkRestoreError = "symlink snapshot inesperado fuera de Pi (restore omitido)";
    }
  }
  // Rollback: recomponer preexistentes mediante restore cuando sea posible y
  // eliminar solo lo creado por el setup. En directorios ya existentes, solo
  // se eliminan descendientes nuevos (post-order), preservando preexistentes.
  // lstat (sin seguir) para cubrir también links rotos creados por el setup.
  let cleanupFailed = tainted.size > 0;
  for (const t of preciseTargets) {
    if (tainted.has(t)) continue;
    try {
      if (!existedBefore.has(t)) {
        try {
          fs.lstatSync(t);
          fs.rmSync(t, { recursive: true, force: true });
        } catch (error) {
          if (errnoCode(error) !== "ENOENT") cleanupFailed = true;
        }
        continue;
      }
      if (!dirSnapshots.has(t)) continue;
      const before = dirSnapshots.get(t);
      if (before === null || before === undefined) {
        cleanupFailed = true;
        continue;
      }
      const after = snapshotDirEntries(t);
      if (after === null) {
        cleanupFailed = true;
        continue;
      }
      const created = [...after].filter((p) => !before.has(p));
      created.sort((a, b) => {
        const depthA = a.split(path.sep).length;
        const depthB = b.split(path.sep).length;
        if (depthA !== depthB) return depthB - depthA;
        return b.length - a.length;
      });
      for (const p of created) {
        try {
          try {
            fs.lstatSync(p);
          } catch (error) {
            if (errnoCode(error) === "ENOENT") continue;
            cleanupFailed = true;
            continue;
          }
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }
    } catch {
      cleanupFailed = true;
    }
  }
  const incomplete = restoreFailed || symlinkRestoreFailed || cleanupFailed;
  const combinedRestoreError = [restoreError, symlinkRestoreError].filter((p) => p !== undefined).join("; ") || undefined;
  // restoreError visible conserva ambas causas (ficheros + symlinks).
  restoreError = combinedRestoreError;
  const detail =
    [spawnResult.stderr, verifyResult.stderr, verifyResult.reason, (verifyResult.layers ?? []).join(", ")]
      .map((part) => (part ?? "").trim())
      .filter((part) => part !== "")
      .join("; ") || "setup oficial falló";
  const recoveryDetail = incomplete
    ? `${detail}; recuperación incompleta${restoreError !== undefined ? `: ${restoreError}` : ""}`
    : detail;
  return {
    ok: false,
    ownershipTransferred: false,
    stdout: spawnResult.stdout,
    stderr: recoveryDetail,
    reason: recoveryDetail,
    ...(verifyResult.layers === undefined ? {} : { layers: verifyResult.layers }),
    ...(incomplete ? { incompleteRecovery: true as const } : {}),
    recovery: incomplete ? "incomplete" : "complete",
    backupId,
    ...(restoreError === undefined ? {} : { restoreError }),
  };
}

export type OfficialSetupVerifyFn = (args: {
  configDir: string;
  engramBin: string;
  /** HOME efectivo: el verificador Claude elige el MCP exacto según el modo. */
  homeDir?: string;
  /**
   * Modo explícito Claude: true cuando CLAUDE_CONFIG_DIR está definida
   * (aunque coincida con `<home>/.claude`) → anidado; false fuerza el modo
   * por defecto. Cuando se omite, el verificador consulta
   * `process.env.CLAUDE_CONFIG_DIR`.
   */
  isExplicitClaudeConfigDir?: boolean;
}) => Promise<OfficialSetupVerifyResult>;

/**
 * Modo Claude explícito: una variable definida —aunque sea igual a
 * `<home>/.claude`— implica el archivo anidado. Si se pasa `false`, o la
 * variable está ausente cuando se omite el argumento, se aplica la inferencia
 * por path.
 */
export function isExplicitClaudeConfigDirEnv(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.CLAUDE_CONFIG_DIR !== undefined;
}

/** Verificadores por runtime; cada adapter los registra al cargarse. */
export const officialSetupVerifiers: Partial<Record<OfficialSetupRuntime, OfficialSetupVerifyFn>> = {};

export function registerOfficialSetupVerifier(runtime: OfficialSetupRuntime, fn: OfficialSetupVerifyFn): void {
  officialSetupVerifiers[runtime] = fn;
}

/**
 * Candidatos de backup pre-setup por runtime (solo los existentes se
 * respaldan; `createBackup` ignora ausentes y devuelve null si no hay nada).
 * No incluye `~/.engram` ni el binario.
 *
 * Claude usa el archivo hermano `~/.claude.json` cuando no hay
 * `CLAUDE_CONFIG_DIR` explícita y el configDir es el predeterminado
 * (`<home>/.claude`); con la variable explícita, el setup oficial escribe
 * `configDir/.claude.json` aunque ambos paths coincidan.
 */
export function collectOfficialSetupBackupTargets(
  runtime: OfficialSetupRuntime,
  configDir: string,
  homeDir?: string,
  isExplicitClaudeConfigDir?: boolean,
): string[] {
  switch (runtime) {
    case "claude-code": {
      const explicit = isExplicitClaudeConfigDirEnv(isExplicitClaudeConfigDir);
      const pathIsDefault = homeDir !== undefined
        ? path.resolve(configDir) === path.resolve(path.join(homeDir, ".claude"))
        : path.basename(path.resolve(configDir)) === ".claude";
      // Explícito (env definida, aunque igual) siempre es custom; por defecto
      // solo cuando el env está ausente y el path coincide.
      const isDefault = !explicit && pathIsDefault;
      const nested = path.join(configDir, ".claude.json");
      const sibling = path.join(path.dirname(configDir), ".claude.json");
      const targets = [
        path.join(configDir, "settings.json"),
        path.join(configDir, "plugins", "installed_plugins.json"),
        path.join(configDir, "plugins", "known_marketplaces.json"),
        path.join(configDir, "plugins", "marketplaces", "engram"),
        path.join(configDir, "plugins", "cache", "engram"),
        path.join(configDir, "mcp", "engram.json"),
        // El MCP exacto puede estar en el archivo hermano (modo predeterminado)
        // o en la ruta anidada (modo explícito); se respaldan ambas ubicaciones.
        nested,
        // En el modo predeterminado se añade el archivo hermano efectivo
        // (`HOME/.claude.json`).
        ...(isDefault && path.resolve(sibling) !== path.resolve(nested) ? [sibling] : []),
      ];
      // Configuración personalizada dentro de HOME: el proveedor también puede
      // mutar el archivo hermano predeterminado (`~/.claude.json`). Se cubren
      // ambas ubicaciones para que una ejecución personalizada no deje el
      // predeterminado sin reversión. Sin homeDir no hay predeterminado
      // demostrable; no se amplía a la base de datos ni al binario.
      if (homeDir !== undefined && !isDefault) {
        const fallback = path.join(path.resolve(homeDir), ".claude.json");
        if (!targets.map((t) => path.resolve(t)).includes(path.resolve(fallback))) {
          targets.push(fallback);
        }
      }
      return [...new Set(targets)];
    }
    case "codex":
      return [
        path.join(configDir, "config.toml"),
        path.join(configDir, "engram-instructions.md"),
        path.join(configDir, "engram-compact-prompt.md"),
        path.join(configDir, "AGENTS.md"),
        path.join(configDir, "hooks.json"),
      ];
    case "opencode":
      return [
        path.join(configDir, "opencode.json"),
        path.join(configDir, "opencode.jsonc"),
        path.join(configDir, "tui.json"),
        path.join(configDir, "tui.jsonc"),
        path.join(configDir, "plugins", "engram.ts"),
      ];
    case "pi":
      // Canonical `engram setup pi` (plugin/pi README, `pi-engram init`):
      // settings.json (declara npm:pi-mcp-adapter + npm:gentle-engram,
      // provider-managed sin pin; auto-pin npmCommand solo con mise, nunca
      // sobrescribe), mcp.json (servidor engram directo canónico con
      // lifecycle lazy + directTools false) y todo <configDir>/npm
      // (provider-owned: el setup muta descendientes bajo npm). El coordinador
      // expande el directorio a ficheros regulares existentes, restaura bytes
      // mutados y en fallo solo elimina descendientes creados, preservando
      // ajenos preexistentes. Respeta PI_CODING_AGENT_DIR, por defecto
      // <home>/.pi/agent. Nunca ~/.engram, DB, memorias ni binario.
      return [
        path.join(configDir, "settings.json"),
        path.join(configDir, "mcp.json"),
        path.join(configDir, "npm"),
      ];
  }
}

/**
 * Puerta pura del destino para instalaciones reales (sin efectos en disco).
 *
 * Codex exige exactamente `<homeDir>/.codex`: el provider ignora CODEX_HOME
 * y `engram setup codex` siempre escribe allí. Una ruta distinta devuelve un
 * error accionable; null permite continuar. OpenCode conserva su puerta por
 * basename; los demás runtimes no restringen el destino.
 */
export function validateOfficialSetupDestination(
  runtime: string,
  configDir: string,
  homeDir: string,
): string | null {
  if (runtime === "codex") {
    const expected = path.resolve(path.join(homeDir, ".codex"));
    if (path.resolve(configDir) !== expected) {
      return `runOfficialSetupIfNeeded: Codex custom CODEX_HOME (${configDir}) is not supported: the provider ignores CODEX_HOME and 'engram setup codex' always writes ${expected}; use the default <home>/.codex.`;
    }
    return null;
  }
  if (runtime === "opencode" && path.basename(path.resolve(configDir)) !== "opencode") {
    return `runOfficialSetupIfNeeded: configDir OpenCode incompatible (${configDir}); el provider solo alinea <parent>/opencode vía XDG_CONFIG_HOME.`;
  }
  if (runtime === "pi") {
    // Pi respeta PI_CODING_AGENT_DIR explícito, pero el restore está acotado
    // a HOME: un configDir fuera de homeDir no puede recomponerse y se
    // rechaza temprano con diagnóstico accionable antes de backup/spawn.
    const resolved = path.resolve(configDir);
    const homeResolved = path.resolve(homeDir);
    if (resolved !== homeResolved && !isContainedIn(resolved, homeResolved)) {
      return `runOfficialSetupIfNeeded: Pi PI_CODING_AGENT_DIR (${configDir}) fuera de HOME (${homeDir}): queda fuera de la frontera de restore acotada a HOME; usa un PI_CODING_AGENT_DIR dentro de HOME o ajusta HOME antes de reintentar.`;
    }
    return null;
  }
  return null;
}

/**
 * Selector de config por runtime para el subprocess oficial.
 * Un solo configDir efectivo para backup, subprocess, verify y rollback.
 *
 * Claude depende del HOME efectivo (diagnóstico comprobado en Claude 2.1.267
 * y Engram 2.0.0): sin CLAUDE_CONFIG_DIR explícita y con el configDir
 * predeterminado (`<home>/.claude`) no se fuerza la variable, para que el
 * proveedor y el runtime usen el archivo hermano `<home>/.claude.json`.
 * Con la variable explícita se usa el anidado `configDir/.claude.json`,
 * incluso si su valor coincide con `<home>/.claude`.
 * El resto de variables se preserva: `spawnOfficialSetupBin` combina el
 * parche sobre `process.env`.
 *
 * En el modo Claude predeterminado (`isExplicit=false` o variable ausente con
 * path `<home>/.claude`), devuelve `{ CLAUDE_CONFIG_DIR: undefined }` para
 * impedir que el hijo herede un valor paterno ajeno.
 */
export function resolveOfficialSetupEnv(
  runtime: OfficialSetupRuntime,
  configDir: string,
  homeDir?: string,
  isExplicitClaudeConfigDir?: boolean,
): OfficialSetupEnvPatch {
  switch (runtime) {
    case "claude-code": {
      const home = homeDir ?? HOME;
      const explicit = isExplicitClaudeConfigDirEnv(isExplicitClaudeConfigDir);
      // Explícito siempre usa el config anidado, aunque el path sea el
      // predeterminado. En el modo predeterminado se elimina la variable para
      // usar el archivo hermano.
      if (explicit) return { CLAUDE_CONFIG_DIR: configDir };
      if (path.resolve(configDir) === path.resolve(path.join(home, ".claude"))) {
        return { CLAUDE_CONFIG_DIR: undefined };
      }
      return { CLAUDE_CONFIG_DIR: configDir };
    }
    case "codex":
      // El provider ignora CODEX_HOME y usa `$HOME/.codex`; el setup custom
      // ya quedó bloqueado. `undefined` elimina del hijo cualquier valor
      // custom heredado.
      return { CODEX_HOME: undefined };
    case "opencode":
      // Smoke real: `engram setup opencode` honra XDG_CONFIG_HOME sobre
      // OPENCODE_CONFIG_DIR. Se fijan ambos para que el config efectivo sea
      // <parent>/opencode, donde miran backup, verify y rollback.
      return { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: path.dirname(configDir) };
    case "pi":
      // Canonical: `pi-engram init` respeta PI_CODING_AGENT_DIR, por defecto
      // <home>/.pi/agent. Se fija explícito para que backup, subprocess,
      // verify y rollback vean el mismo configDir efectivo.
      return { PI_CODING_AGENT_DIR: configDir };
  }
}

/** Spawn real: argv fijo, sin shell, un intento, stdout/stderr capturados. */
export async function spawnOfficialSetupBin(
  bin: string,
  argv: string[],
  env?: OfficialSetupEnvPatch,
): Promise<OfficialSetupSpawnResult> {
  try {
    let childEnv: NodeJS.ProcessEnv | undefined;
    if (env !== undefined) {
      // Se parte de process.env; `undefined` elimina la clave y los valores
      // definidos del parche prevalecen.
      childEnv = { ...process.env };
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
      }
    }
    const stdout = execFileSync(bin, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      shell: false,
      ...(childEnv === undefined ? {} : { env: childEnv }),
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (error) {
    const stdout = (error as { stdout?: unknown } | null)?.stdout;
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const toText = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof Buffer) return value.toString("utf8");
      return "";
    };
    const errText = error instanceof Error ? error.message : String(error);
    const captured = toText(stderr).trim();
    return { ok: false, stdout: toText(stdout), stderr: captured !== "" ? captured : errText };
  }
}

export type OfficialSetupIfNeededResult =
  | { ran: false }
  | {
    ran: true;
    ok: boolean;
    ownershipTransferred: boolean;
    stderr?: string;
    reason?: string;
    incompleteRecovery?: boolean;
    recovery?: OfficialSetupRecovery;
    backupId?: string | null;
    restoreError?: string;
  };

/**
 * Versión mínima de Engram que registra el MCP exacto en Claude
 * (diagnóstico comprobado: 1.20.0 y 2.0.0-rc.11 escriben el obsoleto
 * `<config>/mcp/engram.json`, que el CLI ignora; 2.0.0 escribe la ubicación
 * efectiva). La comprobación exige una versión estable numérica >=2.0.0:
 * rechaza vacíos, textos sin triple numérica y cualquier versión con guion,
 * como `2.0.0-rc.11`, además de cualquier versión anterior a 2.0.0.
 * Fail-closed: lo ilegible nunca se acepta como compatible.
 */
export function isClaudeEngramVersionSupported(version: string): boolean {
  const trimmed = version.trim();
  if (trimmed === "") return false;
  if (trimmed.includes("-")) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major > 2) return true;
  if (major < 2) return false;
  return minor >= 0;
}

/**
 * Integración real para `runInstall`: comprobación solo en install + binario
 * absoluto + verificador registrado + comprobación previa de versión para
 * Claude. Los saltos intencionales (sync/dry-run/target-dir) siguen siendo `{ran:false}`.
 * En install real, runtime desconocido, verificador ausente o binario no
 * absoluto devuelven fallo explícito (`ran:true, ok:false`), nunca skip
 * silencioso. Codex/OpenCode/Pi son gestionados por el proveedor: nunca bloqueados por
 * versión. El binario existente jamás se modifica.
 */
export async function runOfficialSetupIfNeeded(
  runtime: string,
  opts: {
    command?: string;
    dryRun?: boolean;
    targetDir?: string | undefined;
    engramBin?: string | null;
    configDir: string;
    homeDir: string;
    /** Versión `engram --version` para el preflight Claude; null/undefined/vacía/ilegible falla cerrado. */
    engramVersion?: string | null;
    /** Modo explícito Claude; si se omite, se infiere de `CLAUDE_CONFIG_DIR`. */
    isExplicitClaudeConfigDir?: boolean;
  },
): Promise<OfficialSetupIfNeededResult> {
  if (!shouldRunOfficialSetup({ command: opts.command, dryRun: opts.dryRun, targetDir: opts.targetDir })) {
    return { ran: false };
  }
  if (!isOfficialSetupRuntime(runtime)) {
    const detail = `runOfficialSetupIfNeeded: runtime desconocido en install real: ${runtime}.`;
    return { ran: true, ok: false, ownershipTransferred: false, stderr: detail, reason: detail, recovery: "none" };
  }
  if (typeof opts.engramBin !== "string" || !path.isAbsolute(opts.engramBin)) {
    const detail = `runOfficialSetupIfNeeded: engramBin absoluto requerido en install real (runtime ${runtime}).`;
    return { ran: true, ok: false, ownershipTransferred: false, stderr: detail, reason: detail, recovery: "none" };
  }
  const verify = officialSetupVerifiers[runtime];
  if (!verify) {
    const detail = `runOfficialSetupIfNeeded: sin verificador registrado en install real (runtime ${runtime}).`;
    return { ran: true, ok: false, ownershipTransferred: false, stderr: detail, reason: detail, recovery: "none" };
  }

  // Preflight estricto solo para Claude antes de targets/backup/spawn: exige
  // una versión estable numérica >=2.0.0. `null`, vacía, malformada,
  // fallida/timeout o sin triple numérica falla cerrado con razón accionable
  // (check/update a 2.0.0+) y binario intacto. Codex/OpenCode/Pi son gestionados
  // por el proveedor y nunca se bloquean por versión.
  if (runtime === "claude-code") {
    const raw = opts.engramVersion;
    const provided = typeof raw === "string" ? raw.trim() : "";
    if (provided === "" || !isClaudeEngramVersionSupported(provided)) {
      const shown = provided === "" ? "unknown/unreadable" : provided;
      const detail = `runOfficialSetupIfNeeded: Engram ${shown} no registra el MCP de Claude Code; check engram --version and update to Engram 2.0.0+ and rerun install; existing binary was not replaced.`;
      return {
        ran: true,
        ok: false,
        ownershipTransferred: false,
        stderr: detail,
        reason: detail,
        recovery: "none",
        backupId: null,
      };
    }
  }

  const engramBin = opts.engramBin;
  const configDir = opts.configDir;
  const destinationError = validateOfficialSetupDestination(runtime, configDir, opts.homeDir);
  if (destinationError !== null) {
    return { ran: true, ok: false, ownershipTransferred: false, stderr: destinationError, reason: destinationError, recovery: "none", backupId: null };
  }
  const explicitClaude = runtime === "claude-code"
    ? isExplicitClaudeConfigDirEnv(opts.isExplicitClaudeConfigDir)
    : undefined;
  const targets = collectOfficialSetupBackupTargets(runtime, configDir, opts.homeDir, explicitClaude);
  const setupEnv = resolveOfficialSetupEnv(runtime, configDir, opts.homeDir, explicitClaude);
  let backupId: string | null = null;
  let expectedBackupFiles = 0;
  const expandBackupTargets = (files: string[]): string[] => {
    const out: string[] = [];
    for (const file of files) {
      try {
        // lstat: jamás atravesar ni copiar alias (el pre-chequeo del núcleo
        // ya bloqueó árboles con symlinks; esto es defensa en profundidad).
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              let entryStat: fs.Stats;
              try {
                entryStat = fs.lstatSync(full);
              } catch {
                continue;
              }
              if (entryStat.isSymbolicLink()) continue;
              if (entryStat.isDirectory()) walk(full);
              else out.push(full);
            }
          };
          walk(file);
          continue;
        }
      } catch {
        // Ausente o ilegible: createBackup lo ignora; se conserva el path.
      }
      out.push(file);
    }
    return out;
  };
  const result = await runOfficialSetup(runtime, {
    homeDir: opts.homeDir,
    engramBin,
    backup: async () => {
      const backup = createBackup(expandBackupTargets(targets), `official-engram-setup-${runtime}`);
      backupId = backup?.id ?? null;
      expectedBackupFiles = backup?.files.length ?? 0;
      return { id: backupId ?? "no-backup" };
    },
    spawn: async (bin, argv) => spawnOfficialSetupBin(bin, argv, setupEnv),
    verify: async () => verify({
      configDir,
      engramBin,
      homeDir: opts.homeDir,
      ...(explicitClaude === undefined ? {} : { isExplicitClaudeConfigDir: explicitClaude }),
    }),
    restore: async () => {
      if (backupId === null) return { restored: false };
      const restored = restoreBackup(backupId);
      if (restored !== expectedBackupFiles) {
        throw new Error(
          `restore incompleto: ${restored}/${expectedBackupFiles} archivos (backup ${backupId}).`,
        );
      }
      return { restored: true };
    },
    targets,
  });
  return {
    ran: true,
    ok: result.ok,
    ownershipTransferred: result.ownershipTransferred,
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.incompleteRecovery === undefined ? {} : { incompleteRecovery: result.incompleteRecovery }),
    ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
    ...(result.backupId === undefined ? {} : { backupId: result.backupId }),
    ...(result.restoreError === undefined ? {} : { restoreError: result.restoreError }),
  };
}
