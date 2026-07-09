import path from "node:path";
import * as p from "@clack/prompts";
import type { RuntimeId, Tier } from "./adapters/types.js";
import { detectClaudeCode, detectCodex, detectOpenCode, runDetectedBin } from "./lib/detect.js";
import { loadCanonicalAgents } from "./lib/canonical.js";
import {
  ensureModelMapFile,
  loadModelMap,
  modelMapFile,
  resolveAgentModel,
  type ModelMap,
  type RuntimeModelMap,
  type TierModel,
} from "./lib/model-map.js";
import { stackRoot } from "./lib/paths.js";
import { writeText } from "./lib/fsx.js";

const TIERS: Tier[] = ["strong", "standard", "cheap"];

/** Niveles de reasoning effort (variant en OpenCode, model_reasoning_effort en Codex). */
const EFFORTS = ["low", "medium", "high", "xhigh"];

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku", "inherit"];

/**
 * Lista curada de modelos de Codex (login ChatGPT) — sin typos: se elige, no
 * se escribe. "default" usa el modelo vigente del CLI y nunca caduca; los IDs
 * concretos se refrescan con cada release del stack (julio 2026:
 * developers.openai.com/codex/models). "custom" queda como vía de escape.
 */
export const CODEX_MODELS = [
  "default",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const CODEX_CUSTOM = "__custom__";

const CANCEL = Symbol("cancel");

/** Lista en vivo de modelos conectados en OpenCode (PRD §6.1 / D6). */
function opencodeLiveModels(binPath: string): string[] | null {
  const out = runDetectedBin(binPath, ["models"], 20_000);
  if (out === null) return null;
  const models = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && l.includes("/"));
  return models.length > 0 ? models : null;
}

/** Subagentes canónicos agrupados por tier. El primary (orchestrator) nunca lleva modelo. */
function agentsByTier(): Record<Tier, string[]> {
  const grouped: Record<Tier, string[]> = { strong: [], standard: [], cheap: [] };
  for (const agent of loadCanonicalAgents(path.join(stackRoot(), "agents"))) {
    if (agent.mode === "subagent") grouped[agent.tier].push(agent.name);
  }
  return grouped;
}

function isCompleteRuntimeModelMap(models: Partial<RuntimeModelMap>): models is RuntimeModelMap {
  return TIERS.every((tier) => models[tier]?.model);
}

interface Detection {
  id: RuntimeId;
  name: string;
  installed: boolean;
  options: string[] | null;
}

/**
 * Pregunta el modelo (y el reasoning effort donde el runtime lo soporta) para
 * un sujeto ("tier strong (…)" o "code-reviewer (tier strong)"):
 * - OpenCode → select de modelo (lista en vivo) + select de variant.
 * - Claude Code → select de alias; no existe effort por subagente.
 * - Codex → select de effort + select curado de modelos (con vía de escape).
 */
async function askModel(det: Detection, subject: string, current?: TierModel): Promise<TierModel | typeof CANCEL> {
  if (det.id === "codex") {
    if (!current) throw new Error("Codex requiere un model-map base.");
    const effort = await p.select({
      message: `${det.name} · ${subject} — reasoning effort`,
      options: EFFORTS.map((v) => ({ value: v, label: v })),
      initialValue: current.variant ?? "medium",
    });
    if (p.isCancel(effort)) return CANCEL;

    const modelOptions = [
      ...(CODEX_MODELS.includes(current.model) ? [] : [{ value: current.model, label: `${current.model} (actual)` }]),
      ...CODEX_MODELS.map((m) => ({
        value: m,
        label: m === "default" ? "default — el del CLI, se actualiza solo (recomendado)" : m,
      })),
      { value: CODEX_CUSTOM, label: "otro… (escribir un ID a mano)" },
    ];
    let model = await p.select({
      message: `${det.name} · ${subject} — modelo`,
      options: modelOptions,
      initialValue: current.model,
    });
    if (p.isCancel(model)) return CANCEL;
    if (model === CODEX_CUSTOM) {
      const typed = await p.text({
        message: `${det.name} · ${subject} — ID exacto del modelo (minúsculas; compruébalo con /model dentro de codex)`,
        initialValue: current.model,
        validate: (v) => (!v || v.trim() === "" ? 'Vacío no — usa "default" o un ID.' : undefined),
      });
      if (p.isCancel(typed)) return CANCEL;
      model = typed.trim().toLowerCase();
    }
    return { model, variant: effort };
  }

  const optionsList = det.options!;
  const options = optionsList.map((m) => ({ value: m, label: m }));
  if (current && !optionsList.includes(current.model)) {
    options.unshift({ value: current.model, label: `${current.model} (actual)` });
  }
  const choice = await p.select({
    message: `${det.name} · ${subject} — modelo`,
    options,
    initialValue: current?.model,
    maxItems: 12,
  });
  if (p.isCancel(choice)) return CANCEL;

  // Claude Code: alias auto-actualizable y listo — no existe effort por subagente.
  if (det.id === "claude-code") return { model: choice };

  // OpenCode: variant (reasoning effort). `opencode models` no expone qué
  // variants soporta cada modelo, así que la lista es genérica: si el modelo
  // no los soporta, deja "(sin variant)". Nunca se arrastra el variant del
  // modelo anterior (podría no existir en el nuevo).
  const keptCurrent = current && choice === current.model && current.variant ? current.variant : null;
  const variant = await p.select({
    message: `${det.name} · ${subject} — reasoning effort (variant; solo si el modelo lo soporta)`,
    options: [
      { value: "", label: "(sin variant — el default del modelo)" },
      ...EFFORTS.map((v) => ({ value: v, label: v })),
      ...(keptCurrent && !EFFORTS.includes(keptCurrent) ? [{ value: keptCurrent, label: `${keptCurrent} (actual)` }] : []),
    ],
    initialValue: keptCurrent ?? "",
  });
  if (p.isCancel(variant)) return CANCEL;
  return { model: choice, ...(variant ? { variant } : {}) };
}

