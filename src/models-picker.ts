import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import type { AgentModel } from "./lib/agent-model.js";
import { loadCanonicalAgents } from "./lib/canonical.js";
import { stackRoot } from "./lib/paths.js";
import { ADAPTERS, makeContext, stateDirectory, assertOpenCodeV2Preflight } from "./install.js";
import { discoverModels, type ModelCatalog } from "./lib/native-model-catalog.js";
import { readAgentModel, saveAgentModel } from "./lib/agent-model.js";

const KEEP = { action: "keep" } as const;
const INHERIT = { action: "inherit" } as const;
const MANUAL = { action: "manual" } as const;
const BACK = { action: "back" } as const;

export async function chooseAgentModel(runtime: RuntimeId, current: AgentModel, catalog: ModelCatalog): Promise<AgentModel | undefined> {
  if (catalog.warning) p.log.warn(catalog.warning);
  p.log.info("Catálogo observado en la ubicación actual; un ID no prueba acceso. El arranque nativo puede cargar plugins/hooks y cachés.");
  const chosen = await p.select<string | typeof KEEP | typeof INHERIT | typeof MANUAL | typeof BACK>({
    message: "Modelo del agente",
    options: [
      { value: KEEP, label: `Mantener ${current.model ?? "herencia"}${current.model && !catalog.models.some((model) => model.id === current.model) ? " (no figura en el catálogo)" : ""}` },
      { value: INHERIT, label: "Heredar — sin override de modelo" },
      ...catalog.models.map((model) => ({ value: model.id, label: `${model.name} · ${model.id}` })),
      { value: MANUAL, label: "Introducir ID exacto (sin acreditar acceso)" },
      { value: BACK, label: "Volver" },
    ], maxItems: 12,
  });
  if (p.isCancel(chosen) || chosen === BACK) return undefined;
  let model = chosen === KEEP ? current.model : chosen === INHERIT ? undefined : chosen as string;
  if (chosen === MANUAL) {
    p.log.warn("ID manual: no se certifica soporte ni entitlement; consulta el runtime si falla.");
    const typed = await p.text({ message: "ID exacto (sin normalizar ni sustituir aliases)", initialValue: current.model, validate: (value) => !value?.trim() || /[\x00-\x1f\x7f]/.test(value) ? "Introduce un ID sin caracteres de control." : undefined });
    if (p.isCancel(typed)) return undefined;
    model = typed.trim();
  }
  const efforts = model ? catalog.models.find((item) => item.id === model)?.efforts : undefined;
  if (!efforts) p.log.info("Esfuerzos/variantes desconocidos para esta selección: solo mantener o heredar.");
  const effort = await p.select<string | typeof KEEP | typeof INHERIT | typeof MANUAL | typeof BACK>({
    message: runtime === "opencode" ? "Variante del agente (no escala universal)" : "Esfuerzo del agente",
    options: [
      { value: KEEP, label: `Mantener ${current.variant ?? "herencia"}${current.variant && !efforts?.includes(current.variant) ? " (no acreditado para esta selección)" : ""}` },
      { value: INHERIT, label: "Heredar — sin override de esfuerzo/variante" },
      ...(efforts ?? []).map((value) => ({ value, label: value })),
    ],
  });
  const variant = p.isCancel(effort) || effort === KEEP ? current.variant : effort === INHERIT ? undefined : effort as string;
  if (runtime === "opencode" && !model && variant) {
    p.log.warn("OpenCode requiere modelo del agente para persistir una variante; se conserva la selección, sin guardar.");
    return undefined;
  }
  return { ...(model ? { model } : {}), ...(variant ? { variant } : {}) };
}

/** T07 consumes this same picker; no lifecycle operations run when changing a model. */
export async function runModelsPicker(opts: { yes: boolean; runtimes: RuntimeId[] }): Promise<number> {
  if (opts.yes || !process.stdout.isTTY) { p.log.warn("La edición individual requiere un terminal interactivo. No se ha cambiado configuración."); return 1; }
  p.intro("Modelos y esfuerzos · guardar por agente");
  const agents = loadCanonicalAgents(path.join(stackRoot(), "agents"));
  while (true) {
    const runtime = await p.select<RuntimeId | typeof BACK>({ message: "Runtime", options: [...opts.runtimes.map((id) => ({ value: id, label: ADAPTERS[id].name })), { value: BACK, label: "Volver" }] });
    if (p.isCancel(runtime) || runtime === BACK) return 0;
    const id = runtime as RuntimeId;
    const adapter = ADAPTERS[id];
    const detection = adapter.detect();
    if (!detection.installed || !detection.binPath) { p.log.warn("Runtime no instalado; instala/configura primero. No se ha cambiado nada."); continue; }
    while (true) {
      const name = await p.select<string | typeof KEEP | typeof INHERIT | typeof MANUAL | typeof BACK>({ message: `${adapter.name} · agente`, options: [...agents.map((agent) => ({ value: agent.name, label: agent.name })), { value: BACK, label: "Volver" }] });
      if (p.isCancel(name) || name === BACK) break;
      try {
        if (id === "opencode") assertOpenCodeV2Preflight({}, detection.binPath);
        const ctx = makeContext(adapter, detection.configDir);
        const file = path.join(adapter.paths(detection.configDir).agentsDir, `${String(name)}.${id === "codex" ? "toml" : "md"}`);
        if (!fs.existsSync(file) || !ctx.ownedFiles?.has(file)) { p.log.warn("Agente ausente o ajeno: se conserva. Instala/configura el agente gestionado primero."); continue; }
        const unit = readAgentModel(id, file);
        let server: string | undefined;
        if (id === "opencode") {
          const address = await p.text({ message: "Servidor OpenCode v2 existente (loopback; no se inicia un servicio)", initialValue: "http://127.0.0.1:4096" });
          if (p.isCancel(address)) continue;
          server = address;
        }
        const catalog = await discoverModels(id, detection.binPath, process.cwd(), server);
        let selection = await chooseAgentModel(id, unit.selection, catalog);
        while (selection) {
          const action = await p.select({ message: "Cambios de este agente", options: [{ value: "save", label: "Guardar y aplicar" }, { value: "discard", label: "Descartar y volver" }, { value: "continue", label: "Continuar editando" }] });
          if (p.isCancel(action)) { p.log.info("Cambios sin guardar: elige guardar, descartar o continuar."); continue; }
          if (action === "discard") break;
          if (action === "continue") { selection = await chooseAgentModel(id, selection, catalog) ?? selection; continue; }
          saveAgentModel(id, file, unit.content, selection, ctx.ownedFiles!, detection.configDir, path.join(stateDirectory(), "backups"));
          p.log.success("Agente guardado con backup. Nueva sesión o reload del runtime para usarlo; volver no deshace lo guardado.");
          break;
        }
      } catch (error) {
        // Persistence diagnostics are ours, never provider response text.
        p.log.error(error instanceof Error ? error.message : "No se pudo guardar el agente; configuración conservada.");
      }
    }
  }
}
