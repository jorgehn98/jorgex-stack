import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { Adapter, FileAction, InstallContext, RuntimeId } from "./adapters/types.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { HOME, stackRoot } from "./lib/paths.js";
import { detectEngram } from "./lib/detect.js";
import { copyFile, pruneEmptyDirs, readTextIfExists, sameFileContent, writeText } from "./lib/fsx.js";
import { ensureModelMapFile, loadModelMap } from "./lib/model-map.js";
import { createBackup } from "./lib/backup.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "./lib/canonical.js";
import { findOrphans, readManifest, writeRuntimeManifest } from "./lib/manifest.js";
import { planSystemPrompt } from "./components/system-prompt.js";
import { planAgents } from "./components/agents.js";
import { planSkills } from "./components/skills.js";
import { planCommands } from "./components/commands.js";
import { planHooks } from "./components/hooks.js";
import { planMcp } from "./components/mcp.js";
import { planPlugins } from "./components/plugins.js";

export const ADAPTERS: Partial<Record<RuntimeId, Adapter>> = {
  opencode: opencodeAdapter,
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

export interface InstallOptions {
  runtimes: RuntimeId[];
  /** Override del dir de config destino (pruebas/paridad). Solo válido con un único runtime. */
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
}

export type PlannedChange = { action: FileAction; status: "create" | "update" | "unchanged" };

/** Contexto de instalación para un runtime, o null si no hay model-map. */
export function makeContext(adapter: Adapter, configDir: string): InstallContext | null {
  const models = loadModelMap()[adapter.id];
  if (!models) return null;
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: detectEngram(),
    models,
    secrets: { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY },
    warnings: [],
  };
}

export function buildPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planAgents(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
    ...planHooks(adapter, ctx),
    ...planMcp(adapter, ctx),
    ...planPlugins(adapter, ctx),
  ];
}

export function diffPlan(plan: FileAction[]): PlannedChange[] {
  return plan.map((action) => {
    if (action.kind === "write") {
      const current = readTextIfExists(action.target);
      if (current === null) return { action, status: "create" };
      return { action, status: current === action.content ? "unchanged" : "update" };
    }
    if (!fs.existsSync(action.target)) return { action, status: "create" };
    return { action, status: sameFileContent(action.source, action.target) ? "unchanged" : "update" };
  });
}

function applyChanges(changes: PlannedChange[]): void {
  for (const { action } of changes) {
    if (action.kind === "write") writeText(action.target, action.content);
    else copyFile(action.source, action.target);
  }
}

/**
 * Targets actuales de TODOS los runtimes detectados (no solo los del install
 * en curso): un huérfano solo lo es si ningún plan vivo lo reclama — p.ej.
 * ~/.agents/skills sirve a Codex Y OpenCode. Si algún plan falla (config de
 * usuario ilegible), `complete` es false: con visión parcial NO es seguro
 * borrar huérfanos.
 */
export function collectAllCurrentTargets(): { targets: Set<string>; complete: boolean } {
  const targets = new Set<string>();
  let complete = true;
  for (const adapter of Object.values(ADAPTERS)) {
    const detection = adapter.detect();
    if (!detection.installed) continue;
    const ctx = makeContext(adapter, detection.configDir);
    if (!ctx) continue;
    try {
      for (const action of buildPlan(adapter, ctx)) targets.add(path.resolve(action.target));
    } catch {
      complete = false;
    }
  }
  return { targets, complete };
}

