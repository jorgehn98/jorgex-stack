import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalAgents } from "../lib/canonical.js";

export function planAgents(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { agentsDir, commandsDir, outputStylesDir, skillsDir } = adapter.paths(ctx.configDir);
  const dirFor = {
    agent: agentsDir,
    command: commandsDir,
    "output-style": outputStylesDir,
    skill: skillsDir,
  } as const;

  return loadCanonicalAgents(path.join(ctx.stackDir, "agents")).flatMap((agent) =>
    adapter.renderAgent(agent, ctx.models).flatMap((rendered): FileAction[] => {
      const dir = dirFor[rendered.kind];
      if (dir === null) {
        ctx.warnings.push(`${adapter.name}: sin destino para '${rendered.kind}' (${rendered.file}) — omitido.`);
        return [];
      }
      return [{ kind: "write", target: path.join(dir, rendered.file), content: rendered.content }];
    }),
  );
}
