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
 * el tier de ESE agente (p.ej. backend-analyst y code-reviewer son ambos
 * strong, pero pueden llevar modelos distintos). Se edita a mano en
 * model-map.json; el picker por tiers lo preserva.
 */
export type RuntimeModelMap = Record<Tier, TierModel> & {
  overrides?: Record<string, Partial<TierModel>>;
};
export type ModelMap = Partial<Record<RuntimeId, RuntimeModelMap>>;

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
 * Defaults por runtime (PRD §6.1). La elección real del usuario vive en
 * ~/.jorgex-stack/model-map.json (local, nunca en el repo); `jorgex-stack models`
 * la regenera. Claude Code usa alias auto-actualizables; fable es el nivel
 * superior (2026).
 */
export const DEFAULT_MODEL_MAP: Required<ModelMap> = {
  opencode: {
    strong: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
    standard: { model: "openai/gpt-5.6-terra", variant: "xhigh" },
    cheap: { model: "minimax/MiniMax-M3", variant: "high" },
  },
  "claude-code": {
    strong: { model: "fable" },
    standard: { model: "sonnet" },
    cheap: { model: "haiku" },
  },
  // El primary (orchestrator) no usa estos tiers: tanto el profile de CLI como
  // la skill de la app heredan el modelo elegido por el usuario. Estos defaults
  // son solo para subagentes; variant → model_reasoning_effort.
  codex: {
    strong: { model: "gpt-5.6-terra", variant: "xhigh" },
    standard: { model: "gpt-5.6-terra", variant: "xhigh" },
    cheap: { model: "gpt-5.6-luna", variant: "medium" },
  },
};

export function modelMapFile(): string {
  return path.join(dataDir(), "model-map.json");
}

export function loadModelMap(): ModelMap {
  const raw = readTextIfExists(modelMapFile());
  if (raw === null) return DEFAULT_MODEL_MAP;
  let fromDisk: ModelMap;
  try {
    fromDisk = JSON.parse(raw) as ModelMap;
  } catch {
    // model-map corrupto: defaults para no brickear todos los comandos;
    // 'models' lo regenera.
    return DEFAULT_MODEL_MAP;
  }
  // Merge por tier: un runtime editado a mano sin algún tier hereda el default.
  const merged: ModelMap = {};
  for (const id of Object.keys(DEFAULT_MODEL_MAP) as RuntimeId[]) {
    merged[id] = { ...DEFAULT_MODEL_MAP[id], ...(fromDisk[id] ?? {}) };
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
