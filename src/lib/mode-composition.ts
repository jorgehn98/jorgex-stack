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

export function composeProgrammaticSystemPrompt(stackDir: string, content: string, mode?: InstallMode): string {
  if (mode !== "programmatic") return normalize(content);
  return appendAddendum(normalize(content), loadProgrammaticAddendum(stackDir, "AGENTS.addendum.md"));
}

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
