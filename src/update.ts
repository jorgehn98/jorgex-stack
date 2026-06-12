import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { detectEngram, lookPath, runDetectedBin } from "./lib/detect.js";
import { stackRoot, dataDir, HOME } from "./lib/paths.js";
import { engramVersion } from "./doctor.js";
import {
  latestGithubRelease,
  latestGithubCommit,
  downloadRepoTarball,
  githubRateLimited,
  ghPresentButTokenFailed,
  validateExtractedTree,
} from "./lib/github.js";

/** Aviso de rate limit con el remedio que aplica a ESTA máquina. */
function rateLimitHint(prefix: string): string {
  return ghPresentButTokenFailed()
    ? `${prefix} Tienes gh instalado pero \`gh auth token\` no devolvió credencial (¿sesión caducada?) — prueba \`gh auth login\` o define GH_TOKEN.`
    : `${prefix} Define GH_TOKEN o inicia sesión en gh CLI.`;
}
import { diffSkillDirs, renderSkillDiff, replaceSkill, type SkillUpstreamInfo } from "./lib/skill-update.js";
import { isContainedIn } from "./lib/fsx.js";

interface Upstreams {
  tools: Record<string, { source: string; kind?: string }>;
  skills: Record<string, SkillUpstreamInfo>;
}

