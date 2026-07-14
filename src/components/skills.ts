import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { listFilesRecursive } from "../lib/fsx.js";

/** Las skills compartidas son siempre copias fieles e independientes del modo. */
export function planSkills(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { skillsDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "skills");
  return listFilesRecursive(source).map((file) => {
    const relative = path.relative(source, file);
    return { kind: "copy", source: file, target: path.join(skillsDir, relative) };
  });
}
