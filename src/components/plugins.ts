import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";

/**
 * Plugins TS por runtime (stack/plugins/<runtime>/). Solo los .ts: el
 * package.json vendorizado es metadata del sub-proyecto original, el runtime
 * no lo necesita.
 */
export function planPlugins(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { pluginsDir } = adapter.paths(ctx.configDir);
  if (pluginsDir === null) return [];
  const source = path.join(ctx.stackDir, "plugins", adapter.id);
  if (!fs.existsSync(source)) return [];
  return fs
    .readdirSync(source)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ kind: "copy", source: path.join(source, f), target: path.join(pluginsDir, f) }));
}
