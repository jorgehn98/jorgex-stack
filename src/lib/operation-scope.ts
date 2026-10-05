import path from "node:path";
import type { Adapter, InstallContext } from "../adapters/types.js";
import { isContainedIn } from "./fsx.js";

export interface OperationScope {
  section: "all" | "skills" | "config" | "agents";
  agent?: string;
}
export function includesOwnedFile(adapter: Adapter, ctx: InstallContext, scope: OperationScope, file: string): boolean {
  const paths = adapter.paths(ctx.configDir);
  const skill = isContainedIn(file, paths.skillsDir) || !!paths.skillLinksDir && isContainedIn(file, paths.skillLinksDir);
  const agent = isContainedIn(file, paths.agentsDir);
  if (scope.section === "skills") return skill;
  if (scope.section === "agents") return agent && (!scope.agent || path.basename(file) === `${scope.agent}.${adapter.id === "codex" ? "toml" : "md"}`);
  if (scope.section === "config") return !skill && !agent;
  return true;
}
