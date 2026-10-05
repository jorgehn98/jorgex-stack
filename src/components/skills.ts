import fs from "node:fs";
import path from "node:path";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../adapters/types.js";
import { listFilesRecursive } from "../lib/fsx.js";
import { planOwnedProjection } from "../lib/owned-projection.js";

export function planSkills(adapter: SharedProjectionAdapter, ctx: InstallContext): FileAction[] {
  const { skillsDir, skillLinksDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "skills");
  return fs.readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const target = path.resolve(skillsDir, entry.name);
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    const owned = [...ctx.ownedFiles ?? []].some((file) => file.startsWith(`${target}${path.sep}`));
    if (existing && !owned) {
      ctx.warnings.push(`Se conserva skill ajena: ${target}`);
      return [];
    }
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Skill gestionada en conflicto: ${target}`);
    const files: FileAction[] = listFilesRecursive(path.join(source, entry.name)).flatMap((file) =>
      planOwnedProjection({ kind: "copy", source: file, target: path.join(target, path.relative(path.join(source, entry.name), file)) }, ctx),
    );
    if (!skillLinksDir) return files;
    const link = path.resolve(skillLinksDir, entry.name);
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
