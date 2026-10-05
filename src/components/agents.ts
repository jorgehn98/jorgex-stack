import fs from "node:fs";
import { planOwnedProjection } from "../lib/owned-projection.js";
import path from "node:path";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { loadCanonicalAgents } from "../lib/canonical.js";

export function planAgents(adapter: Pick<Adapter, "paths" | "renderAgent">, ctx: InstallContext, name?: string): FileAction[] {
  const { agentsDir } = adapter.paths(ctx.configDir);
  return loadCanonicalAgents(path.join(ctx.stackDir, "agents")).filter((agent) => !name || agent.name === name).flatMap((agent) =>
    adapter.renderAgent(agent, ctx.models).flatMap((rendered) => {
      const target = path.join(agentsDir, rendered.file);
      const actions = planOwnedProjection({ kind: "write", target, content: rendered.content }, ctx);
      if (actions.length === 0 || !fs.existsSync(target)) return actions;
      const current = fs.readFileSync(target, "utf8");
      const fields = rendered.file.endsWith(".toml")
        ? /^[ \t]*(?:model|model_reasoning_effort)\s*=.*$/gm
        : /^(?:model|thinking|effort):.*$/gm;
      const header = rendered.file.endsWith(".toml") ? current.split(/^developer_instructions\s*=/m)[0]! : current.split(/^---\s*$/m)[1] ?? "";
      const choices = header.match(fields) ?? [];
      if (choices.length === 0) return actions;
      const content = rendered.file.endsWith(".toml")
        ? rendered.content.replace(/^[\s\S]*?(?=^developer_instructions\s*=)/m,
          (header) => `${choices.join("\n")}\n${header.replace(fields, "")}`)
        : rendered.content.replace(/^---\n([\s\S]*?)\n---\n/,
          (_match, header: string) => `---\n${choices.join("\n")}\n${header.replace(fields, "")}\n---\n`);
      return [{ kind: "write", target, content }];
    }),
  );
}
