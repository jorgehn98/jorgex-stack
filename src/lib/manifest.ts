import path from "node:path";
import type { RuntimeId } from "../adapters/types.js";
import { dataDir } from "./paths.js";
import { readTextIfExists, writeText } from "./fsx.js";

export interface RuntimeManifest {
  configDir: string;
  /** Own files; shared resources may be referenced by several consumers. */
  owned: string[];
  mcpOwned?: string[];
  configOwned?: string[];
  packages?: string[];
  engram?: boolean;
  updatedAt: string;
}
export interface StackManifest { runtimes: Partial<Record<RuntimeId, RuntimeManifest>> }
export function manifestFile(): string { return path.join(dataDir(), "manifest.json"); }

export function readManifest(file = manifestFile()): StackManifest {
  const raw = readTextIfExists(file);
  if (raw === null) return { runtimes: {} };
  try {
    const parsed = JSON.parse(raw) as StackManifest;
    if (!parsed || typeof parsed !== "object" || !parsed.runtimes || typeof parsed.runtimes !== "object" || Array.isArray(parsed.runtimes)) throw new Error();
    for (const [id, row] of Object.entries(parsed.runtimes)) {
      if (!["claude-code", "codex", "opencode", "pi"].includes(id) || !row || typeof row.configDir !== "string" || !path.isAbsolute(row.configDir)
        || !Array.isArray(row.owned) || row.owned.some((value) => typeof value !== "string" || !path.isAbsolute(value))) throw new Error();
      for (const values of [row.mcpOwned, row.configOwned, row.packages]) {
        if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) throw new Error();
      }
    }
    return parsed;
  } catch { throw new Error(`Manifest inválido: ${file}. Restaura una copia antes de continuar.`); }
}
export function writeRuntimeManifest(id: RuntimeId, entry: RuntimeManifest, file = manifestFile()): void {
  const manifest = readManifest(file);
  manifest.runtimes[id] = entry;
  writeText(file, JSON.stringify(manifest, null, 2) + "\n");
}
export function removeRuntimeManifest(id: RuntimeId, file = manifestFile()): void {
  const manifest = readManifest(file);
  delete manifest.runtimes[id];
  writeText(file, JSON.stringify(manifest, null, 2) + "\n");
}
