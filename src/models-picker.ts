import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import type { RuntimeId, Tier } from "./adapters/types.js";
import { detectClaudeCode, detectCodex, detectOpenCode } from "./lib/detect.js";
import { ensureModelMapFile, loadModelMap, modelMapFile, type ModelMap } from "./lib/model-map.js";
import { writeText } from "./lib/fsx.js";

const TIERS: Tier[] = ["strong", "standard", "cheap"];
// Solo subagentes: el orchestrator (primary) no fija modelo — usa el del usuario.
const TIER_HINT: Record<Tier, string> = {
  strong: "análisis, review, seguridad",
  standard: "implementer, tester",
  cheap: "translator, docs, comments, engram",
};

/** Lista en vivo de modelos conectados en OpenCode (PRD §6.1 / D6). */
function opencodeLiveModels(binPath: string): string[] | null {
  try {
    const out = execSync(`"${binPath}" models`, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    const models = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && l.includes("/"));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku", "inherit"];

/**
 * Lista curada de modelos de Codex (login ChatGPT) — sin typos: se elige, no
 * se escribe. "default" usa el modelo vigente del CLI y nunca caduca; los IDs
 * concretos se refrescan con cada release del stack (junio 2026:
 * developers.openai.com/codex/models). "custom" queda como vía de escape.
 */
const CODEX_MODELS = ["default", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const CODEX_CUSTOM = "__custom__";

export async function runModelsPicker(opts: { yes: boolean; runtimes: RuntimeId[] }): Promise<number> {
  const file = ensureModelMapFile();
  if (opts.yes || !process.stdout.isTTY) {
    console.log(`Model-map en ${file} (defaults). Edítalo o ejecuta 'models' sin --yes para el picker.`);
    return 0;
  }

  p.intro("jorgex-stack models — modelos por tier y runtime");
  const map = loadModelMap();

  const detections: { id: RuntimeId; name: string; installed: boolean; options: string[] | null }[] = [];
  if (opts.runtimes.includes("opencode")) {
    const opencode = detectOpenCode();
    detections.push({
      id: "opencode",
      name: "OpenCode",
      installed: opencode.installed,
      options: opencode.binPath ? opencodeLiveModels(opencode.binPath) : null,
    });
  }
  if (opts.runtimes.includes("claude-code")) {
    detections.push({ id: "claude-code", name: "Claude Code", installed: detectClaudeCode().installed, options: CLAUDE_ALIASES });
  }
  if (opts.runtimes.includes("codex")) {
    detections.push({ id: "codex", name: "Codex CLI", installed: detectCodex().installed, options: null });
  }

  for (const det of detections) {
    if (!det.installed) {
      p.log.info(`${det.name}: no instalado — se mantienen los defaults.`);
      continue;
    }
    if (det.id === "opencode" && det.options === null) {
      p.log.warn("OpenCode: no se pudo listar `opencode models` — se mantiene la selección actual.");
      continue;
    }

    const runtimeMap = { ...map[det.id]! };
    for (const tier of TIERS) {
      const current = runtimeMap[tier];
      if (det.options !== null) {
        const options = det.options.map((m) => ({ value: m, label: m }));
        if (!det.options.includes(current.model)) options.unshift({ value: current.model, label: `${current.model} (actual)` });
        const choice = await p.select({
          message: `${det.name} · tier ${tier} (${TIER_HINT[tier]})`,
          options,
          initialValue: current.model,
          maxItems: 12,
        });
        if (p.isCancel(choice)) return cancelled();
        // Variant (reasoning effort) nativo de OpenCode. `opencode models` no
        // expone qué variants soporta cada modelo, así que la lista es genérica:
        // si el modelo no soporta variants, deja "(sin variant)". Nunca se
        // arrastra el variant del modelo anterior (podría no existir en el nuevo).
        const knownVariants = ["low", "medium", "high", "xhigh"];
        const keptCurrent = choice === current.model && current.variant ? current.variant : null;
        const variant = await p.select({
          message: `${det.name} · tier ${tier} — reasoning effort (variant; solo si el modelo lo soporta)`,
          options: [
            { value: "", label: "(sin variant — el default del modelo)" },
            ...knownVariants.map((v) => ({ value: v, label: v })),
            ...(keptCurrent && !knownVariants.includes(keptCurrent)
              ? [{ value: keptCurrent, label: `${keptCurrent} (actual)` }]
              : []),
          ],
          initialValue: keptCurrent ?? "",
        });
        if (p.isCancel(variant)) return cancelled();
        runtimeMap[tier] = { model: choice, ...(variant ? { variant } : {}) };
      } else {
        // Codex: con plan ChatGPT el modelo lo marca la cuenta — la palanca
        // real es el reasoning effort por tier (mismo enfoque que gentle-ai).
        // "default" usa el modelo vigente del CLI (se actualiza solo).
        const effort = await p.select({
          message: `${det.name} · tier ${tier} (${TIER_HINT[tier]}) — reasoning effort`,
          options: ["low", "medium", "high", "xhigh"].map((v) => ({ value: v, label: v })),
          initialValue: current.variant ?? "medium",
        });
        if (p.isCancel(effort)) return cancelled();
        const modelOptions = [
          ...(CODEX_MODELS.includes(current.model) ? [] : [{ value: current.model, label: `${current.model} (actual)` }]),
          ...CODEX_MODELS.map((m) => ({
            value: m,
            label: m === "default" ? "default — el del CLI, se actualiza solo (recomendado)" : m,
          })),
          { value: CODEX_CUSTOM, label: "otro… (escribir un ID a mano)" },
        ];
        let model = await p.select({
          message: `${det.name} · tier ${tier} — modelo`,
          options: modelOptions,
          initialValue: current.model,
        });
        if (p.isCancel(model)) return cancelled();
        if (model === CODEX_CUSTOM) {
          const typed = await p.text({
            message: `${det.name} · tier ${tier} — ID exacto del modelo (minúsculas; compruébalo con /model dentro de codex)`,
            initialValue: current.model,
            validate: (v) => (!v || v.trim() === "" ? 'Vacío no — usa "default" o un ID.' : undefined),
          });
          if (p.isCancel(typed)) return cancelled();
          model = typed.trim().toLowerCase();
        }
        runtimeMap[tier] = { model, variant: effort };
      }
    }
    map[det.id] = runtimeMap;
  }

  writeText(file, JSON.stringify(map satisfies ModelMap, null, 2) + "\n");
  p.log.success(`Guardado en ${file}`);
  p.log.info(
    'Ajuste fino opcional: añade "overrides" por runtime en ese archivo para pisar el tier de UN agente — p.ej. { "overrides": { "code-reviewer": { "model": "...", "variant": "high" } } }.',
  );
  p.outro("Ejecuta 'sync' para aplicar los modelos a los agentes instalados.");
  return 0;
}

function cancelled(): number {
  p.cancel("Cancelado — no se ha guardado nada.");
  return 1;
}
