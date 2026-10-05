import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import { ADAPTERS, applyChanges, configDirectory, diffPlan, executeNative, makeContext, stateDirectory, planRetiredHooks, type NativeExecutor } from "./install.js";
import { createBackup } from "./lib/backup.js";
import { loadCanonicalMcp } from "./lib/canonical.js";
import { isContainedIn, pruneEmptyDirs } from "./lib/fsx.js";
import { readManifest, removeRuntimeManifest, writeRuntimeManifest } from "./lib/manifest.js";
import { HOME } from "./lib/paths.js";
import { includesOwnedFile, type OperationScope } from "./lib/operation-scope.js";

export interface UninstallOptions extends OpenCodeTargetEvidenceOption {
  runtimes: RuntimeId[];
  scope?: OperationScope;
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  removeEngram: boolean;
  execute?: NativeExecutor;
}
export async function runUninstall(opts: UninstallOptions): Promise<number> {
  if (opts.targetDir && opts.runtimes.length !== 1) throw new Error("--target-dir requiere un runtime.");
  const state = stateDirectory(opts.targetDir);
  const manifestPath = path.join(state, "manifest.json");
  let exitCode = 0;
  const scope = opts.scope ?? { section: "all" };
  const configSelected = scope.section === "all" || scope.section === "config";
  for (const id of opts.runtimes) {
    try {
      const manifest = readManifest(manifestPath);
      const row = manifest.runtimes[id];
      if (!row) { p.log.info(`${id}: sin recursos propios registrados.`); continue; }
      const adapter = ADAPTERS[id];
      const ctx = makeContext(adapter, configDirectory(id, opts.targetDir), opts.targetDir);
      ctx.preserveEngram = true;
      ctx.browserControlInvocation = { command: "browser-control-mcp", args: [] };
      const otherRows = Object.entries(manifest.runtimes).filter(([runtime]) => runtime !== id).map(([, entry]) => entry!);
      const referenced = new Set(scope.section === "skills" ? [] : otherRows.flatMap((entry) => entry.owned));
      const sharedPrompt = adapter.paths(ctx.configDir).sharedPromptFile;
      const plan = configSelected ? [...planRetiredHooks(adapter, ctx, row.owned), ...adapter.planUnmerge(loadCanonicalMcp(ctx.stackDir), { hooks: {} }, ctx)].filter((action) => !(otherRows.length && action.target === sharedPrompt)) : [];
      const changes = diffPlan(plan).filter((change) => change.status !== "unchanged");
      const targets = new Set(plan.map((action) => action.target));
      const removable = row.owned.filter((file) => includesOwnedFile(adapter, ctx, scope, file) && !referenced.has(file) && !targets.has(file) && path.basename(file) !== "engram.ts" && fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
      for (const target of [...removable, ...changes.map((change) => change.action.target)]) {
        if (!isContainedIn(target, opts.targetDir ?? HOME)) throw new Error("Manifest dirige fuera del hogar; se conserva todo.");
        let parent = path.dirname(target);
        while (isContainedIn(parent, opts.targetDir ?? HOME)) {
          if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Ancestro enlazado; se conserva todo.");
          parent = path.dirname(parent);
        }
      }
      if (opts.dryRun) { p.log.info(`${id}: retiraría ${removable.length} archivos propios.`); continue; }
      createBackup([...removable, ...changes.map((change) => change.action.target), manifestPath], `uninstall-${id}`, path.join(state, "backups"));
      const execute = opts.execute ?? executeNative;
      if (configSelected && !opts.targetDir) {
        const bin = adapter.detect().binPath;
        if ((row.packages?.length || opts.removeEngram && row.engram) && !bin) throw new Error(`${id}: runtime ausente; quedan integraciones nativas por retirar.`);
        if (id === "pi") for (const source of [...row.packages ?? []]) {
          if (source === "npm:gentle-engram" && !opts.removeEngram) continue;
          execute(bin!, ["remove", source]);
          row.packages = row.packages!.filter((value) => value !== source);
          writeRuntimeManifest(id, row, manifestPath);
        }
        if (opts.removeEngram && row.engram) {
          if (id === "claude-code") { execute(bin!, ["plugin", "uninstall", "engram"]); execute(bin!, ["mcp", "remove", "engram", "--scope", "user"]); }
          else if (id === "codex") { execute(bin!, ["plugin", "remove", "engram@engram"]); execute(bin!, ["mcp", "remove", "engram"]); }
          else throw new Error("OpenCode: retira Engram explícitamente con el proveedor; Stack conserva su plugin/hooks/MCP y todos los datos.");
        }
      }
      applyChanges(changes);
      for (const target of removable) { fs.unlinkSync(target); pruneEmptyDirs(target, opts.targetDir ?? HOME); }
      const removed = new Set(removable);
      // Release selected references even when another runtime still owns the shared file.
      row.owned = row.owned.filter((file) => !includesOwnedFile(adapter, ctx, scope, file) || path.basename(file) === "engram.ts");
      if (configSelected) { row.mcpOwned = []; row.primaryOwned = []; }
      if (scope.section === "skills") {
        for (const [runtime, entry] of Object.entries(readManifest(manifestPath).runtimes)) {
          if (runtime === id || !entry) continue;
          entry.owned = entry.owned.filter((file) => !removed.has(file));
          writeRuntimeManifest(runtime as RuntimeId, entry, manifestPath);
        }
      }
      if (!row.owned.length && !row.packages?.length && !row.engram && !row.mcpOwned?.length && !row.primaryOwned?.length) removeRuntimeManifest(id, manifestPath);
      else writeRuntimeManifest(id, row, manifestPath);
      p.log.info(`${id}: recursos propios retirados. Engram binario/datos y herramientas compartidas se conservan.`);
    } catch (error) {
      exitCode = 1;
      const detail = error instanceof SyntaxError ? "Configuración JSON inválida (contenido omitido)."
        : error instanceof Error && "code" in error ? "Configuración ilegible; revisa ruta/permisos (contenido omitido)."
        : error instanceof Error ? error.message : "Fallo";
      p.log.error(`${id}: uninstall parcial. ${detail}; se conservan los recursos pendientes.`);
    }
  }
  return exitCode;
}
