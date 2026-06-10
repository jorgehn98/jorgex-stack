import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "./types.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import type { RuntimeModelMap } from "../lib/model-map.js";
import { detectClaudeCode } from "../lib/detect.js";
import { readTextIfExists } from "../lib/fsx.js";
import { upsertJson } from "../lib/filemerge.js";

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
    };
  },

  renderAgent(agent: CanonicalAgent, models: RuntimeModelMap) {
    // En Claude Code los subagentes no pueden lanzar subagentes: el
    // orchestrator (primary) se instala como slash command para que el agente
    // PRINCIPAL adopte el flujo y delegue vía Task a los subagentes.
    if (agent.mode === "primary") {
      const content = `---\ndescription: ${yamlString(agent.description)}\n---\n${agent.body.trimEnd()}\n\n## Task\n\n$ARGUMENTS\n`;
      return { file: `${agent.name}.md`, content, kind: "command" as const };
    }

    const lines = [`name: ${agent.name}`, `description: ${yamlString(agent.description)}`];
    const tools = toolsFor(agent);
    if (tools !== null) lines.push(`tools: ${tools}`);
    lines.push(`model: ${models[agent.tier].model}`);

    return {
      file: `${agent.name}.md`,
      content: `---\n${lines.join("\n")}\n---\n${agent.body}`,
      kind: "agent" as const,
    };
  },

  renderCommand(file, content) {
    // Dialecto de input: {{input}} (OpenCode) → $ARGUMENTS (Claude Code).
    return { file, content: content.replace(/\{\{input\}\}/g, "$ARGUMENTS") };
  },

  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { scriptsDir } = this.paths(ctx.configDir);
    // Forward slashes: válidas para node en Windows y legibles en JSON.
    const scriptsDirForCommand = scriptsDir.replace(/\\/g, "/");

    const settingsFile = path.join(ctx.configDir, "settings.json");
    const content = upsertJson(readTextIfExists(settingsFile), (root) => {
      const hooks = (root["hooks"] ??= {}) as Record<string, unknown[]>;
      for (const [event, entries] of Object.entries(canonical.hooks)) {
        const list = (hooks[event] ??= []);
        for (const entry of entries) {
          // El formato canónico ES el de Claude Code: solo se resuelve
          // {{SCRIPTS_DIR}} y se omite la extensión x-command-includes
          // (el propio script filtra por comando y sale con exit 0).
          const rendered = {
            matcher: entry.matcher,
            hooks: entry.hooks.map((h) => ({
              type: h.type,
              command: h.command.replace(/\{\{SCRIPTS_DIR\}\}/g, scriptsDirForCommand),
              ...(h.timeout !== undefined ? { timeout: h.timeout } : {}),
            })),
          };

          // Upsert sin duplicar: nuestra entrada se identifica por matcher +
          // nombre del script; los hooks propios del usuario no se tocan.
          const scriptNames = entry.hooks
            .map((h) => /\{\{SCRIPTS_DIR\}\}[/\\]([\w./-]+)/.exec(h.command)?.[1])
            .filter((s): s is string => s !== undefined)
            .map((s) => path.basename(s));
          const index = list.findIndex((existing) => {
            const e = existing as { matcher?: string; hooks?: { command?: string }[] };
            return (
              e?.matcher === entry.matcher &&
              Array.isArray(e?.hooks) &&
              e.hooks.some((hh) => scriptNames.some((s) => String(hh?.command ?? "").includes(s)))
            );
          });
          if (index >= 0) list[index] = rendered;
          else list.push(rendered);
        }
      }
    });
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
