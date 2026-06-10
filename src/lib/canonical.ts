import path from "node:path";
import fs from "node:fs";
import type { Tier } from "../adapters/types.js";

/** Agente en formato canónico (stack/agents/README.md). */
export interface CanonicalAgent {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  tier: Tier;
  readonly: boolean;
  bash: "none" | "git-read" | "full";
  spawn: boolean;
  body: string;
}

export function parseCanonicalAgent(source: string, file: string): CanonicalAgent {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) throw new Error(`Agente sin frontmatter: ${file}`);

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }

  const required = ["name", "description", "mode", "tier"] as const;
  for (const key of required) {
    if (!fields[key]) throw new Error(`Agente ${file}: falta '${key}' en el frontmatter`);
  }

  return {
    name: fields.name!,
    description: fields.description!,
    mode: fields.mode === "primary" ? "primary" : "subagent",
    tier: fields.tier as Tier,
    readonly: fields.readonly === "true",
    bash: (fields.bash ?? "full") as CanonicalAgent["bash"],
    spawn: fields.spawn !== "false",
    body: source.slice(match[0].length),
  };
}

export function loadCanonicalAgents(agentsDir: string): CanonicalAgent[] {
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((f) => {
      const file = path.join(agentsDir, f);
      // EOL normalizado: el contenido generado debe ser estable aunque git
      // haya hecho checkout con CRLF.
      const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      return parseCanonicalAgent(source, file);
    });
}

/** Hook canónico (stack/hooks/hooks.json, formato Claude Code + x-command-includes). */
export interface CanonicalHooks {
  hooks: Record<
    string,
    {
      matcher?: string;
      "x-command-includes"?: string;
      hooks: { type: string; command: string; timeout?: number }[];
    }[]
  >;
}

/** Servidor MCP canónico (stack/mcp/servers.json). */
export interface CanonicalMcpServer {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface CanonicalMcp {
  servers: Record<string, CanonicalMcpServer & Record<string, unknown>>;
}
