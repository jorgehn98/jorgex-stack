import path from "node:path";
import { existsSync } from "node:fs";
import { dataDir } from "./paths.js";
import { readTextIfExists, writeText } from "./fsx.js";
import type { RuntimeId, Tier } from "../adapters/types.js";

export interface TierModel {
  model: string;
  variant?: string;
}

/**
 * Mapa por tier + ajuste fino opcional: "overrides" por nombre de agente pisa
 * el tier de ESE agente (p.ej. code-reviewer y silent-failure-hunter son ambos
 * strong, pero pueden llevar modelos distintos). Se edita a mano en
 * model-map.json; el picker por tiers lo preserva.
 */
export type RuntimeModelMap = Record<Tier, TierModel> & {
  overrides?: Record<string, Partial<TierModel>>;
};
export type ModelMap = Partial<Record<RuntimeId, RuntimeModelMap>>;
type DefaultModelMap = {
  "claude-code": RuntimeModelMap;
  codex: RuntimeModelMap;
  opencode?: never;
};

/**
 * Modelo efectivo de un subagente: override por nombre > tier. Un override
 * con `"variant": ""` limpia el variant del tier (modelo sin variant).
 */
export function resolveAgentModel(models: RuntimeModelMap, agentName: string, tier: Tier): TierModel {
  const base = models[tier];
  const override = models.overrides?.[agentName];
  if (!override) return base;
  return {
    model: override.model || base.model,
    variant: "variant" in override ? override.variant || undefined : base.variant,
  };
}

/**
 * Defaults de los runtimes con catálogo controlado. OpenCode se omite porque
 * sus proveedores dependen de cada usuario: la primera instalación interactiva
 * construye su mapa desde `opencode models`. La elección vive en
 * ~/.jorgex-stack/model-map.json (local, nunca en el repo).
 */
export const DEFAULT_MODEL_MAP: DefaultModelMap = {
  "claude-code": {
    strong: { model: "fable" },
    standard: { model: "sonnet" },
    cheap: { model: "haiku" },
  },
  // El primary (orchestrator) no usa estos tiers: tanto el profile de CLI como
  // la skill de la app heredan el modelo elegido por el usuario. Estos defaults
  // son solo para subagentes; variant → model_reasoning_effort.
  codex: {
    strong: { model: "gpt-6-astra", variant: "max" },
    standard: { model: "gpt-5.6-sol", variant: "medium" },
    cheap: { model: "gpt-5.6-luna", variant: "medium" },
    overrides: {
      implementer: { model: "gpt-5.6-luna", variant: "max" },
      tester: { model: "gpt-5.6-luna", variant: "max" },
      "silent-failure-hunter": { model: "gpt-5.6-sol", variant: "medium" },
    },
  },
};

export function modelMapFile(): string {
  return path.join(dataDir(), "model-map.json");
}

export function loadModelMap(): ModelMap {
  const file = modelMapFile();
  const raw = readTextIfExists(file);
  if (raw === null) return DEFAULT_MODEL_MAP;
  let fromDisk: ModelMap;
  try {
    fromDisk = JSON.parse(raw) as ModelMap;
  } catch {
    throw new Error(`El mapa de modelos ${file} contiene JSON inválido. Corrige el JSON o restaura una copia antes de continuar.`);
  }
  // Merge por tier: un runtime editado a mano sin algún tier hereda el default.
  const merged: ModelMap = { ...fromDisk };
  for (const id of Object.keys(DEFAULT_MODEL_MAP) as RuntimeId[]) {
    merged[id] = { ...DEFAULT_MODEL_MAP[id]!, ...(fromDisk[id] ?? {}) } as RuntimeModelMap;
    // Un mapa guardado decide sus overrides; no imponer los de una instalación nueva.
    if (fromDisk[id] && !Object.hasOwn(fromDisk[id], "overrides")) delete merged[id]!.overrides;
  }
  return merged;
}

/** Crea el archivo con los defaults si no existe; devuelve su ruta. */
export function ensureModelMapFile(): string {
  const file = modelMapFile();
  if (!existsSync(file)) {
    writeText(file, JSON.stringify(DEFAULT_MODEL_MAP, null, 2) + "\n");
  }
  return file;
}