export async function runModelsPicker(opts: { yes: boolean; runtimes: RuntimeId[] }): Promise<number> {
  const file = ensureModelMapFile();
  const map = loadModelMap();
  if (opts.yes || !process.stdout.isTTY) {
    if (opts.runtimes.includes("opencode") && !map.opencode) {
      console.error("OpenCode requiere selección interactiva desde los proveedores conectados; ejecuta 'models --agents opencode' sin --yes.");
      return 1;
    }
    console.log(`Model-map en ${file}. Edítalo o ejecuta 'models' sin --yes para el picker.`);
    return 0;
  }

  p.intro("jorgex-stack models — modelos por tier o por subagente");
  const grouped = agentsByTier();
  const tierLine = (tier: Tier): string => grouped[tier].join(", ");
  const agentCount = TIERS.reduce((n, tier) => n + grouped[tier].length, 0);

  const detections: Detection[] = [];
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

    const existingRuntimeMap = map[det.id];
    const runtimeMap: Partial<RuntimeModelMap> & Pick<RuntimeModelMap, "overrides"> = {
      ...existingRuntimeMap,
    };

    p.log.message(
      `${det.name} — tiers y sus subagentes:\n` +
        `  strong   → ${tierLine("strong")}\n` +
        `  standard → ${tierLine("standard")}\n` +
        `  cheap    → ${tierLine("cheap")}`,
    );
    const mode = await p.select({
      message: `${det.name} — ¿cómo asignar los modelos?`,
      options: [
        { value: "tier", label: "Por tier — 3 grupos (rápido)" },
        { value: "agent", label: `Por subagente — uno a uno (${agentCount} subagentes, control total)` },
      ],
      initialValue: "tier",
    });
    if (p.isCancel(mode)) return cancelled();

    if (mode === "tier") {
      for (const tier of TIERS) {
        const asked = await askModel(det, `tier ${tier} (${tierLine(tier)})`, existingRuntimeMap?.[tier]);
        if (asked === CANCEL) return cancelled();
        runtimeMap[tier] = asked;
      }
      const overrideCount = Object.keys(runtimeMap.overrides ?? {}).length;
      if (overrideCount > 0) {
        p.log.info(
          `${det.name}: se conservan ${overrideCount} ajustes por subagente previos — elige "Por subagente" para revisarlos.`,
        );
      }
    } else {
      // Por subagente: solo se guarda como override lo que difiera de su tier,
      // así el model-map queda mínimo y el modo "por tier" sigue mandando
      // sobre los agentes no personalizados.
      const overrides = { ...(runtimeMap.overrides ?? {}) };
      for (const tier of TIERS) {
        let base = runtimeMap[tier];
        for (const name of grouped[tier]) {
          const current = existingRuntimeMap
            ? resolveAgentModel(existingRuntimeMap, name, tier)
            : undefined;
          const asked = await askModel(det, `${name} (tier ${tier})`, current);
          if (asked === CANCEL) return cancelled();
          if (!base) {
            base = asked;
            runtimeMap[tier] = base;
          }
          const sameAsTier = asked.model === base.model && (asked.variant ?? "") === (base.variant ?? "");
          if (sameAsTier) {
            delete overrides[name];
          } else {
            // `variant: ""` explícito = limpiar el effort del tier (un override
            // sin la clave heredaría el variant base tras el JSON round-trip).
            overrides[name] = {
              model: asked.model,
              ...(asked.variant ? { variant: asked.variant } : base.variant ? { variant: "" } : {}),
            };
          }
        }
      }
      if (Object.keys(overrides).length > 0) runtimeMap.overrides = overrides;
      else delete runtimeMap.overrides;
    }

    if (!isCompleteRuntimeModelMap(runtimeMap)) {
      throw new Error(`${det.name}: selección de modelos incompleta.`);
    }
    map[det.id] = runtimeMap;
  }

  writeText(file, JSON.stringify(map satisfies ModelMap, null, 2) + "\n");
  p.log.success(`Guardado en ${file}`);
  return 0;
}

function cancelled(): number {
  p.cancel("Cancelado — no se ha guardado nada.");
  return 1;
}
