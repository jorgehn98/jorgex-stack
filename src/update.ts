import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { detectEngram, lookPath, runDetectedBin } from "./lib/detect.js";
import { stackRoot, dataDir, HOME } from "./lib/paths.js";
import { engramVersion } from "./doctor.js";
import { latestGithubRelease, latestGithubCommit, downloadRepoTarball } from "./lib/github.js";
import { diffSkillDirs, renderSkillDiff, replaceSkill } from "./lib/skill-update.js";
import { createBackup } from "./lib/backup.js";

interface Upstreams {
  tools: Record<string, { source: string; kind?: string }>;
  skills: Record<
    string,
    {
      source: string;
      path?: string;
      kind?: string;
      version?: string;
      commit?: string;
      modified?: boolean;
    }
  >;
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

/** Actualiza el stack en modo clon git (git pull + pnpm install + pnpm build). */
function updateStackGitClone(): void {
  const projectRoot = path.dirname(stackRoot());
  const git = lookPath("git");
  if (!git) throw new Error("git no encontrado en PATH.");
  const pnpm = lookPath("pnpm") ?? lookPath("pnpm.cmd") ?? lookPath("pnpm.ps1");
  if (!pnpm) throw new Error("pnpm no encontrado en PATH.");

  p.log.info("Ejecutando git pull…");
  execFileSync(git, ["pull"], { cwd: projectRoot, stdio: "inherit" });

  p.log.info("Ejecutando pnpm install…");
  execFileSync(pnpm, ["install"], { cwd: projectRoot, stdio: "inherit" });

  p.log.info("Ejecutando pnpm build…");
  execFileSync(pnpm, ["build"], { cwd: projectRoot, stdio: "inherit" });
}

/** Actualiza el stack instalado globalmente. */
function updateStackGlobal(): void {
  const pnpm = lookPath("pnpm") ?? lookPath("pnpm.cmd") ?? lookPath("pnpm.ps1");
  if (!pnpm) throw new Error("pnpm no encontrado en PATH.");
  p.log.info("Ejecutando pnpm add -g jorgex-stack@latest…");
  execFileSync(pnpm, ["add", "-g", "jorgex-stack@latest"], { stdio: "inherit" });
}

/** Descarga una skill desde su repo upstream al directorio temporal y devuelve la ruta. */
async function downloadSkillToTemp(repo: string, sha: string, skillPath: string | undefined): Promise<string | null> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-skill-"));
  try {
    const ok = await downloadRepoTarball(repo, sha, tmp);
    if (!ok) return null;
    // Si la skill está en un subdirectorio del repo, calculamos la subruta
    if (skillPath) {
      const sub = path.join(tmp, skillPath);
      if (fs.existsSync(sub)) return sub;
      // Intento con último segmento del path
      const lastSeg = skillPath.split("/").pop()!;
      const sub2 = path.join(tmp, lastSeg);
      if (fs.existsSync(sub2)) return sub2;
    }
    return tmp;
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignorar */ }
    return null;
  }
}

