import fs from "node:fs";

/** Retain pending owned roots and surface every teardown failure. */
export function removeTemporaryRoots(
  roots: string[],
  remove: (target: string) => void = (target) =>
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }),
): void {
  const failures: string[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    if (root === undefined) continue;
    try {
      remove(root);
      roots.splice(index, 1);
    } catch (error) {
      failures.push(`${root} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (failures.length > 0 || roots.length > 0) {
    const pending = roots.length === 0 ? "" : `; pendientes: ${roots.join(", ")}`;
    throw new Error(`No se pudieron limpiar roots temporales: ${failures.join("; ")}${pending}`);
  }
}
