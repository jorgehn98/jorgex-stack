import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange } from "./types.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectClaudeCode } from "../lib/detect.js";
import { readTextIfExists } from "../lib/fsx.js";
import { removeMarkdownSection, upsertJson } from "../lib/filemerge.js";
import { removeNativeHooks, upsertNativeHooks } from "../lib/hooks-format.js";
import { GIT_GUARD_SCRIPT } from "../lib/git-guard.js";
import { createLocalCapabilityReport, hasManagedMarkdownSection } from "../lib/quality-capabilities.js";
import { stackRoot } from "../lib/paths.js";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Tools de memoria con AMBOS namespaces: MCP registrado por el stack
 * (mcp__engram__*) y plugin oficial de marketplace (mcp__plugin_engram_engram__*).
 * Claude Code ignora en la allowlist las tools que no existan, así la misma
 * allowlist funciona con cualquiera de las dos integraciones.
 */
const memoryTools = (names: string[]): string[] =>
  names.flatMap((n) => [`mcp__engram__${n}`, `mcp__plugin_engram_engram__${n}`]);

/** Herramientas de memoria Engram que el protocolo exige incluso en agentes restringidos. */
const MEMORY_TOOLS = memoryTools(["mem_save", "mem_search", "mem_context"]);

/** El agente engram es lector puro de memoria: tools de lectura, sin mem_save. */
const ENGRAM_AGENT_TOOLS = [
  "Read",
  "Skill",
  ...memoryTools(["mem_context", "mem_search", "mem_get_observation", "mem_timeline", "mem_current_project"]),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasClaudeManualApproval(configDir: string): boolean {
  const content = readTextIfExists(path.join(configDir, "settings.json"));
  if (content === null) return false;

  try {
    const root = JSON.parse(content) as unknown;
    const permissions = isRecord(root) ? root.permissions : undefined;
    const expected = loadCanonicalDefaults(stackRoot())["claude-code"]?.["permissions"];
    return isRecord(permissions) && expected !== undefined && isDeepStrictEqual(permissions, expected);
  } catch {
    return false;
  }
}

/**
 * readonly → allowlist explícita; sin restricción → se omite `tools` y el
 * subagente hereda todo (Edit, Write, Bash, MCPs). La granularidad fina de
 * bash (solo git diff/log) no existe en el frontmatter de Claude Code: se da
 * Bash y el prompt del agente limita su uso (documentado en stack/agents/README.md).
 */
function toolsFor(agent: CanonicalAgent): string | null {
  if (agent.name === "engram") return ENGRAM_AGENT_TOOLS.join(", ");
  if (!agent.readonly) return null;
  // Skill SIEMPRE: todos los subagentes cargan agent-delegation como primera
  // acción obligatoria — sin la tool en la allowlist no podrían.
  const tools = ["Read", "Grep", "Glob", "Skill"];
  if (agent.bash !== "none") tools.push("Bash");
  tools.push(...MEMORY_TOOLS);
  return tools.join(", ");
}

/** Engram integrado vía su plugin oficial de marketplace (claude plugin install engram). */
function hasEngramPlugin(configDir: string): boolean {
  if (fs.existsSync(path.join(configDir, "plugins", "marketplaces", "engram"))) return true;
  const registry = readTextIfExists(path.join(configDir, "plugins", "installed_plugins.json"));
  if (registry === null) return false;
  try {
    // Claves tipo "engram@engram" o "engram" — match por nombre de plugin
    // exacto, no por substring (un plugin ajeno que contenga "engram" no cuenta).
    const parsed = JSON.parse(registry) as Record<string, unknown>;
    const keys = [...Object.keys(parsed), ...Object.keys((parsed["plugins"] as object | undefined) ?? {})];
    return keys.some((k) => k === "engram" || k.startsWith("engram@"));
  } catch {
    return false;
  }
}

function isManagedOptionalStdioServer(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  if (!server.optional || server.transport !== "stdio" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const current = value as Record<string, unknown>;
  const expectedArgs = server.args ?? [];
  return Object.keys(current).length === 3
    && current.type === "stdio"
    && current.command === server.command
    && Array.isArray(current.args)
    && current.args.length === expectedArgs.length
    && current.args.every((arg, index) => arg === expectedArgs[index]);
}

export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  name: "Claude Code",
  detect: detectClaudeCode,

  reportCapabilities(configDir) {
    const prompt = readTextIfExists(path.join(configDir, "CLAUDE.md"));
    return createLocalCapabilityReport("claude-code", [
      ...(hasManagedMarkdownSection(prompt, "system-prompt")
        ? [{
            id: "policy-guidance",
            state: "prompt-only",
            reason: "The managed policy prompt is advisory and cannot enforce the policy",
            evidence: { source: "jorgex-stack-system-prompt", version: "1" },
          }]
        : []),
      ...(hasClaudeManualApproval(configDir)
        ? [{
            id: "tool-approval",
            state: "manual",
            reason: "Canonical approval declarations require a human decision; runtime activation is not certified",
            evidence: { source: "jorgex-stack-claude-approval-policy", version: "1" },
          }]
        : []),
    ]);
  },

  injectEngramProtocol(ctx) {
    // El plugin oficial ya inyecta el protocolo (hooks + skill memory).
    return !hasEngramPlugin(ctx.configDir);
  },

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
    // El orchestrator (primary) es un output style del agente principal. Su
    // body es solo el wrapper; planSkills instala el workflow canónico.
    if (agent.mode === "primary") {
      const title = agent.name.charAt(0).toUpperCase() + agent.name.slice(1);
      const style = `---\nname: ${title}\ndescription: ${yamlString(agent.description)}\nkeep-coding-instructions: true\n---\n${agent.body}`;
      return [{ file: `${agent.name}.md`, content: style, kind: "output-style" as const }];
    }

    const lines = [`name: ${agent.name}`, `description: ${yamlString(agent.description)}`];
    const tools = toolsFor(agent);
    if (tools !== null) lines.push(`tools: ${tools}`);
    lines.push(`model: ${resolveAgentModel(models, agent.name, agent.tier).model}`);

    // Claude Code no tiene deny de comandos por-subagente; un hook PreToolUse en
    // el frontmatter del subagente es el mecanismo documentado para bloquear git
    // destructivo solo en los full-bash, sin tocar al agente principal.
    // {{SCRIPTS_DIR}} lo resuelve planAgents a la ruta de scripts instalada.
    if (agent.bash === "full") {
      lines.push(
        "hooks:",
        "  PreToolUse:",
        '    - matcher: "Bash|PowerShell"',
        "      hooks:",
        "        - type: command",
        `          command: "node \\"{{SCRIPTS_DIR}}/${GIT_GUARD_SCRIPT}\\""`,
      );
    }

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
    const original = readTextIfExists(path.join(ctx.configDir, "settings.json"));
    const contentSource = original === null || original.trim() === "" ? null : original;

    // El formato canónico ES el de Claude Code: upsert directo en settings.json.
    const settingsFile = path.join(ctx.configDir, "settings.json");
    let content = upsertNativeHooks(contentSource, canonical, scriptsDir);

    // Permisos por defecto: solo en config fresca o vacía. Una config
    // existente no se auto-expande jamás.
    const defaults = loadCanonicalDefaults(ctx.stackDir)["claude-code"];
    if (contentSource === null && defaults?.["permissions"] !== undefined) {
      content = upsertJson(content, (root) => {
        if (root["permissions"] === undefined) {
          root["permissions"] = defaults["permissions"];
          ctx.warnings.push(
            "Claude Code: fresh config enables read-anywhere via Read/Grep/Glob allow rules; shell, writes and web egress remain approval-gated, but broad local reads can expose secrets not covered by deny rules.",
          );
        }
      });
    }
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

    const mcpOwnership: McpOwnershipChange[] = [];
    const content = upsertJson(readTextIfExists(file), (root) => {
      const servers = (root["mcpServers"] ??= {}) as Record<string, Record<string, unknown>>;
      for (const [name, server] of Object.entries(canonical.servers)) {
        const existing = servers[name];
        const owned = ctx.ownedMcpServers?.has(name) === true;
        if (!isCanonicalMcpServerEnabled(name, server, ctx.enabledMcpServers)) {
          if (owned) {
            if (isManagedOptionalStdioServer(server, existing)) delete servers[name];
            mcpOwnership.push({ server: name, owned: false });
          }
          continue;
        }
        if (server.optional && existing !== undefined) {
          if (!owned || !isManagedOptionalStdioServer(server, existing)) {
            if (owned) mcpOwnership.push({ server: name, owned: false });
            ctx.warnings.push(`Claude Code: MCP opcional '${name}' ya pertenece a la configuración del usuario; se conserva.`);
            continue;
          }
        }
        if (server.transport === "stdio") {
          // El plugin oficial ya provee el MCP: registrarlo duplicaría las
          // tools. Si un sync anterior (pre-plugin) lo registró, se retira.
          if (server.command === "{{ENGRAM_BIN}}" && hasEngramPlugin(ctx.configDir)) {
            if (name in servers) delete servers[name];
            ctx.warnings.push(
              "Claude Code: Engram ya está integrado vía plugin — no se registra el MCP para no duplicar las tools de memoria.",
            );
            continue;
          }
          if (server.command === "{{ENGRAM_BIN}}" && ctx.engramBin === null) {
            ctx.warnings.push(
              "Engram no detectado: el MCP 'engram' no se registra. Instálalo (github.com/Gentleman-Programming/engram) y re-ejecuta sync.",
            );
            continue;
          }
          const command = server.command === "{{ENGRAM_BIN}}" ? ctx.engramBin! : server.command!;
          // type: "stdio" explícito (igual que el http lleva type) — Claude Code
          // lo infiere por `command`, pero la doc actual siempre lo declara y es
          // robusto frente a versiones más estrictas.
          servers[name] = { type: "stdio", command, args: server.args ?? [] };
          if (server.optional && existing === undefined && !owned) mcpOwnership.push({ server: name, owned: true });
        } else {
          const previous = servers[name] as { headers?: Record<string, string> } | undefined;
          const headers: Record<string, string> = {};
          for (const [key, raw] of Object.entries(server.headers ?? {})) {
            const envRef = /^\$\{(\w+)\}$/.exec(raw);
            // D5: el valor del usuario se preserva. Sin valor previo queda
            // vacío: ~/.claude.json no tiene sintaxis de referencia a env
            // vars, y escribir el secreto literal en el archivo va contra la
            // política del stack — el usuario lo conecta cuando quiera.
            headers[key] = previous?.headers?.[key] || (envRef ? "" : raw);
          }
          servers[name] = {
            type: "http",
            url: server.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        }
      }
    });

    return [{ kind: "write", target: file, content, ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}) }];
  },

  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      let content = removeMarkdownSection(prompt, "system-prompt");
      content = removeMarkdownSection(content, "engram-protocol");
      content = removeMarkdownSection(content, "browser");
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const settingsFile = path.join(ctx.configDir, "settings.json");
    const settings = readTextIfExists(settingsFile);
    if (settings !== null) {
      const content = removeNativeHooks(settings, hooks);
      if (content !== null) {
        actions.push({ kind: "write", target: settingsFile, content: content.trim() === "{}" ? "" : content });
      }
    }

    const mainFile = path.join(path.dirname(ctx.configDir), `${path.basename(ctx.configDir)}.json`);
    const main = readTextIfExists(mainFile);
    if (main !== null) {
      const mcpOwnership: McpOwnershipChange[] = [];
      const content = upsertJson(main, (root) => {
        const servers = root["mcpServers"] as Record<string, unknown> | undefined;
        if (!servers) return;
        for (const [name, server] of Object.entries(mcp.servers)) {
          if (!server.optional) {
            delete servers[name];
            continue;
          }
          if (ctx.ownedMcpServers?.has(name) === true) {
            if (isManagedOptionalStdioServer(server, servers[name])) delete servers[name];
            mcpOwnership.push({ server: name, owned: false });
          }
        }
        if (Object.keys(servers).length === 0) delete root["mcpServers"];
      });
      // ~/.claude.json es el archivo de ESTADO del CLI de Claude (onboarding,
      // proyectos): aunque quede vacío, jamás se borra — se deja {}.
      actions.push({ kind: "write", target: mainFile, content, ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}) });
    }

    return actions;
  },
};