/** Actualiza engram usando el canal nativo replicado (brew → go install → URL releases). */
async function updateEngram(engramRepo: string, latestVersion: string): Promise<boolean> {
  // 1. ¿Está ejecutándose engram? Advertir antes de intentar reemplazar el binario.
  const running = isEngramRunning();
  if (running === null) {
    p.log.warn("No se pudo comprobar si engram está en ejecución. En Windows el .exe en uso bloquea el reemplazo — asegúrate de pararlo si ves errores.");
  } else if (running) {
    p.log.warn("Engram está en ejecución. En Windows el .exe en uso bloquea el reemplazo.");
    const stop = await p.confirm({ message: "¿Has parado el proceso engram? (necesario en Windows antes de actualizar)" });
    if (p.isCancel(stop) || !stop) {
      p.log.info("Actualización de engram cancelada. Para manualmente: taskkill /IM engram.exe /F");
      return false;
    }
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
      } catch (err) {
        p.log.warn(`No se pudo copiar la DB: ${err instanceof Error ? err.message : err}. Continuando sin backup.`);
      }
    }
  }

  // 3. Canal: brew → go install → URL releases
  // Canal A: brew
  const brew = lookPath("brew");
  if (brew) {
    // Verificar si brew gestiona engram
    try {
      execFileSync(brew, ["list", "engram"], { stdio: "pipe" });
      // Si llega aquí, brew gestiona engram
      p.log.info("Actualizando engram con brew…");
      execFileSync(brew, ["upgrade", "engram"], { stdio: "inherit" });
      return true;
    } catch {
      // brew no gestiona engram — continuar con siguiente canal
    }
  }

  // Canal B: go install
  const go = lookPath("go");
  if (go) {
    p.log.info(`Actualizando engram con go install (${latestVersion})…`);
    try {
      execFileSync(
        go,
        ["install", `github.com/Gentleman-Programming/engram/cmd/engram@latest`],
        { stdio: "inherit" },
      );
      return true;
    } catch (err) {
      p.log.warn(`go install falló: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Canal C: informar URL de releases
  p.log.warn(
    `No se encontró brew ni go en PATH.\n` +
    `  Descarga manual: github.com/${engramRepo}/releases/tag/v${latestVersion}`,
  );
  return false;
}

// Descripción de un item actualizable que el multiselect puede mostrar
interface UpdateItem {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Flujo interactivo de update. Escanea las 3 fuentes, ofrece multiselect
 * y aplica lo marcado. Respeta --yes y no-TTY: en esos casos, solo informe.
 */
export async function runInteractiveUpdate(localVersion: string, yes: boolean): Promise<number> {
  // Con --yes o sin TTY: comportarse como el check original
  if (yes || !process.stdout.isTTY) {
    return runUpdateCheck(localVersion);
  }

  p.intro("jorgex-stack update");
  const upstreams = loadUpstreams();
  let exitCode = 0;

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
    const mode = isGitClone() ? "git pull + pnpm build" : `pnpm add -g jorgex-stack@${npmLatest}`;
    updateItems.push({
      value: "stack",
      label: `jorgex-stack: v${localVersion} → v${npmLatest}`,
      hint: mode,
    });
  }

  // Engram
  let engramNeedsUpdate = false;
  let engramBinLocal: string | null = null;
  let engramLocalVersion: string | null = null;
  if (engramData) {
    engramBinLocal = detectEngram();
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

  // Skills (solo kind != release y no protegidas)
  interface SkillUpdateInfo {
    name: string;
    repo: string;
    head: string;
    pinned: string;
    skillPath?: string;
    modified: boolean;
  }
  const skillUpdates: SkillUpdateInfo[] = [];

  // Agrupar por repo para no repetir
  const byRepo = new Map<string, { names: string[]; pinned: string; headVal: string | null }>();
  for (const item of skillHeads as { name: string; repo: string; info: typeof upstreams.skills[string]; head: string | null }[]) {
    const { name, repo, info, head } = item;
    // Excluir kind=release (solo informe)
    if (info.kind === "release") {
      if (head !== null && info.commit && head !== info.commit) {
        p.log.warn(`${name} (release): upstream se movió. Revisa: github.com/${repo}/releases`);
      }
      continue;
    }
    const existing = byRepo.get(repo);
    if (!existing) {
      byRepo.set(repo, { names: [name], pinned: info.commit ?? "", headVal: head });
    } else {
      existing.names.push(name);
    }
  }

  for (const [repo, { names, pinned, headVal }] of byRepo) {
    if (!pinned) {
      p.log.warn(`${repo}: sin pin — no se puede actualizar. Skills: ${names.join(", ")}`);
      continue;
    }
    if (headVal === null) {
      p.log.info(`${repo}: sin conexión al upstream. Skills: ${names.join(", ")}`);
      continue;
    }
    if (headVal === pinned) {
      p.log.success(`${repo}: al día (pin ${pinned.slice(0, 7)}). Skills: ${names.join(", ")}`);
      continue;
    }
    // Upstream se movió — agregar cada skill al picker
    for (const name of names) {
      const info = upstreams.skills[name]!;
      const modifiedWarning = info.modified ? " ⚠ modificada localmente" : "";
      skillUpdates.push({ name, repo, head: headVal, pinned, skillPath: info.path, modified: info.modified ?? false });
      updateItems.push({
        value: `skill:${name}`,
        label: `skill ${name}: ${pinned.slice(0, 7)} → ${headVal.slice(0, 7)}${modifiedWarning}`,
        hint: `github.com/${repo}/compare/${pinned.slice(0, 7)}...${headVal.slice(0, 7)}`,
      });
    }
  }

  // Nada que actualizar
  if (updateItems.length === 0) {
    p.outro("Todo al día. No hay actualizaciones disponibles.");
    return 0;
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
    return 0;
  }

  if ((selected as string[]).length === 0) {
    p.outro("Nada seleccionado.");
    return 0;
  }

  const sel = selected as string[];

  // -------------------------------------------------------------------------
  // FASE 4: Aplicar lo seleccionado
  // -------------------------------------------------------------------------

  // 4a. Stack
  if (stackNeedsUpdate && sel.includes("stack")) {
    const isClone = isGitClone();
    const method = isClone
      ? "git pull + pnpm install + pnpm build"
      : "pnpm add -g jorgex-stack@latest";
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
    const tmpDir = await downloadSkillToTemp(skillInfo.repo, skillInfo.head, skillInfo.skillPath);
    spin2.stop(tmpDir ? "Descargado." : "Error de descarga.");

    if (!tmpDir) {
      p.log.error(`skill ${skillInfo.name}: no se pudo descargar el upstream. Omitiendo.`);
      exitCode = 1;
      continue;
    }

    // Mostrar diff
    const localSkillDir = path.join(stackRoot(), "skills", skillInfo.name);
    const diff = renderSkillDiff(tmpDir, localSkillDir);
    if (diff) {
      p.log.info(`Diff de ${skillInfo.name}:\n${diff}`);
    } else {
      p.log.info(`${skillInfo.name}: sin cambios en contenido (el repo se movió pero la skill no cambió).`);
      // Limpiar tmpDir y continuar sin hacer nada
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorar */ }
      continue;
    }

    const applySkill = await p.confirm({
      message: `¿Aplicar la actualización de ${skillInfo.name}?`,
      initialValue: !skillInfo.modified,
    });
    if (p.isCancel(applySkill) || !applySkill) {
      p.log.info(`skill ${skillInfo.name}: omitida.`);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorar */ }
      continue;
    }

    try {
      replaceSkill(skillInfo.name, tmpDir, skillInfo.head);
      p.log.success(`skill ${skillInfo.name}: actualizada y re-pineada a ${skillInfo.head.slice(0, 7)}.`);
    } catch (err) {
      p.log.error(`skill ${skillInfo.name}: error — ${err instanceof Error ? err.message : err}`);
      exitCode = 1;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorar */ }
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
        }
      }
    }
  }

  p.outro(exitCode === 0 ? "Update completado." : "Update completado con errores (revisa arriba).");
  return exitCode;
}
