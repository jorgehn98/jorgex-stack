import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { listFilesRecursive } from "../lib/fsx.js";

/** Las skills son estándar SKILL.md en los tres runtimes: copia fiel. */
export function planSkills(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { skillsDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "skills");
  return listFilesRecursive(source).map((file) => ({
    kind: "copy",
    source: file,
    target: path.join(skillsDir, path.relative(source, file)),
  }));
}
