import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalAgents } from "../lib/canonical.js";

export function planAgents(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { agentsDir, commandsDir } = adapter.paths(ctx.configDir);
  return loadCanonicalAgents(path.join(ctx.stackDir, "agents")).map((agent) => {
    const rendered = adapter.renderAgent(agent, ctx.models);
    const dir = rendered.kind === "command" ? commandsDir : agentsDir;
    return { kind: "write", target: path.join(dir, rendered.file), content: rendered.content };
  });
}
