import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import { stripLeadingHtmlComments } from "../lib/filemerge.js";
import { listFilesRecursive } from "../lib/fsx.js";

/**
 * Plugins TS por runtime (stack/plugins/<runtime>/). Se copian recursivamente
 * los .ts para incluir submódulos como goal/*; el package.json vendorizado es
 * metadata del sub-proyecto original, el runtime no lo necesita. Placeholders
 * resueltos al instalar:
 * - "{{ENGRAM_BIN}}" → binario detectado (D7), por si engram no está en PATH.
 * - "{{ENGRAM_PROTOCOL}}" → contenido de system-prompt/engram-protocol.md
 *   (única fuente del protocolo, alineada con el resto de runtimes).
 */
export function planPlugins(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const { pluginsDir } = adapter.paths(ctx.configDir);
  if (pluginsDir === null) return [];
  const source = path.join(ctx.stackDir, "plugins", adapter.id);
  if (!fs.existsSync(source)) return [];
  return listFilesRecursive(source)
    .filter((f) => f.endsWith(".ts"))
    .map((sourceFile): FileAction => {
      const target = path.join(pluginsDir, path.relative(source, sourceFile));
      const raw = fs.readFileSync(sourceFile, "utf8");
      let content = raw;
      if (content.includes('"{{ENGRAM_BIN}}"')) {
        content = content.replace(/"\{\{ENGRAM_BIN\}\}"/g, JSON.stringify(ctx.engramBin ?? "engram"));
      }
      if (content.includes('"{{ENGRAM_PROTOCOL}}"')) {
        const protocol = stripLeadingHtmlComments(
          fs.readFileSync(path.join(ctx.stackDir, "system-prompt", "engram-protocol.md"), "utf8").replace(/\r\n/g, "\n"),
        );
        // JSON.stringify produce un string JS válido con todo escapado.
        content = content.replace(/"\{\{ENGRAM_PROTOCOL\}\}"/g, JSON.stringify(protocol));
      }
      content = content.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)\.js(["'])/g, "$1$2.ts$3");
      if (content === raw) return { kind: "copy", source: sourceFile, target };
      return { kind: "write", target, content };
    });
}
