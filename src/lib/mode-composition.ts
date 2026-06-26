/**
 * Compone addenda de programmatic mode (concatenadas al final de los agentes
 * canónicos y del system prompt) cuando el install corre en modo programmatic.
 * El marcador <!-- jorgex:programmatic-mode --> en los addenda garantiza
 * idempotencia: re-aplicar no duplica el contenido.
 */

import fs from "node:fs";
import path from "node:path";
import type { CanonicalAgent } from "./canonical.js";
import type { InstallMode, SubagentConcurrency } from "../adapters/types.js";

const PROGRAMMATIC_ROOT = ["modes", "programmatic"] as const;
const PROGRAMMATIC_MARKER = "<!-- jorgex:programmatic-mode -->";

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
 * Aplica el addendum de agent (orchestrator para primary, subagent para el
 * resto) solo en modo programmatic. En primary sustituye el placeholder
 * {{CONCURRENCY_RULE}} por la regla de concurrencia resuelta.
 */
export function composeProgrammaticAgentBody(
  stackDir: string,
  agent: CanonicalAgent,
  mode: InstallMode | undefined,
  concurrency: SubagentConcurrency | undefined,
): string {
  if (mode !== "programmatic") return normalize(agent.body);

  const fileName = agent.mode === "primary" ? "orchestrator.addendum.md" : "subagent.addendum.md";
  let addendum = loadProgrammaticAddendum(stackDir, fileName);
  if (agent.mode === "primary") {
    addendum = addendum.replace("{{CONCURRENCY_RULE}}", concurrencyRule(concurrency ?? "serial"));
  }
  return appendAddendum(normalize(agent.body), addendum);
}
