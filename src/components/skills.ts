import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { listFilesRecursive } from "../lib/fsx.js";
import { composeProgrammaticSkillBody } from "../lib/mode-composition.js";

/** Las skills son copia fiel, salvo los overlays puntuales de programmatic mode. */
export function planSkills(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { skillsDir } = adapter.paths(ctx.configDir);
  const source = path.join(ctx.stackDir, "skills");
  return listFilesRecursive(source).map((file) => {
    const relative = path.relative(source, file);
    if (
      ctx.mode === "programmatic"
      && [path.join("agent-delegation", "SKILL.md"), path.join("orchestrator", "SKILL.md")].includes(relative)
    ) {
      return {
        kind: "write",
        target: path.join(skillsDir, relative),
        content: composeProgrammaticSkillBody(
          ctx.stackDir,
          relative,
          fs.readFileSync(file, "utf8"),
          ctx.mode,
          ctx.subagentConcurrency,
        ),
      };
    }

    return { kind: "copy", source: file, target: path.join(skillsDir, relative) };
  });
}
