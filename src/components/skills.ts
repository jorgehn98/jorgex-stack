import fs from "node:fs";
import path from "node:path";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { isContainedIn, listFilesRecursive } from "../lib/fsx.js";
import { planOwnedProjection } from "../lib/owned-projection.js";

/** Una skill del origen: `stack/skills/<categoría>/<nombre>`, instalada siempre plana. */
export interface SkillEntry {
  category: string;
  name: string;
  dir: string;
}

/** Categorías que arrastran otra categoría: el orchestrator usa `to-spec`, `grilling` y `second-opinion`. */
const CATEGORY_REQUIREMENTS: Record<string, readonly string[]> = { engineering: ["productivity"] };

function subdirectories(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export function listSkillCategories(stackDir: string): string[] {
  return subdirectories(path.join(stackDir, "skills"));
}

/** Descubre el origen de dos niveles. Un nombre repetido entre categorías no cabe en el destino plano y bloquea la instalación. */
export function listSkills(stackDir: string): SkillEntry[] {
  const root = path.join(stackDir, "skills");
  const seen = new Set<string>();
  return subdirectories(root).flatMap((category) => subdirectories(path.join(root, category)).map((name) => {
    if (seen.has(name)) throw new Error(`Skill duplicada entre categorías: ${name}`);
    seen.add(name);
    return { category, name, dir: path.join(root, category, name) };
  }));
}

/** Categorías pedidas más sus requisitos, en el orden del origen. `added` son las que el aviso debe mencionar. */
export function resolveSkillCategories(selected: readonly string[], available: readonly string[]): { categories: string[]; added: string[] } {
  const known = new Set(available);
  const unknown = selected.find((category) => !known.has(category));
  if (unknown) throw new Error(`Categoría de skills desconocida: ${unknown}`);
  const wanted = new Set(selected);
  const added: string[] = [];
  for (const category of selected) for (const requirement of CATEGORY_REQUIREMENTS[category] ?? []) {
    if (wanted.has(requirement) || !known.has(requirement)) continue;
    wanted.add(requirement);
    added.push(requirement);
  }
  return { categories: available.filter((category) => wanted.has(category)), added };
}

/** Categorías cuyas skills Stack ya posee por archivo: es lo que Actualizar puede tocar sin preguntar. */
export function ownedSkillCategories(adapter: SharedProjectionAdapter, ctx: InstallContext): Set<string> {
  const { skillsDir, skillLinksDir } = adapter.paths(ctx.configDir);
  const roots = skillLinksDir ? [skillsDir, skillLinksDir] : [skillsDir];
  const owned = [...ctx.ownedFiles ?? []];
  const categories = new Set<string>();
  for (const skill of listSkills(ctx.stackDir)) {
    if (roots.some((root) => owned.some((file) => isContainedIn(file, path.join(root, skill.name))))) categories.add(skill.category);
  }
  return categories;
}

/** Directorios de skills fuera de la selección: instalar no los toca ni los retira. */
export function unselectedSkillRoots(adapter: SharedProjectionAdapter, ctx: InstallContext): string[] {
  if (!ctx.skillCategories) return [];
  const { skillsDir, skillLinksDir } = adapter.paths(ctx.configDir);
  return listSkills(ctx.stackDir)
    .filter((skill) => !ctx.skillCategories!.has(skill.category))
    .flatMap((skill) => [path.join(skillsDir, skill.name), ...(skillLinksDir ? [path.join(skillLinksDir, skill.name)] : [])]);
}

export function planSkills(adapter: SharedProjectionAdapter, ctx: InstallContext): FileAction[] {
  const { skillsDir, skillLinksDir } = adapter.paths(ctx.configDir);
  const categories = new Set(listSkillCategories(ctx.stackDir));
  for (const category of ctx.skillCategories ?? []) if (!categories.has(category)) throw new Error(`Categoría de skills desconocida: ${category}`);
  const selected = ctx.skillCategories;
  return listSkills(ctx.stackDir).filter((skill) => !selected || selected.has(skill.category)).flatMap((skill) => {
    const target = path.resolve(skillsDir, skill.name);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    const owned = [...ctx.ownedFiles ?? []].some((file) => file.startsWith(`${target}${path.sep}`));
    if (existing && !owned) {
      ctx.warnings.push(`Se conserva skill ajena: ${target}`);
      return [];
    }
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Skill gestionada en conflicto: ${target}`);
    const files: FileAction[] = listFilesRecursive(skill.dir).flatMap((file) =>
      planOwnedProjection({ kind: "copy", source: file, target: path.join(target, path.relative(skill.dir, file)) }, ctx),
    );
    if (!skillLinksDir) return files;
    const link = path.resolve(skillLinksDir, skill.name);
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat && !ctx.ownedFiles?.has(link)) {
      ctx.warnings.push(`Se conserva enlace/directorio ajeno: ${link}`);
      return files;
    }
    if (stat && (!stat.isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== target)) {
      throw new Error(`Enlace de skill gestionado en conflicto: ${link}`);
    }
    return [...files, { kind: "copy", source: target, target: link, symlink: true }];
  });
}
