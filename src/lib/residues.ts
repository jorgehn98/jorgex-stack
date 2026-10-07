import fs from "node:fs";
import path from "node:path";

export type ResidueKind = "private" | "user-config";
export type ResidueBase = "state" | "opencode" | "pi";
export interface KnownResidue {
  base: ResidueBase;
  /** Relative to its base. A trailing `*` matches directories by name prefix. */
  path: string;
  kind: ResidueKind;
}
export interface ResidueDirs { stateDir: string; configDirs: { opencode?: string; pi?: string } }
export interface Residue { path: string; kind: ResidueKind; bytes: number | null; remedy: string }

/**
 * Paths written by earlier Stack versions that nothing reads any more.
 * "private" ones live in directories only Stack created; "user-config" ones sit
 * in the user's runtime configuration and are only ever reported.
 */
export const KNOWN_RESIDUES: readonly KnownResidue[] = [
  ...["install-mode.json", "model-map.json", "primary-model.json", "pi-receipt.json", "pi-projection-receipt.json", "playwright-cli.json", "devtools-mcp.json", "packages", ".browser-managed"]
    .map((file): KnownResidue => ({ base: "state", path: file, kind: "private" })),
  { base: "pi", path: "stage-*", kind: "private" },
  { base: "pi", path: "jorgex-pi", kind: "private" },
  { base: "pi", path: "npm/jorgex-pi-managed", kind: "private" },
  { base: "opencode", path: "plugins/stack-hooks.ts", kind: "user-config" },
  { base: "opencode", path: "commands/xreview.md", kind: "user-config" },
  { base: "pi", path: "prompts/lean-audit.md", kind: "user-config" },
  { base: "pi", path: "extensions/jorgex-compact-tools", kind: "user-config" },
];

const REMEDY: Record<ResidueKind, string> = {
  private: "Stack ya no lo lee; puedes borrarlo a mano.",
  "user-config": "Stack no lo retira: comprueba que no lo has personalizado y bórralo a mano.",
};

/** Bytes of a file, or of every entry under a directory; links are never followed. null when unreadable or absent. */
export function treeBytes(target: string): number | null {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(target)) {
      const bytes = treeBytes(path.join(target, entry));
      if (bytes === null) return null;
      total += bytes;
    }
    return total;
  } catch { return null; }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "tamaño desconocido";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function matches(base: string, relative: string): string[] {
  const target = path.join(base, ...relative.split("/"));
  try {
    if (!relative.endsWith("*")) return fs.lstatSync(target, { throwIfNoEntry: false }) ? [target] : [];
    const prefix = path.basename(target).slice(0, -1);
    return fs.readdirSync(path.dirname(target), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => path.join(path.dirname(target), entry.name)).sort();
  } catch { return []; }
}

/** Known residues that exist under the given directories. Read-only; a runtime without configDir is skipped. */
export function findResidues(dirs: ResidueDirs): Residue[] {
  return KNOWN_RESIDUES.flatMap(({ base, path: relative, kind }) => {
    const root = base === "state" ? dirs.stateDir : dirs.configDirs[base];
    return root ? matches(root, relative).map((file) => ({ path: file, kind, bytes: treeBytes(file), remedy: REMEDY[kind] })) : [];
  });
}
