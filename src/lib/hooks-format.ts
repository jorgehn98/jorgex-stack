import { upsertJson } from "./filemerge.js";

/** Retira únicamente comandos exactos de scripts registrados como propios; conserva hooks del proveedor y del usuario. */
export function removeNativeHooks(existing: string | null, commands: ReadonlySet<string>): string | null {
  if (existing === null || existing.trim() === "") return existing;
  return upsertJson(existing, (root) => {
    const hooks = root.hooks;
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return;
    const events = hooks as Record<string, unknown>;
    for (const [event, entries] of Object.entries(events)) {
      if (!Array.isArray(entries)) continue;
      events[event] = entries.flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || !Array.isArray(entry.hooks)) return [entry];
        const kept = entry.hooks.filter((hook: unknown) => !(hook !== null && typeof hook === "object" && "command" in hook && typeof hook.command === "string" && commands.has(hook.command)));
        return kept.length === entry.hooks.length ? [entry] : kept.length ? [{ ...entry, hooks: kept }] : [];
      });
      if ((events[event] as unknown[]).length === 0) delete events[event];
    }
    if (Object.keys(events).length === 0) delete root.hooks;
  });
}
