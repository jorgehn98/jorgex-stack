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
 * el tier de ESE agente (p.ej. security-auditor y silent-failure-hunter son
 * ambos strong, pero pueden llevar modelos distintos). Se edita a mano en
 * model-map.json; el picker por tiers lo preserva.
 */
export type RuntimeModelMap = Record<Tier, TierModel> & {
  overrides?: Record<string, Partial<TierModel>>;
};
export type ModelMap = Partial<Record<RuntimeId, RuntimeModelMap>>;
type DefaultModelMap = {
  "claude-code": RuntimeModelMap;
  codex: RuntimeModelMap;
  opencode: RuntimeModelMap;
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
 * Defaults de los runtimes con catálogo controlado. OpenCode v2 ya no espera
 * una primera selección interactiva de proveedores: su roster aprobado vive
 * aquí (Spec T04) y un install/sync fresh (incluido `--yes`/sin TTY) lo
 * siembra. La elección del usuario sigue viviendo en
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
    strong: { model: "gpt-6-astra", variant: "low" },
    standard: { model: "gpt-5.6-luna", variant: "max" },
    cheap: { model: "gpt-5.6-luna", variant: "medium" },
  },
  // Roster v2 aprobado (Spec T04). Los subagentes que no encajan en su tier
  // llevan override explícito; el primary (orchestrator) nunca fija modelo.
  opencode: {
    strong: { model: "openai/gpt-6.1-sol", variant: "xhigh" },
    standard: { model: "openai/gpt-6.1-sol", variant: "medium" },
    cheap: { model: "opencode-go/muse-spark-1.3-contributor", variant: "medium" },
    overrides: {
      "test-analyzer": { model: "openai/gpt-6-luna", variant: "max" },
      "type-design-analyzer": { model: "openai/gpt-6-luna", variant: "max" },
      implementer: { model: "opencode-go/deepseek-v4.1-flash", variant: "high" },
      tester: { model: "opencode-go/deepseek-v4.1-flash", variant: "high" },
      "docs-maintainer": { model: "minimax/MiniMax-M3", variant: "thinking" },
      engram: { model: "minimax/MiniMax-M3", variant: "thinking" },
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
