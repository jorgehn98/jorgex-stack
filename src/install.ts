import fs from "node:fs";
import * as p from "@clack/prompts";
import type { Adapter, FileAction, InstallContext, RuntimeId } from "./adapters/types.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { stackRoot } from "./lib/paths.js";
import { detectEngram } from "./lib/detect.js";
import { copyFile, readTextIfExists, sameFileContent, writeText } from "./lib/fsx.js";
import { ensureModelMapFile, loadModelMap } from "./lib/model-map.js";
import { createBackup } from "./lib/backup.js";
import { planSystemPrompt } from "./components/system-prompt.js";
import { planAgents } from "./components/agents.js";
import { planSkills } from "./components/skills.js";
import { planCommands } from "./components/commands.js";
import { planHooks } from "./components/hooks.js";
import { planMcp } from "./components/mcp.js";
import { planPlugins } from "./components/plugins.js";

export const ADAPTERS: Partial<Record<RuntimeId, Adapter>> = {
  opencode: opencodeAdapter,
  // "claude-code": F3 · codex: F4 (PRD §11)
};

export interface InstallOptions {
  runtimes: RuntimeId[];
  /** Override del dir de config destino (pruebas/paridad). Solo válido con un único runtime. */
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
}

type PlannedChange = { action: FileAction; status: "create" | "update" | "unchanged" };

function buildPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
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

function diffPlan(plan: FileAction[]): PlannedChange[] {
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

export async function runInstall(opts: InstallOptions): Promise<number> {
  p.intro(`jorgex-stack ${opts.dryRun ? "install (dry-run)" : "install"}`);

  const stackDir = stackRoot();
  const engramBin = detectEngram();
  const modelMap = loadModelMap();
  ensureModelMapFile();

  p.log.info(engramBin ? `Engram detectado: ${engramBin} (se respeta, D7)` : "Engram NO detectado.");

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

    const diff = diffPlan(buildPlan(adapter, ctx));
    const creates = diff.filter((d) => d.status === "create");
    const updates = diff.filter((d) => d.status === "update");
    const changes = [...creates, ...updates];

    p.log.step(`${adapter.name} → ${configDir}`);
    p.log.info(
      `${diff.length} archivos gestionados: ${creates.length} nuevos, ${updates.length} modificados, ${diff.length - changes.length} sin cambios`,
    );
    for (const w of ctx.warnings) p.log.warn(w);

    if (opts.dryRun) {
      for (const c of changes.slice(0, 40)) p.log.message(`  ${c.status === "create" ? "+" : "~"} ${c.action.target}`);
      if (changes.length > 40) p.log.message(`  … y ${changes.length - 40} más`);
      continue;
    }

    if (changes.length === 0) {
      p.log.success(`${adapter.name}: ya al día (idempotente).`);
      continue;
    }

    const backup = createBackup(
      updates.map((c) => c.action.target),
      `install-${id}`,
    );
    if (backup) p.log.info(`Backup: ${backup.id} (${backup.files.length} archivos)`);

    applyChanges(changes);

    // Verificación de idempotencia: re-planificar debe dar cero cambios.
    const verifyCtx: InstallContext = { ...ctx, warnings: [] };
    const dirty = diffPlan(buildPlan(adapter, verifyCtx)).filter((d) => d.status !== "unchanged");
    if (dirty.length > 0) {
      p.log.error(`${adapter.name}: verificación de idempotencia FALLÓ (${dirty.length} acciones inestables).`);
      for (const d of dirty.slice(0, 10)) p.log.message(`  ! ${d.action.target}`);
      exitCode = 1;
    } else {
      p.log.success(`${adapter.name}: ${changes.length} archivos aplicados y verificados (idempotente).`);
    }
  }

  p.outro(opts.dryRun ? "Dry-run: no se ha escrito nada." : "Hecho.");
  return exitCode;
}
