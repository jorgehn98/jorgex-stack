import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalAgents } from "../lib/canonical.js";
import { composeProgrammaticAgentBody } from "../lib/mode-composition.js";

export function planAgents(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { agentsDir, commandsDir, outputStylesDir, skillsDir, profilesDir, scriptsDir } = adapter.paths(ctx.configDir);
  const dirFor = {
    agent: agentsDir,
    command: commandsDir,
    "output-style": outputStylesDir,
    skill: skillsDir,
    profile: profilesDir,
  } as const;

  // Forward slashes: la ruta va dentro de un string YAML double-quoted (hook
  // command), donde un backslash de Windows se interpretaría como escape.
  const scriptsBase = scriptsDir.replace(/\\/g, "/");

  return loadCanonicalAgents(path.join(ctx.stackDir, "agents")).flatMap((agent) => {
    const composedAgent = {
      ...agent,
      body: composeProgrammaticAgentBody(ctx.stackDir, agent, ctx.mode, ctx.subagentConcurrency),
    };

    return adapter.renderAgent(composedAgent, ctx.models).flatMap((rendered): FileAction[] => {
      const dir = dirFor[rendered.kind];
      if (dir === null) {
        ctx.warnings.push(`${adapter.name}: sin destino para '${rendered.kind}' (${rendered.file}) — omitido.`);
        return [];
      }
      const content = rendered.content.replace(/\{\{SCRIPTS_DIR\}\}/g, scriptsBase);
      return [{ kind: "write", target: path.join(dir, rendered.file), content }];
    });
  });
}
