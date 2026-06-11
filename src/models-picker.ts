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

export async function runModelsPicker(opts: { yes: boolean }): Promise<number> {
  const file = ensureModelMapFile();
  if (opts.yes || !process.stdout.isTTY) {
    console.log(`Model-map en ${file} (defaults). Edítalo o ejecuta 'models' sin --yes para el picker.`);
    return 0;
  }

  p.intro("jorgex-stack models — modelos por tier y runtime");
  const map = loadModelMap();

  const detections: { id: RuntimeId; name: string; installed: boolean; options: string[] | null }[] = [];
  const opencode = detectOpenCode();
  detections.push({
    id: "opencode",
    name: "OpenCode",
    installed: opencode.installed,
    options: opencode.binPath ? opencodeLiveModels(opencode.binPath) : null,
  });
  detections.push({ id: "claude-code", name: "Claude Code", installed: detectClaudeCode().installed, options: CLAUDE_ALIASES });
  detections.push({ id: "codex", name: "Codex CLI", installed: detectCodex().installed, options: null });

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
        runtimeMap[tier] = { ...current, model: choice };
      } else {
        // Codex: "default" usa el modelo vigente del CLI (se actualiza solo).
        const choice = await p.text({
          message: `${det.name} · tier ${tier} (${TIER_HINT[tier]}) — "default" o un ID de modelo OpenAI`,
          initialValue: current.model,
          validate: (v) => (!v || v.trim() === "" ? 'Vacío no — usa "default" o un ID.' : undefined),
        });
        if (p.isCancel(choice)) return cancelled();
        runtimeMap[tier] = { ...current, model: choice.trim() };
      }
    }
    map[det.id] = runtimeMap;
  }

  writeText(file, JSON.stringify(map satisfies ModelMap, null, 2) + "\n");
  p.log.success(`Guardado en ${file}`);
  p.outro("Ejecuta 'sync' para aplicar los modelos a los agentes instalados.");
  return 0;
}

function cancelled(): number {
  p.cancel("Cancelado — no se ha guardado nada.");
  return 1;
}
