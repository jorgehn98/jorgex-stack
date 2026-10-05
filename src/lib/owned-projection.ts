import fs from "node:fs";
import path from "node:path";
import type { FileAction, InstallContext } from "../adapters/types.js";

/** Existing content is not ownership, even when byte-identical. */
export function planOwnedProjection(action: FileAction, ctx: InstallContext): FileAction[] {
  const target = path.resolve(action.target);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return [action];
  if (stat.isFile()) fs.readFileSync(target);
  if (!ctx.ownedFiles?.has(target)) {
    ctx.warnings.push(`Se conserva contenido ajeno: ${target}`);
    return [];
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Proyección gestionada no es un archivo regular: ${target}`);
  }
  // Reading is mandatory even for no-op plans: an unreadable file never authorizes reset.
  fs.readFileSync(target);
  return [action];
}
