import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId } from "./adapters/types.js";
import type { AgentModel } from "./lib/agent-model.js";
import { ADAPTERS, makeContext, stateDirectory, assertOpenCodeV2Preflight } from "./install.js";
import { discoverModels, openCodeServerAddress, type ModelCatalog } from "./lib/native-model-catalog.js";
import { readAgentModel, saveAgentModel } from "./lib/agent-model.js";

const KEEP = { action: "keep" } as const;
const INHERIT = { action: "inherit" } as const;
const MANUAL = { action: "manual" } as const;
const BACK = { action: "back" } as const;

export async function chooseAgentModel(runtime: RuntimeId, current: AgentModel, catalog: ModelCatalog, field: "model" | "effort" | "both" = "both"): Promise<AgentModel | undefined> {
  if (catalog.warning) p.log.warn(catalog.warning);
  p.log.info("Catálogo observado en la ubicación actual; un ID no prueba acceso. El arranque nativo puede cargar plugins/hooks y cachés.");
  const chosen = field === "effort" ? KEEP : await p.select<string | typeof KEEP | typeof INHERIT | typeof MANUAL | typeof BACK>({
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
  if (field === "model") {
    if (runtime === "opencode" && !model && current.variant) {
      p.log.warn("Heredar modelo requiere heredar primero la variante de OpenCode; selección conservada.");
      return undefined;
    }
    if (model !== current.model && current.variant) p.log.info("Se conserva el esfuerzo/variante existente, sin acreditar soporte para el nuevo modelo.");
    return { ...(model ? { model } : {}), ...(current.variant ? { variant: current.variant } : {}) };
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

export async function editAgent(runtime: RuntimeId, name: string, route: string): Promise<void> {
  const adapter = ADAPTERS[runtime];
  const detection = adapter.detect();
  if (!detection.installed || !detection.binPath) { p.log.warn("Runtime ausente; sin cambios."); return; }
  if (runtime === "opencode") assertOpenCodeV2Preflight({}, detection.binPath);
  const ctx = makeContext(adapter, detection.configDir);
  const file = path.join(adapter.paths(detection.configDir).agentsDir, `${name}.${runtime === "codex" ? "toml" : "md"}`);
  if (!fs.existsSync(file) || !ctx.ownedFiles?.has(file)) { p.log.warn("Agente ausente o ajeno; aplica su definición gestionada primero."); return; }
  let unit = readAgentModel(runtime, file);
  let draft = unit.selection;
  let catalog: ModelCatalog | undefined;
  while (true) {
    p.log.info(`JorgeX Stack · ${route}\nModelo: ${draft.model ?? "herencia"} · Esfuerzo/variante: ${draft.variant ?? "herencia"}`);
    let action: string | symbol = await p.select({ message: "Agente", options: [
      { value: "model", label: "Modelo" }, { value: "effort", label: "Esfuerzo / variante" },
      { value: "save", label: "Guardar y aplicar" }, { value: "back", label: "Volver" },
    ] });
    const dirty = JSON.stringify(draft) !== JSON.stringify(unit.selection);
    const leaving = p.isCancel(action) || action === "back";
    if (leaving) {
      if (!dirty) return;
      action = await p.select({ message: "Cambios pendientes de este agente", options: [
        { value: "save", label: "Guardar y aplicar" }, { value: "discard", label: "Descartar" }, { value: "continue", label: "Continuar editando" },
      ] });
      if (action === "discard") return;
      if (p.isCancel(action) || action === "continue") continue;
    }
    try {
      if (action === "save") {
        if (!dirty) { p.log.info("Sin cambios pendientes."); continue; }
        saveAgentModel(runtime, file, unit.content, draft, ctx.ownedFiles!, detection.configDir, path.join(stateDirectory(), "backups"));
        unit = readAgentModel(runtime, file);
        draft = unit.selection;
        p.log.success("Agente guardado con backup. Nueva sesión o reload para usarlo; volver no deshace lo guardado.");
        if (leaving) return;
      } else if (action === "model" || action === "effort") {
        if (!catalog) {
          let server: string | undefined;
          if (runtime === "opencode") {
            const observed = openCodeServerAddress();
            if (observed.warning) p.log.warn(observed.warning);
            const answer = await p.text({ message: "Servidor OpenCode v2 existente (loopback; URL nativa observada si disponible)", initialValue: observed.url });
            if (p.isCancel(answer)) continue;
            server = answer;
          }
          catalog = await discoverModels(runtime, detection.binPath, process.cwd(), server);
        }
        draft = await chooseAgentModel(runtime, draft, catalog, action) ?? draft;
      }
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : "No se pudo aplicar el agente.");
      p.log.warn("Unidad pendiente; lo guardado anteriormente permanece. Reintenta explícitamente Guardar o descarta.");
    }
  }
}