function loadUpstreams(): Upstreams {
  const file = path.join(path.dirname(stackRoot()), "upstreams.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Upstreams;
}

async function latestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * update --check: compara versiones locales vs upstream. `update` sin --check
 * re-aplica el stack (sync) y muestra este informe; aplicar updates de skills
 * de terceros automáticamente queda para v1.x (las 'modified' exigen diff
 * manual — PRD §7.3).
 */
export async function runUpdateCheck(localVersion: string): Promise<number> {
  p.intro("jorgex-stack update --check");
  const upstreams = loadUpstreams();

  // 1. El propio stack (npm).
  const npmLatest = await latestNpmVersion("jorgex-stack");
  if (npmLatest === null)
    p.log.info(`jorgex-stack: v${localVersion} local (aún no publicado en npm o sin red).`);
  else if (npmLatest === localVersion)
    p.log.success(`jorgex-stack: v${localVersion} — al día.`);
  else
    p.log.warn(
      `jorgex-stack: v${localVersion} local, v${npmLatest} en npm → pnpm dlx jorgex-stack@latest`,
    );

  // 2. Engram (D7: solo informar; actualizar es decisión del usuario).
  const engramRepo = upstreams.tools["engram"]?.source.replace(/^github:/, "");
  if (engramRepo) {
    const bin = detectEngram();
    const local = bin ? engramVersion(bin) : null;
    const latest = await latestGithubRelease(engramRepo);
    if (local === null) p.log.warn("engram: no detectado en esta máquina.");
    else if (latest === null)
      p.log.info(`engram: ${local} local (no se pudo consultar el upstream).`);
    else if (latest === local) p.log.success(`engram: ${local} — al día.`);
    else
      p.log.warn(
        `engram: ${local} local, ${latest} disponible. Tu instalación NO se toca (D7) — actualiza tú: github.com/${engramRepo}/releases`,
      );
  }

  // 3. Skills de terceros: HEAD del repo vs el commit pineado en upstreams.json.
  // El pin es la última revisión aceptada: si el repo se movió, el contenido
  // nuevo NO está revisado — actualizar exige diff manual + re-pin deliberado.
  // Una consulta por repo único (varios skills comparten monorepo).
  const byRepo = new Map<string, { skills: string[]; pinned?: string }>();
  for (const [name, info] of Object.entries(upstreams.skills)) {
    const repo = info.source.replace(/^github:/, "");
    const entry = byRepo.get(repo) ?? { skills: [], pinned: info.commit };
    entry.skills.push(info.modified ? `${name} (modificada localmente)` : name);
    byRepo.set(repo, entry);
  }
  const heads = await Promise.all(
    [...byRepo.keys()].map(async (repo) => [repo, await latestGithubCommit(repo)] as const),
  );
  let moved = 0;
  for (const [repo, head] of heads) {
    const { skills, pinned } = byRepo.get(repo)!;
    if (!pinned)
      p.log.warn(
        `${repo}: sin pin en upstreams.json — añade el commit revisado. Skills: ${skills.join(", ")}`,
      );
    else if (head === null)
      p.log.info(`${repo}: pin ${pinned.slice(0, 7)} (no se pudo consultar el upstream).`);
    else if (head === pinned)
      p.log.success(`${repo}: al día con el pin ${pinned.slice(0, 7)} (${skills.join(", ")}).`);
    else {
      moved++;
      p.log.warn(
        `${repo}: el upstream se movió (pin ${pinned.slice(0, 7)} → ${head.slice(0, 7)}). Skills: ${skills.join(", ")}.\n` +
          `  Revisa el diff y, si lo aceptas, actualiza la copia vendorizada y el pin: github.com/${repo}/compare/${pinned.slice(0, 7)}...${head.slice(0, 7)}`,
      );
    }
  }
  if (moved === 0 && heads.every(([, head]) => head !== null)) {
    p.log.info("Skills de terceros: ningún upstream se ha movido respecto a su pin.");
  }

  if (githubRateLimited()) {
    p.log.warn(rateLimitHint("GitHub limitó algunas consultas (rate limit sin token)."));
  }
  p.outro("Check completado.");
  return 0;
}

// ---------------------------------------------------------------------------
// Flujo interactivo de update (update sin --check, con TTY y sin --yes)
// ---------------------------------------------------------------------------

/** Detecta si el binario de engram está en ejecución. Fail-soft: devuelve null si no se puede comprobar. */
function isEngramRunning(): boolean | null {
  try {
    if (process.platform === "win32") {
      // tasklist no está en execFileSync fácilmente; usamos PowerShell Get-Process
      const ps = lookPath("powershell") ?? lookPath("pwsh");
      if (ps) {
        const out = runDetectedBin(ps, ["-NoProfile", "-Command", "Get-Process -Name engram -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"], 5_000);
        return out !== null ? parseInt(out.trim(), 10) > 0 : null;
      }
      return null;
    } else {
      // POSIX: pgrep -x engram devuelve código 0 si hay procesos, 1 si no
      const pgrep = lookPath("pgrep");
      if (!pgrep) return null;
      try {
        execFileSync(pgrep, ["-x", "engram"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    return null;
  }
}

/** Detecta si este stack es un clon git o está instalado como paquete global. */
function isGitClone(): boolean {
  const projectRoot = path.dirname(stackRoot());
  return fs.existsSync(path.join(projectRoot, ".git"));
}

// Método canónico para el update del stack en modo clon git
const STACK_METHOD_CLONE = "git pull + pnpm install + pnpm build";

/** Resuelve el binario de pnpm. */
function resolvePnpm(): string {
  const bin = lookPath("pnpm") ?? lookPath("pnpm.cmd") ?? lookPath("pnpm.ps1");
  if (!bin) throw new Error("pnpm no encontrado en PATH.");
  return bin;
}

/** Elimina un directorio temporal de forma fail-soft. */
function cleanupTmp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignorar */ }
}

/** Actualiza el stack en modo clon git (git pull + pnpm install + pnpm build). */
function updateStackGitClone(): void {
  const projectRoot = path.dirname(stackRoot());
  const git = lookPath("git");
  if (!git) throw new Error("git no encontrado en PATH.");
  const pnpm = resolvePnpm();

  p.log.info("Ejecutando git pull…");
  execFileSync(git, ["pull"], { cwd: projectRoot, stdio: "inherit" });

  p.log.info("Ejecutando pnpm install…");
  execFileSync(pnpm, ["install"], { cwd: projectRoot, stdio: "inherit" });

  p.log.info("Ejecutando pnpm build…");
  execFileSync(pnpm, ["build"], { cwd: projectRoot, stdio: "inherit" });
}

/** Actualiza el stack instalado globalmente. */
function updateStackGlobal(): void {
  const pnpm = resolvePnpm();
  p.log.info("Ejecutando pnpm add -g jorgex-stack@latest…");
  execFileSync(pnpm, ["add", "-g", "jorgex-stack@latest"], { stdio: "inherit" });
}

/**
 * Descarga una skill desde su repo upstream al directorio temporal.
 * Devuelve {dir: subdirectorio de la skill, root: raíz mkdtemp} para que el
 * caller pueda limpiar siempre la raíz completa, o {error} con el motivo.
 */
async function downloadSkillToTemp(
  repo: string,
  sha: string,
  skillPath: string | undefined,
): Promise<{ dir: string; root: string } | { error: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-skill-"));
  try {
    // La validación de symlinks/escapes se limita al subárbol consumido: los
    // monorepos llevan symlinks legítimos en zonas que nunca se leen.
    const result = await downloadRepoTarball(repo, sha, root, skillPath);
    if (!result.ok) {
      cleanupTmp(root);
      return { error: result.reason };
    }
    // Si la skill está en un subdirectorio del repo, calculamos la subruta.
    // Guard de contención: rechazar rutas que escapen del tmpDir.
    if (skillPath) {
      const sub = path.resolve(path.join(root, skillPath));
      if (!isContainedIn(sub, root)) {
        cleanupTmp(root);
        return { error: `la ruta "${skillPath}" escapa del directorio temporal` };
      }
      if (fs.existsSync(sub)) return { dir: sub, root };
      // Intento con último segmento del path — validarlo aparte: el download
      // solo validó skillPath y este fallback consume otro subárbol.
      const lastSeg = skillPath.split("/").pop()!;
      const sub2 = path.resolve(path.join(root, lastSeg));
      if (isContainedIn(sub2, root) && fs.existsSync(sub2)) {
        if (!validateExtractedTree(sub2)) {
          cleanupTmp(root);
          return { error: `el subárbol "${lastSeg}" contiene symlinks o rutas fuera del destino` };
        }
        return { dir: sub2, root };
      }
      // Sin subdir localizable, diffear contra la raíz del repo sería un diff sin sentido.
      cleanupTmp(root);
      return { error: `la ruta "${skillPath}" no existe en el tarball del upstream` };
    }
    return { dir: root, root };
  } catch (err) {
    cleanupTmp(root);
    return { error: err instanceof Error ? err.message : "error desconocido" };
  }
}

/**
 * Retiene solo los 3 backups de DB de engram más recientes en dataDir.
 * Fail-soft: no lanza excepciones.
 */
function pruneEngramDbBackups(): void {
  try {
    const dir = dataDir();
    if (!fs.existsSync(dir)) return;
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith("engram-db-backup-") && f.endsWith(".db"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // más reciente primero
    for (const old of backups.slice(3)) {
      try { fs.rmSync(path.join(dir, old.name)); } catch { /* ignorar */ }
    }
  } catch { /* ignorar */ }
}

/**
 * Windows no permite sobrescribir el .exe de un proceso vivo, pero SÍ
 * renombrarlo (mismo truco que Chrome/rustup): el proceso sigue usando el
 * archivo rotado y la ruta original queda libre para el binario nuevo.
 * Limpia rotaciones de updates anteriores ya liberadas (fail-soft: las que
 * sigan en uso se quedan y caerán en el siguiente update).
 * Devuelve la ruta rotada, o null si no había binario que rotar.
 */
export function rotateLockedBinary(binPath: string, sweepRoot = HOME): string | null {
  if (!fs.existsSync(binPath)) return null;
  const dir = path.dirname(binPath);
  const base = path.basename(binPath);
  // El barrido de rotaciones es lo único destructivo: solo bajo sweepRoot
  // (HOME en uso real) y solo archivos con el formato exacto de rotación.
  const escapedBase = base.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  const oldPattern = new RegExp("^" + escapedBase + "\\.old-\\d+$");
  // El propio root cuenta como dentro (un binario directamente en HOME es legítimo).
  const resolvedDir = path.resolve(dir);
  if (resolvedDir === path.resolve(sweepRoot) || isContainedIn(resolvedDir, sweepRoot)) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (oldPattern.test(entry)) {
          try { fs.rmSync(path.join(dir, entry), { force: true }); } catch { /* aún en uso */ }
        }
      }
    } catch { /* ignorar */ }
  }
  const rotated = path.join(dir, `${base}.old-${Date.now()}`);
  fs.renameSync(binPath, rotated);
  return rotated;
}

/** Actualiza engram usando el canal nativo replicado (brew → go install → URL releases). */
async function updateEngram(engramRepo: string, latestVersion: string): Promise<boolean> {
  // 1. Procesos en ejecución: NO hay que parar nada — mismo comportamiento que
  // el upstream en macOS/Linux (brew reemplaza el binario con procesos vivos;
  // siguen con la versión antigua hasta reiniciar los clientes). En Windows la
  // ruta se libera rotando el .exe por rename antes de instalar (canal B).
  if (isEngramRunning()) {
    p.log.info(
      "Engram está en ejecución: los procesos vivos seguirán usando la versión antigua hasta que reinicies los clientes (Claude Code/OpenCode/Codex).",
    );
  }

  // 2. Ofrecer backup de la DB ANTES de actualizar el binario.
  const engramDataDir = process.env.ENGRAM_DATA_DIR ?? path.join(HOME, ".engram");
  const engramDb = path.join(engramDataDir, "engram.db");
  if (fs.existsSync(engramDb)) {
    const doBackup = await p.confirm({
      message: `¿Hacer backup de la DB de Engram antes de actualizar? (${engramDb})`,
      initialValue: true,
    });
    if (!p.isCancel(doBackup) && doBackup) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(dataDir(), `engram-db-backup-${ts}.db`);
      try {
        if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true });
        fs.copyFileSync(engramDb, dest);
        p.log.success(`DB respaldada en ${dest} (la DB original NO se modifica jamás).`);
        // Conservar solo los 3 backups más recientes
        pruneEngramDbBackups();
      } catch (err) {
        p.log.warn(`No se pudo copiar la DB: ${err instanceof Error ? err.message : err}. Continuando sin backup.`);
      }
    }
  }

  // 3. Canal: brew → go install → URL releases
  let anyChannelTried = false;

  // Canal A: brew — separar detección de acción
  const brew = lookPath("brew");
  if (brew) {
    let brewManages = false;
    try {
      execFileSync(brew, ["list", "engram"], { stdio: "pipe" });
      brewManages = true;
    } catch {
      // brew no gestiona engram — continuar con siguiente canal
    }
    if (brewManages) {
      anyChannelTried = true;
      p.log.info("Actualizando engram con brew…");
      try {
        execFileSync(brew, ["upgrade", "engram"], { stdio: "inherit" });
        return true;
      } catch (err) {
        p.log.error(`brew upgrade engram falló: ${err instanceof Error ? err.message : err}`);
        return false;
      }
    }
  }

  // Canal B: go install
  const go = lookPath("go");
  if (go) {
    anyChannelTried = true;
    // Windows: liberar la ruta del binario en uso ANTES de go install.
    let rotated: string | null = null;
    const bin = detectEngram();
    if (process.platform === "win32" && bin) {
      try {
        rotated = rotateLockedBinary(bin);
      } catch (err) {
        p.log.warn(
          `No se pudo rotar el binario en uso: ${err instanceof Error ? err.message : err}. go install puede fallar por bloqueo.`,
        );
      }
    }
    p.log.info(`Actualizando engram con go install (${latestVersion})…`);
    try {
      execFileSync(
        go,
        ["install", `github.com/Gentleman-Programming/engram/cmd/engram@v${latestVersion}`],
        { stdio: "inherit" },
      );
      // go install escribe en GOBIN: si esa NO era la ruta rotada, el binario
      // activo quedaría desaparecido tras un install "exitoso" — restaurarlo.
      const rollbackOk = resolveEngramRollback({ installOk: true, rotated, bin, binExists: fs.existsSync(bin ?? "") });
      if (rollbackOk.action === "restore") {
        try {
          fs.renameSync(rotated!, bin!);
          p.log.warn(rollbackOk.messages.onRestore);
        } catch {
          p.log.warn(rollbackOk.messages.onRenameFail);
        }
      }
      return true;
    } catch (err) {
      const rollbackFail = resolveEngramRollback({ installOk: false, rotated, bin, binExists: fs.existsSync(bin ?? "") });
      if (rollbackFail.action === "restore") {
        try {
          fs.renameSync(rotated!, bin!);
          p.log.info(rollbackFail.messages.onRestore);
        } catch {
          p.log.error(rollbackFail.messages.onRenameFail);
        }
      } else if (rollbackFail.action === "leave_old") {
        // go install es atómico (temp+rename), pero si dejó algo en la ruta no lo pisamos.
        p.log.warn(rollbackFail.messages.onLeaveOld);
      }
      p.log.error(`go install falló: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // Canal C: informar URL de releases
  if (anyChannelTried) {
    p.log.error(
      `Los canales de actualización disponibles fallaron — revisa el error arriba; descarga manual: github.com/${engramRepo}/releases/tag/v${latestVersion}`,
    );
  } else {
    p.log.warn(
      `No se encontró brew ni go en PATH.\n` +
      `  Descarga manual: github.com/${engramRepo}/releases/tag/v${latestVersion}`,
    );
  }
  return false;
}

// Descripción de un item actualizable que el multiselect puede mostrar
interface UpdateItem {
  value: string;
  label: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Lógica de rollback de Engram — función pura exportada para tests
// ---------------------------------------------------------------------------

/** Acción de rollback de binario que resolveEngramRollback recomienda. */
export type EngramRollbackAction =
  | { action: "none" }
  | {
      action: "restore";
      /** true → go install instaló en GOBIN distinto (warning); false → install falló (revertir). */
      warnGobinMismatch: boolean;
      /** Mensajes a loguear: onRestore si el rename tiene éxito; onRenameFail si falla. */
      messages: { onRestore: string; onRenameFail: string };
    }
  | {
      action: "leave_old";
      /** Mensaje a loguear cuando el install falló pero go dejó algo en bin. */
      messages: { onLeaveOld: string };
    };

/**
 * Decide qué hacer con el binario rotado tras un intento de go install.
 * Función pura (sin I/O, sin side-effects): recibe los hechos del mundo como
 * parámetros y devuelve la acción + los mensajes con rutas concretas.
 * `updateEngram` la consume para ejecutar el rename y loguear los mensajes.
 */
export function resolveEngramRollback(input: {
  installOk: boolean;
  rotated: string | null;
  bin: string | null;
  /** fs.existsSync(bin) DESPUÉS del intento de install. */
  binExists: boolean;
}): EngramRollbackAction {
  const { installOk, rotated, bin, binExists } = input;

  // Sin rotación (no hay nada que restaurar) o sin ruta de destino conocida.
  if (!rotated || !bin) return { action: "none" };

  if (installOk && !binExists) {
    // go install tuvo éxito pero escribió en GOBIN distinto → restaurar activo.
    return {
      action: "restore",
      warnGobinMismatch: true,
      messages: {
        onRestore: `go install instaló en otra ruta (GOBIN distinto); el binario activo en ${bin} se ha restaurado. Comprueba qué engram resuelve tu PATH.`,
        onRenameFail: `go install instaló en otra ruta y no se pudo restaurar ${bin}; tu binario anterior está en ${rotated}.`,
      },
    };
  }

  if (!installOk && !binExists) {
    // Install fallido, ruta vacía → revertir la rotación.
    return {
      action: "restore",
      warnGobinMismatch: false,
      messages: {
        onRestore: "Rotación revertida — el binario anterior sigue en su sitio.",
        onRenameFail: `No se pudo revertir la rotación: tu binario anterior está en ${rotated} — renómbralo a ${bin} a mano.`,
      },
    };
  }

  if (!installOk && binExists) {
    // Install falló pero go dejó algo en la ruta (temp+rename parcial).
    return {
      action: "leave_old",
      messages: {
        onLeaveOld: `El install falló pero dejó un binario en ${bin}; tu copia anterior queda en ${rotated}.`,
      },
    };
  }

  // Resto de casos: install limpio (installOk && binExists) o combinaciones imposibles.
  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Lógica de elegibilidad de skills — función pura exportada para tests
// ---------------------------------------------------------------------------

/** Entrada por skill tal y como la devuelve la consulta al upstream. */
export interface SkillQueryResult {
  name: string;
  repo: string;
  info: SkillUpstreamInfo;
  head: string | null;
}

/** Una skill elegible para actualizar (upstream se movió y se puede aplicar). */
export interface EligibleSkillUpdate {
  name: string;
  repo: string;
  head: string;
  pinned: string;
  skillPath?: string;
  modified: boolean;
}

/**
 * Calcula qué skills son elegibles para el multiselect a partir de los datos
 * ya consultados (sin I/O ni red). Reglas:
 * - kind=release: excluida (informar aparte, no actualizar con replaceSkill).
 * - Sin pin: excluida (sin referencia para comparar).
 * - Sin conexión (head=null): excluida.
 * - head === pinned: al día, no incluir.
 * - Resto: elegible.
 * Agrupa por repo para no repetir: el pin y el head los toma del primero
 * del repo que encuentre; si hay varios skills en el mismo repo, todos usan
 * el mismo head/pinned.
 */
export function buildEligibleSkillUpdates(skills: SkillQueryResult[]): EligibleSkillUpdate[] {
  const byRepo = new Map<string, { names: string[]; pinned: string; headVal: string | null }>();

  for (const { name, repo, info, head } of skills) {
    // Excluir kind=release
    if (info.kind === "release") continue;
    const existing = byRepo.get(repo);
    if (!existing) {
      byRepo.set(repo, { names: [name], pinned: info.commit ?? "", headVal: head });
    } else {
      existing.names.push(name);
    }
  }

  const result: EligibleSkillUpdate[] = [];
  for (const [repo, { names, pinned, headVal }] of byRepo) {
    if (!pinned) continue;
    if (headVal === null) continue;
    if (headVal === pinned) continue;
    // Upstream se movió — agregar cada skill con sus datos individuales
    for (const name of names) {
      const skill = skills.find((s) => s.name === name)!;
      result.push({
        name,
        repo,
        head: headVal,
        pinned,
        skillPath: skill.info.path,
        modified: skill.info.modified ?? false,
      });
    }
  }
  return result;
}

/** Resultado del flujo interactivo de update. */
export interface InteractiveUpdateResult {
  exitCode: number;
  /** true si se aplicó al menos un update de stack o skill con éxito (requiere sync). */
  appliedUpdates: boolean;
}

/**
 * Flujo interactivo de update. Escanea las 3 fuentes, ofrece multiselect
 * y aplica lo marcado. Respeta --yes y no-TTY: en esos casos, solo informe.
 * dryRun: cortocircuita al check sin aplicar nada.
 */
export async function runInteractiveUpdate(localVersion: string, yes: boolean, dryRun = false): Promise<InteractiveUpdateResult> {
  // Con --dry-run, --yes o sin TTY: comportarse como el check original
  if (dryRun || yes || !process.stdout.isTTY) {
    return { exitCode: await runUpdateCheck(localVersion), appliedUpdates: false };
  }

  p.intro("jorgex-stack update");
  const upstreams = loadUpstreams();
  let exitCode = 0;
  let appliedUpdates = false;

  // -------------------------------------------------------------------------
  // FASE 1: Escanear las 3 fuentes en paralelo
  // -------------------------------------------------------------------------
  const spin = p.spinner();
  spin.start("Consultando versiones upstream…");

  const [npmLatest, engramLatestRaw, ...skillHeads] = await Promise.all([
    latestNpmVersion("jorgex-stack"),
    (async () => {
      const repo = upstreams.tools["engram"]?.source.replace(/^github:/, "");
      if (!repo) return null;
      return { repo, version: await latestGithubRelease(repo) };
    })(),
    ...Object.keys(upstreams.skills).map(async (name) => {
      const info = upstreams.skills[name]!;
      const repo = info.source.replace(/^github:/, "");
      const head = await latestGithubCommit(repo);
      return { name, repo, info, head };
    }),
  ]);

  spin.stop("Consulta completada.");

  if (githubRateLimited()) {
    p.log.warn(rateLimitHint("GitHub limitó algunas consultas — los upstreams 'sin conexión' pueden ser eso."));
  }

  // -------------------------------------------------------------------------
  // FASE 2: Construir la lista de items actualizables
  // -------------------------------------------------------------------------
  const updateItems: UpdateItem[] = [];
  const engramData = engramLatestRaw as { repo: string; version: string | null } | null;

  // Stack
  let stackNeedsUpdate = false;
  if (npmLatest === null) {
    p.log.info(`jorgex-stack: v${localVersion} local (aún no publicado en npm o sin red).`);
  } else if (npmLatest === localVersion) {
    p.log.success(`jorgex-stack: v${localVersion} — al día.`);
  } else {
    stackNeedsUpdate = true;
    const mode = isGitClone() ? STACK_METHOD_CLONE : `pnpm add -g jorgex-stack@${npmLatest}`;
    updateItems.push({
      value: "stack",
      label: `jorgex-stack: v${localVersion} → v${npmLatest}`,
      hint: mode,
    });
  }

  // Engram
  let engramNeedsUpdate = false;
  let engramLocalVersion: string | null = null;
  if (engramData) {
    const engramBinLocal = detectEngram();
    engramLocalVersion = engramBinLocal ? engramVersion(engramBinLocal) : null;
    if (engramLocalVersion === null) {
      p.log.warn("engram: no detectado en esta máquina.");
    } else if (engramData.version === null) {
      p.log.info(`engram: ${engramLocalVersion} local (no se pudo consultar el upstream).`);
    } else if (engramData.version === engramLocalVersion) {
      p.log.success(`engram: ${engramLocalVersion} — al día.`);
    } else {
      engramNeedsUpdate = true;
      updateItems.push({
        value: "engram",
        label: `engram: ${engramLocalVersion} → ${engramData.version}`,
        hint: "canal nativo (brew → go install → URL)",
      });
    }
  }

  // Skills: primero loguear las no-elegibles (pasada de I/O separada), luego calcular elegibles con la función pura.
  const typedSkillHeads = skillHeads as SkillQueryResult[];

  // Pasada de logging: kind=release, sin pin, sin conexión, al día (agrupado por repo).
  const loggedRepos = new Map<string, { names: string[]; pinned: string; headVal: string | null; anyRelease: boolean }>();
  for (const { name, repo, info, head } of typedSkillHeads) {
    if (info.kind === "release") {
      // Informar solo si el upstream se movió respecto al pin
      if (head !== null && info.commit && head !== info.commit) {
        p.log.warn(`${name} (release): upstream se movió. Revisa: github.com/${repo}/releases`);
      }
      continue;
    }
    const existing = loggedRepos.get(repo);
    if (!existing) {
      loggedRepos.set(repo, { names: [name], pinned: info.commit ?? "", headVal: head, anyRelease: false });
    } else {
      existing.names.push(name);
    }
  }
  for (const [repo, { names, pinned, headVal }] of loggedRepos) {
    if (!pinned) {
      p.log.warn(`${repo}: sin pin — no se puede actualizar. Skills: ${names.join(", ")}`);
    } else if (headVal === null) {
      p.log.info(`${repo}: sin conexión al upstream. Skills: ${names.join(", ")}`);
    } else if (headVal === pinned) {
      p.log.success(`${repo}: al día (pin ${pinned.slice(0, 7)}). Skills: ${names.join(", ")}`);
    }
    // Si el upstream se movió (elegible), no se logea aquí — aparece en el picker.
  }

  // Calcular elegibles con la función pura (sin I/O).
  const skillUpdates = buildEligibleSkillUpdates(typedSkillHeads);
  for (const skillInfo of skillUpdates) {
    const modifiedWarning = skillInfo.modified ? " ⚠ modificada localmente" : "";
    updateItems.push({
      value: `skill:${skillInfo.name}`,
      label: `skill ${skillInfo.name}: ${skillInfo.pinned.slice(0, 7)} → ${skillInfo.head.slice(0, 7)}${modifiedWarning}`,
      hint: `github.com/${skillInfo.repo}/compare/${skillInfo.pinned.slice(0, 7)}...${skillInfo.head.slice(0, 7)}`,
    });
  }

  // Nada que actualizar
  if (updateItems.length === 0) {
    p.outro("Todo al día. No hay actualizaciones disponibles.");
    return { exitCode: 0, appliedUpdates: false };
  }

  // -------------------------------------------------------------------------
  // FASE 3: Multiselect
  // -------------------------------------------------------------------------
  const selected = await p.multiselect({
    message: "Selecciona qué actualizar (espacio para marcar, intro para confirmar):",
    options: updateItems,
    initialValues: updateItems.map((i) => i.value),
    required: false,
  });

  if (p.isCancel(selected)) {
    p.outro("Update cancelado.");
    return { exitCode: 0, appliedUpdates: false };
  }

  if ((selected as string[]).length === 0) {
    p.outro("Nada seleccionado.");
    return { exitCode: 0, appliedUpdates: false };
  }

  const sel = selected as string[];

  // -------------------------------------------------------------------------
  // FASE 4: Aplicar lo seleccionado
  // -------------------------------------------------------------------------

  // 4a. Stack
  if (stackNeedsUpdate && sel.includes("stack")) {
    const isClone = isGitClone();
    const method = isClone ? STACK_METHOD_CLONE : "pnpm add -g jorgex-stack@latest";
    const confirm = await p.confirm({
      message: `Actualizar el stack con: ${method}`,
      initialValue: true,
    });
    if (p.isCancel(confirm) || !confirm) {
      p.log.info("Stack: actualización omitida.");
    } else {
      try {
        if (isClone) {
          updateStackGitClone();
        } else {
          updateStackGlobal();
        }
        p.log.success("Stack actualizado correctamente.");
        appliedUpdates = true;
      } catch (err) {
        p.log.error(`Stack: error al actualizar — ${err instanceof Error ? err.message : err}`);
        exitCode = 1;
      }
    }
  }

  // 4b. Skills
  for (const skillInfo of skillUpdates) {
    if (!sel.includes(`skill:${skillInfo.name}`)) continue;

    if (skillInfo.modified) {
      p.log.warn(
        `skill ${skillInfo.name}: TIENE CAMBIOS LOCALES. Actualizar sobreescribirá esas modificaciones (backup automático).`,
      );
      const forceConfirm = await p.confirm({
        message: `¿Confirmas sobreescribir los cambios locales de ${skillInfo.name}?`,
        initialValue: false,
      });
      if (p.isCancel(forceConfirm) || !forceConfirm) {
        p.log.info(`skill ${skillInfo.name}: omitida.`);
        continue;
      }
    }

    // Descargar upstream a tmp
    const spin2 = p.spinner();
    spin2.start(`Descargando upstream de ${skillInfo.name}…`);
    const tmpResult = await downloadSkillToTemp(skillInfo.repo, skillInfo.head, skillInfo.skillPath);
    spin2.stop("error" in tmpResult ? "Error de descarga." : "Descargado.");

    if ("error" in tmpResult) {
      p.log.error(`skill ${skillInfo.name}: descarga fallida — ${tmpResult.error}. Omitiendo.`);
      exitCode = 1;
      continue;
    }

    const { dir: tmpDir, root: tmpRoot } = tmpResult;

    // Mostrar diff
    const localSkillDir = path.join(stackRoot(), "skills", skillInfo.name);
    const diff = renderSkillDiff(tmpDir, localSkillDir);
    if (diff) {
      p.log.info(`Diff de ${skillInfo.name}:\n${diff}`);
    } else {
      p.log.info(`${skillInfo.name}: sin cambios en contenido (el repo se movió pero la skill no cambió).`);
      // Limpiar la raíz tmpRoot y continuar sin hacer nada
      cleanupTmp(tmpRoot);
      continue;
    }

    const applySkill = await p.confirm({
      message: `¿Aplicar la actualización de ${skillInfo.name}?`,
      // Default No — política deliberate-pin (el diff es de contenido)
      initialValue: false,
    });
    if (p.isCancel(applySkill) || !applySkill) {
      p.log.info(`skill ${skillInfo.name}: omitida.`);
      cleanupTmp(tmpRoot);
      continue;
    }

    try {
      replaceSkill(skillInfo.name, tmpDir, skillInfo.head, {});
      p.log.success(`skill ${skillInfo.name}: actualizada y re-pineada a ${skillInfo.head.slice(0, 7)}.`);
      appliedUpdates = true;
    } catch (err) {
      p.log.error(`skill ${skillInfo.name}: error — ${err instanceof Error ? err.message : err}`);
      exitCode = 1;
    } finally {
      cleanupTmp(tmpRoot);
    }
  }

  // 4c. Engram
  if (engramNeedsUpdate && sel.includes("engram") && engramData?.version) {
    const confirmEngram = await p.confirm({
      message: `Actualizar engram a v${engramData.version} (canal nativo: brew → go install → URL)`,
      initialValue: true,
    });
    if (p.isCancel(confirmEngram) || !confirmEngram) {
      p.log.info("Engram: actualización omitida.");
    } else {
      const ok = await updateEngram(engramData.repo, engramData.version);
      if (!ok) {
        exitCode = 1;
      } else {
        // Verificar versión tras actualizar
        const binPost = detectEngram();
        const versionPost = binPost ? engramVersion(binPost) : null;
        if (versionPost) {
          p.log.success(`Engram: ahora en v${versionPost}.`);
        } else {
          p.log.warn("Engram actualizado, pero no se pudo verificar la versión — comprueba con engram --version");
        }
        p.log.info("Reinicia los clientes (Claude Code/OpenCode/Codex) para que sus MCP usen la versión nueva.");
      }
    }
  }

  p.outro(exitCode === 0 ? "Update completado." : "Update completado con errores (revisa arriba).");
  return { exitCode, appliedUpdates };
}
