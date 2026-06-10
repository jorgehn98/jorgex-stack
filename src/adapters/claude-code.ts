import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "./types.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import type { RuntimeModelMap } from "../lib/model-map.js";
import { detectClaudeCode } from "../lib/detect.js";
import { readTextIfExists } from "../lib/fsx.js";
import { upsertJson } from "../lib/filemerge.js";
import { upsertNativeHooks } from "../lib/hooks-format.js";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Herramientas de memoria Engram que el protocolo exige incluso en agentes restringidos. */
const MEMORY_TOOLS = ["mcp__engram__mem_save", "mcp__engram__mem_search", "mcp__engram__mem_context"];

/** El agente engram es lector puro de memoria: tools de lectura, sin mem_save. */
const ENGRAM_AGENT_TOOLS = [
  "Read",
  "mcp__engram__mem_context",
  "mcp__engram__mem_search",
  "mcp__engram__mem_get_observation",
  "mcp__engram__mem_timeline",
  "mcp__engram__mem_current_project",
];

/**
 * readonly → allowlist explícita; sin restricción → se omite `tools` y el
 * subagente hereda todo (Edit, Write, Bash, MCPs). La granularidad fina de
 * bash (solo git diff/log) no existe en el frontmatter de Claude Code: se da
 * Bash y el prompt del agente limita su uso (documentado en stack/agents/README.md).
 */
function toolsFor(agent: CanonicalAgent): string | null {
  if (agent.name === "engram") return ENGRAM_AGENT_TOOLS.join(", ");
  if (!agent.readonly) return null;
  const tools = ["Read", "Grep", "Glob"];
  if (agent.bash !== "none") tools.push("Bash");
  tools.push(...MEMORY_TOOLS);
  return tools.join(", ");
}

export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  name: "Claude Code",
  detect: detectClaudeCode,

  paths(configDir) {
    return {
      systemPromptFile: path.join(configDir, "CLAUDE.md"),
      agentsDir: path.join(configDir, "agents"),
      skillsDir: path.join(configDir, "skills"),
      commandsDir: path.join(configDir, "commands"),
      pluginsDir: null,
      scriptsDir: path.join(configDir, "scripts"),
      outputStylesDir: path.join(configDir, "output-styles"),
      profilesDir: null,
    };
  },

  renderAgent(agent: CanonicalAgent, models: RuntimeModelMap) {
    // El orchestrator (primary) es un MODO del agente principal, nunca un
    // subagente. Dos vías desde la misma fuente canónica:
    // - Output style: modo persistente del main agent (se elige en /config),
    //   lo más cercano al primary de OpenCode.
    // - Skill: activación puntual — /orchestrator explícito o carga implícita
    //   cuando el modelo detecta trabajo de orquestación. Formato portable
    //   (misma skill sirve en Codex; los commands de Codex están deprecados).
    if (agent.mode === "primary") {
      const title = agent.name.charAt(0).toUpperCase() + agent.name.slice(1);
      const style = `---\nname: ${title}\ndescription: ${yamlString(agent.description)}\nkeep-coding-instructions: true\n---\n${agent.body}`;
      const skillDescription = `${agent.description} Invoke to switch into ${agent.name} mode and apply its flow to the current task.`;
      const skill = `---\nname: ${agent.name}\ndescription: ${yamlString(skillDescription)}\n---\n${agent.body}`;
      return [
        { file: `${agent.name}.md`, content: style, kind: "output-style" as const },
        { file: `${agent.name}/SKILL.md`, content: skill, kind: "skill" as const },
      ];
    }

    const lines = [`name: ${agent.name}`, `description: ${yamlString(agent.description)}`];
    const tools = toolsFor(agent);
    if (tools !== null) lines.push(`tools: ${tools}`);
    lines.push(`model: ${models[agent.tier].model}`);

    return [
      {
        file: `${agent.name}.md`,
        content: `---\n${lines.join("\n")}\n---\n${agent.body}`,
        kind: "agent" as const,
      },
    ];
  },

  renderCommand(file, content) {
    // Dialecto de input: {{input}} (OpenCode) → $ARGUMENTS (Claude Code).
    return { file, content: content.replace(/\{\{input\}\}/g, "$ARGUMENTS") };
  },

  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { scriptsDir } = this.paths(ctx.configDir);

    // El formato canónico ES el de Claude Code: upsert directo en settings.json.
    const settingsFile = path.join(ctx.configDir, "settings.json");
    const content = upsertNativeHooks(readTextIfExists(settingsFile), canonical, scriptsDir);
    actions.push({ kind: "write", target: settingsFile, content });

    const scriptsSource = path.join(ctx.stackDir, "scripts");
    if (fs.existsSync(scriptsSource)) {
      for (const f of fs.readdirSync(scriptsSource)) {
        actions.push({ kind: "copy", source: path.join(scriptsSource, f), target: path.join(scriptsDir, f) });
      }
    }
    return actions;
  },

  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[] {
    // MCP de scope user: ~/.claude.json (hermano del configDir, así --target-dir
    // en pruebas escribe <target>.json y nunca toca el real). Es un archivo con
    // estado del CLI: upsert quirúrgico SOLO de mcpServers gestionados + backup.
    const file = path.join(path.dirname(ctx.configDir), `${path.basename(ctx.configDir)}.json`);

    const content = upsertJson(readTextIfExists(file), (root) => {
      const servers = (root["mcpServers"] ??= {}) as Record<string, Record<string, unknown>>;
      for (const [name, server] of Object.entries(canonical.servers)) {
        if (server.transport === "stdio") {
          if (server.command === "{{ENGRAM_BIN}}" && ctx.engramBin === null) {
            ctx.warnings.push(
              "Engram no detectado: el MCP 'engram' no se registra. Instálalo (github.com/Gentleman-Programming/engram) y re-ejecuta sync.",
            );
            continue;
          }
          const command = server.command === "{{ENGRAM_BIN}}" ? ctx.engramBin! : server.command!;
          servers[name] = { command, args: server.args ?? [] };
        } else {
          const previous = servers[name] as { headers?: Record<string, string> } | undefined;
          const headers: Record<string, string> = {};
          for (const [key, raw] of Object.entries(server.headers ?? {})) {
            const envRef = /^\$\{(\w+)\}$/.exec(raw);
            const fromSecrets = envRef ? (ctx.secrets[envRef[1]!] ?? "") : raw;
            // D5: si el usuario ya conectó su cuenta (header con valor), se preserva.
            headers[key] = fromSecrets !== "" ? fromSecrets : (previous?.headers?.[key] ?? "");
          }
          servers[name] = {
            type: "http",
            url: server.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        }
      }
    });

    return [{ kind: "write", target: file, content }];
  },
};
