import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";

/**
 * Plugins TS por runtime (stack/plugins/<runtime>/). Solo los .ts: el
 * package.json vendorizado es metadata del sub-proyecto original, el runtime
 * no lo necesita. El placeholder "{{ENGRAM_BIN}}" se resuelve con el binario
 * detectado (D7) para que el plugin funcione aunque engram no esté en PATH.
 */
export function planPlugins(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { pluginsDir } = adapter.paths(ctx.configDir);
  if (pluginsDir === null) return [];
  const source = path.join(ctx.stackDir, "plugins", adapter.id);
  if (!fs.existsSync(source)) return [];
  return fs
    .readdirSync(source)
    .filter((f) => f.endsWith(".ts"))
    .map((f): FileAction => {
      const sourceFile = path.join(source, f);
      const target = path.join(pluginsDir, f);
      const raw = fs.readFileSync(sourceFile, "utf8");
      if (!raw.includes('"{{ENGRAM_BIN}}"')) return { kind: "copy", source: sourceFile, target };
      const content = raw.replace(/"\{\{ENGRAM_BIN\}\}"/g, JSON.stringify(ctx.engramBin ?? "engram"));
      return { kind: "write", target, content };
    });
}
