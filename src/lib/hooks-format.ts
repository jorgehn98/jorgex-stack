import path from "node:path";
import type { CanonicalHooks } from "./canonical.js";
import { upsertJson } from "./filemerge.js";

/**
 * Claude Code y Codex comparten el formato nativo de hooks (el canónico).
 * Renderiza el upsert sobre el JSON destino: resuelve {{SCRIPTS_DIR}}, omite
 * la extensión x-command-includes (el script filtra solo) y traduce el
 * matcher por runtime (Codex llama "shell" al tool de bash). Las entradas
 * nuestras se identifican por matcher + nombre de script: re-aplicar no
 * duplica y los hooks propios del usuario no se tocan.
 */
export function upsertNativeHooks(
  existing: string | null,
  canonical: CanonicalHooks,
  scriptsDir: string,
  mapMatcher: (matcher: string) => string = (m) => m,
): string {
  const scriptsDirForCommand = scriptsDir.replace(/\\/g, "/");

  return upsertJson(existing, (root) => {
    const hooks = (root["hooks"] ??= {}) as Record<string, unknown[]>;
    for (const [event, entries] of Object.entries(canonical.hooks)) {
      const list = (hooks[event] ??= []);
      for (const entry of entries) {
        const matcher = entry.matcher !== undefined ? mapMatcher(entry.matcher) : undefined;
        const rendered = {
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: entry.hooks.map((h) => ({
            type: h.type,
            command: h.command.replace(/\{\{SCRIPTS_DIR\}\}/g, scriptsDirForCommand),
            ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
          })),
        };

        const scriptNames = entry.hooks
          .map((h) => /\{\{SCRIPTS_DIR\}\}[/\\]([\w./-]+)/.exec(h.command)?.[1])
          .filter((s): s is string => s !== undefined)
          .map((s) => path.basename(s));
        const index = list.findIndex((existingEntry) => {
          const e = existingEntry as { matcher?: string; hooks?: { command?: string }[] };
          return (
            e?.matcher === matcher &&
            Array.isArray(e?.hooks) &&
            e.hooks.some((hh) => scriptNames.some((s) => String(hh?.command ?? "").includes(s)))
          );
        });
        if (index >= 0) list[index] = rendered;
        else list.push(rendered);
      }
    }
  });
}
