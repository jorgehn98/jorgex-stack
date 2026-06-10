import path from "node:path";
import { existsSync } from "node:fs";
import { dataDir } from "./paths.js";
import { readTextIfExists, writeText } from "./fsx.js";
import type { RuntimeId, Tier } from "../adapters/types.js";

export interface TierModel {
  model: string;
  variant?: string;
}

export type RuntimeModelMap = Record<Tier, TierModel>;
export type ModelMap = Partial<Record<RuntimeId, RuntimeModelMap>>;

/**
 * Defaults por runtime (PRD §6.1). La elección real del usuario vive en
 * ~/.jorgex-stack/model-map.json (local, nunca en el repo); `jorgex-stack models`
 * la regenera. Claude Code usa alias auto-actualizables; fable es el nivel
 * superior (2026).
 */
export const DEFAULT_MODEL_MAP: Required<ModelMap> = {
  opencode: {
    strong: { model: "openai/gpt-5.4", variant: "high" },
    standard: { model: "openai/gpt-5.4-mini", variant: "high" },
    cheap: { model: "minimax/MiniMax-M3" },
  },
  "claude-code": {
    strong: { model: "fable" },
    standard: { model: "sonnet" },
    cheap: { model: "haiku" },
  },
  // Codex: "default" = no fijar modelo (usa el del CLI, que OpenAI actualiza
  // solo — D6); variant → model_reasoning_effort.
  codex: {
    strong: { model: "default", variant: "high" },
    standard: { model: "default", variant: "medium" },
    cheap: { model: "default", variant: "low" },
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
