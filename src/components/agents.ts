import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalAgents } from "../lib/canonical.js";

export function planAgents(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { agentsDir } = adapter.paths(ctx.configDir);
  return loadCanonicalAgents(path.join(ctx.stackDir, "agents")).map((agent) => {
    const { file, content } = adapter.renderAgent(agent, ctx.models);
    return { kind: "write", target: path.join(agentsDir, file), content };
  });
}
