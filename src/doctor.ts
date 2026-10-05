import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import { ADAPTERS, assertOpenCodeV2Preflight, buildScopedPlan, configDirectory, diffPlan, makeContext, stateDirectory } from "./install.js";
import { detectEngram, engramVersion, lookPath } from "./lib/detect.js";
import { officialSetupVerifiers } from "./lib/official-engram-setup.js";
import { readManifest } from "./lib/manifest.js";
import { HOME } from "./lib/paths.js";
import { readTextIfExists } from "./lib/fsx.js";
import { includesOwnedFile, type OperationScope } from "./lib/operation-scope.js";

export interface DoctorOptions { scope?: OperationScope; targetDir?: string; runtimes?: RuntimeId[]; opencodeTargetMajor?: number }
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  let failures = 0;
  const scope = opts.scope ?? { section: "all" };
  const configSelected = scope.section === "all" || scope.section === "config";
  const engram = opts.targetDir ? null : detectEngram();
  if (configSelected && !opts.targetDir && (!engram || !engramVersion(engram))) { p.log.warn("Engram binario ausente o no responde; doctor no lo instala ni prueba memorias."); failures++; }
  try { readManifest(path.join(stateDirectory(opts.targetDir), "manifest.json")); }
  catch { p.log.error("Manifest ilegible: restaura un backup antes de mutar configuración."); return 1; }
  for (const id of opts.runtimes ?? Object.keys(ADAPTERS) as RuntimeId[]) {
    try {
      const adapter = ADAPTERS[id];
      const detection = adapter.detect();
      if (!opts.targetDir && !detection.binPath) throw new Error(`${adapter.name} ausente; instala el runtime oficial.`);
      if (id === "opencode") assertOpenCodeV2Preflight(opts, detection.binPath);
      const configDir = configDirectory(id, opts.targetDir);
      const ctx = makeContext(adapter, configDir, opts.targetDir);
      if (configSelected && ctx.writingStyle.originalContent !== ctx.writingStyle.installedContent) throw new Error("Fuente de estilo ausente o desactualizada; aplica configuración deliberadamente.");
      if (configSelected && id === "pi") {
        const policyFile = path.join(configDir, "extensions", "pi-permission-system", "config.json");
        let raw: string | null;
        try { raw = readTextIfExists(policyFile); }
        catch { throw new Error("Pi: no se puede leer la configuración nativa de permisos; revisa ruta/permisos. No se modifica."); }
        if (raw !== null) {
          let policy: unknown;
          try { policy = JSON.parse(raw); }
          catch { throw new Error("Pi: configuración nativa de permisos JSON inválida (contenido omitido). No se modifica."); }
          if (policy === null || typeof policy !== "object" || Array.isArray(policy)
            || ("permission" in policy && (policy.permission === null || typeof policy.permission !== "object" || Array.isArray(policy.permission)))) {
            throw new Error("Pi: estructura de configuración nativa de permisos inválida (contenido omitido). No se modifica.");
          }
          p.log.info("Pi: configuración nativa de permisos presente; el proveedor controla su aplicación. Stack no la reescribe ni certifica enforcement.");
        }
      }
      if (configSelected && (id === "pi" || id === "opencode")) {
        ctx.browserControlInvocation = { command: "browser-control-mcp", args: [] };
        if (!opts.targetDir && !lookPath("browser-control-mcp")) throw new Error("Browser Control ausente. Requiere Node>=22.19, extensión Chromium y adopción explícita de pestaña; doctor no inicia el relay.");
      }
      const drift = diffPlan(buildScopedPlan(adapter, ctx, scope)).filter((change) => change.status !== "unchanged");
      for (const warning of ctx.warnings) p.log.warn(warning);
      if (drift.length) throw new Error(`${drift.length} recursos ausentes o pendientes de reconciliación; abre jorgex-stack → Instalar/configurar y elige Aplicar para la unidad afectada.`);
      if (configSelected && !opts.targetDir && engram) {
        const verified = await officialSetupVerifiers[id]?.({ configDir, engramBin: engram, homeDir: HOME });
        if (!verified?.ok) throw new Error("Engram: integración oficial incompleta; doctor no repara ni escribe memorias.");
      }
      const row = readManifest(path.join(stateDirectory(opts.targetDir), "manifest.json")).runtimes[id];
      for (const file of row?.owned ?? []) if (includesOwnedFile(adapter, ctx, scope, file) && !fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Recurso gestionado ausente: ${file}`);
      if (id === "codex") p.log.info("Codex: lectores conservan shell; aislamiento solo por sesión padre readonly, no garantía por perfil.");
      if (id === "claude-code") p.log.info("Claude browser requiere integración Chrome/cuenta compatibles; Stack no añade browser.");
      if (id === "codex") p.log.info("Codex CLI no acredita browser desktop; sin fallback adicional.");
      p.log.info(`${id}: configuración local comprobada, no certifica carga/enforcement runtime.`);
    } catch (error) {
      failures++;
      const detail = error instanceof SyntaxError ? "Configuración JSON inválida (contenido omitido)."
        : error instanceof Error && "code" in error ? "Configuración ilegible; revisa ruta/permisos (contenido omitido)."
        : error instanceof Error ? error.message : "Estado no verificable";
      p.log.error(`${id}: ${detail}`);
    }
  }
  return failures ? 1 : 0;
}
