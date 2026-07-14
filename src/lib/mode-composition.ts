/**
 * Compone addenda de programmatic mode sobre el system prompt y los agentes
 * propios de cada runtime. Las skills compartidas nunca dependen del modo.
 * El marcador <!-- jorgex:programmatic-mode --> en los addenda garantiza
 * idempotencia: re-aplicar no duplica el contenido.
 */

import fs from "node:fs";
import path from "node:path";
import type { CanonicalAgent } from "./canonical.js";
import type { InstallMode, SubagentConcurrency } from "../adapters/types.js";

const PROGRAMMATIC_ROOT = ["modes", "programmatic"] as const;
const PROGRAMMATIC_MARKER = "<!-- jorgex:programmatic-mode -->";
const LEGACY_RESULT_CONTRACT_SECTION = /\n?##\s+Result contract[\s\S]*$/;
const LEGACY_DELEGATION_LINE = /- For each `→ \[agent\]: \.\.\.` line, launch the corresponding specialist\./;
const LEGACY_PROGRAMMATIC_PHRASES: Array<[RegExp, string]> = [
  [/\bResult contract\b/g, "strict JSON handoff"],
  [/Status \/ Delegations \/ Risks/g, "status, delegations, and risks"],
  [LEGACY_DELEGATION_LINE, "- Process the JSON `delegations[]` array and launch the corresponding specialist."],
];

const normalize = (value: string): string => value.replace(/\r\n/g, "\n");

function loadProgrammaticAddendum(stackDir: string, fileName: string): string {
  return normalize(fs.readFileSync(path.join(stackDir, ...PROGRAMMATIC_ROOT, fileName), "utf8")).trim();
}

function appendAddendum(base: string, addendum: string): string {
  const normalizedBase = normalize(base);
  // Idempotente: si el marcador está presente, el addendum ya se añadió en un run previo.
  if (normalizedBase.includes(PROGRAMMATIC_MARKER)) return normalizedBase;
  return `${normalizedBase.trimEnd()}\n\n${addendum}\n`;
}

function stripLegacyResultContract(body: string): string {
  return LEGACY_PROGRAMMATIC_PHRASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    normalize(body).replace(LEGACY_RESULT_CONTRACT_SECTION, ""),
  ).trimEnd();
}

function concurrencyRule(concurrency: SubagentConcurrency): string {
  if (concurrency === "parallel") {
    return [
      "- Parallel delegation is allowed when safe.",
      "- Set max_parallel_subagents explicitly when the runtime supports it.",
    ].join("\n");
  }

  return [
    "- Launch one subagent at a time.",
    "- No parallel delegation.",
  ].join("\n");
}

/** Aplica el addendum de system prompt solo en modo programmatic; en human devuelve el contenido tal cual. */
export function composeProgrammaticSystemPrompt(stackDir: string, content: string, mode?: InstallMode): string {
  if (mode !== "programmatic") return normalize(content);
  return appendAddendum(normalize(content), loadProgrammaticAddendum(stackDir, "AGENTS.addendum.md"));
}

/**
 * Aplica el addendum programmatic al artefacto propio del runtime: contrato del
 * orchestrator sobre el wrapper primary y handoff sobre cada subagente.
 */
export function composeProgrammaticAgentBody(
  stackDir: string,
  agent: CanonicalAgent,
  mode: InstallMode | undefined,
  concurrency?: SubagentConcurrency,
): string {
  if (mode !== "programmatic") return normalize(agent.body);

  if (agent.mode === "primary") {
    const addendum = loadProgrammaticAddendum(stackDir, "orchestrator.addendum.md")
      .replace("{{CONCURRENCY_RULE}}", concurrencyRule(concurrency ?? "serial"));
    return appendAddendum(stripLegacyResultContract(agent.body), addendum);
  }

  const addendum = loadProgrammaticAddendum(stackDir, "subagent.addendum.md");
  return appendAddendum(stripLegacyResultContract(agent.body), addendum);
}
