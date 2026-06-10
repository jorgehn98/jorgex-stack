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
export const DEFAULT_MODEL_MAP: Required<Pick<ModelMap, "opencode" | "claude-code">> & ModelMap = {
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
};

export function modelMapFile(): string {
  return path.join(dataDir(), "model-map.json");
}

export function loadModelMap(): ModelMap {
  const raw = readTextIfExists(modelMapFile());
  if (raw === null) return DEFAULT_MODEL_MAP;
  const fromDisk = JSON.parse(raw) as ModelMap;
  return { ...DEFAULT_MODEL_MAP, ...fromDisk };
}

/** Crea el archivo con los defaults si no existe; devuelve su ruta. */
export function ensureModelMapFile(): string {
  const file = modelMapFile();
  if (!existsSync(file)) {
    writeText(file, JSON.stringify(DEFAULT_MODEL_MAP, null, 2) + "\n");
  }
  return file;
}
