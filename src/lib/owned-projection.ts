import fs from "node:fs";
import path from "node:path";
import type { FileAction, InstallContext } from "../adapters/types.js";

/** Existing content is not ownership, even when byte-identical: adoption needs an explicit yes at apply time. */
export function planOwnedProjection(action: FileAction, ctx: InstallContext): FileAction[] {
  const target = path.resolve(action.target);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return [action];
  // Reading is mandatory even for no-op plans: an unreadable file never authorizes reset.
  const current = stat.isFile() ? fs.readFileSync(target) : null;
  if (!ctx.ownedFiles?.has(target)) {
    // A link or a directory is never offered: adopting it would write through it or replace it.
    if (current === null) { ctx.warnings.push(`Se conserva contenido ajeno (no es un archivo regular): ${target}`); return []; }
    const identical = current.equals(action.kind === "write" ? Buffer.from(action.content, "utf8") : fs.readFileSync(action.source));
    const warning = identical
      ? `Se conserva contenido ajeno, idéntico al canon: ${target}. Stack no lo gestiona; para adoptarlo, aplica la unidad desde el menú y confirma.`
      : `Se conserva contenido ajeno, distinto del canon: ${target}. Para adoptarlo, aplica la unidad desde el menú (Instalar / configurar) y confirma: se guarda un backup y se sustituye por el canon.`;
    ctx.warnings.push(warning);
    ctx.adoptable?.push({ action, identical, warning });
    return [];
  }
  if (current === null) throw new Error(`Proyección gestionada no es un archivo regular: ${target}`);
  return [action];
}
