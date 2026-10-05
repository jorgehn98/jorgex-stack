import fs from "node:fs";
import path from "node:path";
import type { RuntimeId } from "../adapters/types.js";
import { dataDir, HOME } from "./paths.js";
import { isContainedIn, readTextIfExists, writeText } from "./fsx.js";

export interface RuntimeManifest {
  configDir: string;
  /** Own files; shared resources may be referenced by several consumers. */
  owned: string[];
  mcpOwned?: string[];
  primaryOwned?: string[];
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
      for (const values of [row.mcpOwned, row.primaryOwned, row.packages]) {
        if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) throw new Error();
      }
    }
    return parsed;
  } catch { throw new Error(`Manifest inválido: ${file}. Restaura una copia antes de continuar.`); }
}
export type ManifestRead = { status: "absent" } | { status: "ok"; manifest: StackManifest } | { status: "invalid"; reason: string };
export function readManifestStrict(file = manifestFile()): ManifestRead {
  try {
    if (fs.lstatSync(file, { throwIfNoEntry: false }) === undefined) return { status: "absent" };
    return { status: "ok", manifest: readManifest(file) };
  } catch { return { status: "invalid", reason: `Manifest ilegible o inválido: ${file}` }; }
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
export function findOrphans(previous: string[], current: ReadonlySet<string>, root = HOME): string[] {
  return previous.filter((file) => !current.has(file) && path.basename(file) !== "engram.ts" && isContainedIn(file, root) && fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined);
}