export async function runInstall(opts: InstallOptions): Promise<number> {
  p.intro(`jorgex-stack ${opts.dryRun ? "install (dry-run)" : "install"}`);

  const stackDir = stackRoot();
  const engramBin = detectEngram();
  const modelMap = loadModelMap();
  ensureModelMapFile();

  p.log.info(engramBin ? `Engram detectado: ${engramBin} (se respeta, D7)` : "Engram NO detectado.");

  // El manifest solo aplica a instalaciones reales; --target-dir es de pruebas.
  const useManifest = opts.targetDir === undefined;
  const current = useManifest ? collectAllCurrentTargets() : { targets: new Set<string>(), complete: false };
  const canOrphan = useManifest && current.complete;
  const canonicalMcp = loadCanonicalMcp(stackDir);
  const canonicalHooks = loadCanonicalHooks(stackDir);

  let exitCode = 0;
  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    if (!adapter) {
      p.log.warn(`${id}: adapter pendiente (F3/F4) — omitido.`);
      continue;
    }

    const detection = adapter.detect();
    const configDir = opts.targetDir ?? detection.configDir;
    if (!detection.installed && opts.targetDir === undefined) {
      p.log.warn(`${adapter.name} no detectado en esta máquina — omitido.`);
      continue;
    }
    const models = modelMap[id];
    if (!models) {
      p.log.warn(`${adapter.name}: sin model-map para este runtime — omitido.`);
      continue;
    }

    const ctx: InstallContext = {
      stackDir,
      configDir,
      engramBin,
      models,
      secrets: { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY },
      warnings: [],
    };

    let plan = buildPlan(adapter, ctx);
    let diff = diffPlan(plan);
    let creates = diff.filter((d) => d.status === "create");
    let updates = diff.filter((d) => d.status === "update");
    let changes = [...creates, ...updates];

    // Huérfanos: archivos que una versión anterior instaló y el plan actual ya
    // no genera (skill renombrada/eliminada). Solo con manifest previo y visión
    // completa de los planes de todos los runtimes.
    const prevManifest = canOrphan ? readManifest().runtimes[id] : undefined;
    const orphans = prevManifest ? findOrphans(prevManifest.owned, current.targets) : [];

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(
      `${diff.length} archivos gestionados: ${creates.length} nuevos, ${updates.length} modificados, ${diff.length - changes.length} sin cambios`,
    );
    if (orphans.length > 0) p.log.info(`${orphans.length} huérfanos de versiones previas a eliminar`);
    for (const w of ctx.warnings) p.log.warn(w);

    if (opts.dryRun) {
      for (const c of changes.slice(0, 40)) p.log.message(`  ${c.status === "create" ? "+" : "~"} ${c.action.target}`);
      if (changes.length > 40) p.log.message(`  … y ${changes.length - 40} más`);
      for (const o of orphans) p.log.message(`  - ${o}`);
      continue;
    }

    const writeManifest = (): void => {
      if (!useManifest) return;
      const unmergeTargets = new Set(adapter.planUnmerge(canonicalMcp, canonicalHooks, ctx).map((a) => path.resolve(a.target)));
      const owned = plan.map((a) => path.resolve(a.target)).filter((t) => !unmergeTargets.has(t));
      writeRuntimeManifest(id, { configDir, owned, updatedAt: new Date().toISOString() });
    };

    if (changes.length === 0 && orphans.length === 0) {
      writeManifest();
      p.log.success(`${adapter.name}: ya al día (idempotente).`);
      continue;
    }

    if (!opts.yes && process.stdout.isTTY) {
      const orphanNote = orphans.length > 0 ? ` (+ ${orphans.length} huérfanos a eliminar)` : "";
      const ok = await p.confirm({ message: `¿Aplicar ${changes.length} cambios en ${adapter.name}?${orphanNote}` });
      if (p.isCancel(ok) || !ok) {
        p.log.warn(`${adapter.name}: omitido por el usuario.`);
        continue;
      }
      // La confirmación puede quedar abierta un buen rato: re-planificar para
      // no pisar lo que el runtime escribiera entremedias (p.ej. ~/.claude.json).
      plan = buildPlan(adapter, { ...ctx, warnings: [] });
      diff = diffPlan(plan);
      creates = diff.filter((d) => d.status === "create");
      updates = diff.filter((d) => d.status === "update");
      changes = [...creates, ...updates];
    }

    const backup = createBackup([...updates.map((c) => c.action.target), ...orphans], `install-${id}`);
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    applyChanges(changes);
    const pruneRoot = useManifest ? HOME : path.dirname(configDir);
    for (const orphan of orphans) {
      fs.rmSync(orphan, { force: true });
      pruneEmptyDirs(orphan, pruneRoot);
    }

    // Verificación de idempotencia: re-planificar debe dar cero cambios.
    const verifyCtx: InstallContext = { ...ctx, warnings: [] };
    const dirty = diffPlan(buildPlan(adapter, verifyCtx)).filter((d) => d.status !== "unchanged");
    if (dirty.length > 0) {
      p.log.error(`${adapter.name}: verificación de idempotencia FALLÓ (${dirty.length} acciones inestables).`);
      for (const d of dirty.slice(0, 10)) p.log.message(`  ! ${d.action.target}`);
      exitCode = 1;
    } else {
      writeManifest();
      p.log.success(`${adapter.name}: ${changes.length} archivos aplicados y verificados (idempotente).`);
    }
  }

  p.outro(opts.dryRun ? "Dry-run: no se ha escrito nada." : "Hecho.");
  return exitCode;
}
