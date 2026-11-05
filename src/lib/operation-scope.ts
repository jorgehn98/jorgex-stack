import type { Adapter, InstallContext } from "../adapters/types.js";
import { isContainedIn } from "./fsx.js";

export interface OperationScope {
  section: "all" | "skills" | "config";
}
export function includesOwnedFile(adapter: Adapter, ctx: InstallContext, scope: OperationScope, file: string): boolean {
  const paths = adapter.paths(ctx.configDir);
  const skill = isContainedIn(file, paths.skillsDir) || !!paths.skillLinksDir && isContainedIn(file, paths.skillLinksDir);
  if (scope.section === "skills") return skill;
  if (scope.section === "config") return !skill;
  return true;
}
