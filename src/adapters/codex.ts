import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "./types.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectCodex } from "../lib/detect.js";
import { loadCanonicalDefaults } from "../lib/canonical.js";
import { HOME, samePath } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import { readTomlSection, removeMarkdownSection, removeTomlSection, upsertTomlSection } from "../lib/filemerge.js";
import { removeNativeHooks, upsertNativeHooks } from "../lib/hooks-format.js";

/** String TOML de una línea (los escapes de JSON son válidos en basic strings). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Bloques largos como literal multiline (''' no interpreta escapes: los
 * backslashes y comillas del markdown viajan intactos). Fallback a basic
 * string si el contenido contiene ''' (no interpretable como literal).
 */
function tomlMultiline(value: string): string {
  if (value.includes("'''")) return JSON.stringify(value);
  return `'''\n${value.replace(/\r\n/g, "\n").trim()}\n'''`;
}

/**
 * Plugin de marketplace engram ACTIVO: provee las MCP tools, así que registrar
 * el MCP además duplicaría. Un plugin presente pero `enabled = false` NO
 * cuenta: en ese caso el MCP manual es la integración real y debe conservarse.
 */
function hasActiveEngramPlugin(configDir: string): boolean {
  const config = readTextIfExists(path.join(configDir, "config.toml"));
  if (config === null) return false;
  const match = /\[plugins\."engram@[^"]*"\]([^[]*)/.exec(config);
  return match !== null && !/enabled\s*=\s*false/.test(match[1]!);
}

/**
 * Protocolo de memoria ya presente por otra vía: plugin activo, o un
 * engram-instructions.md de `engram setup codex` (en configDir o referenciado
 * como model_instructions_file en config.toml). En ese caso no se inyecta la
 * sección engram-protocol en AGENTS.md para no duplicarlo.
 */
function hasEngramProtocol(configDir: string): boolean {
  if (hasActiveEngramPlugin(configDir)) return true;
  if (fs.existsSync(path.join(configDir, "engram-instructions.md"))) return true;
  const config = readTextIfExists(path.join(configDir, "config.toml"));
  return config !== null && /engram-instructions\.md/.test(config);
}

/**
 * Upsert "tonto" de un header TOML literal: necesario cuando el último
 * segmento del path contiene caracteres que `upsertTomlSection` normaliza
 * (p. ej. `[….":workspace_roots"]`: el `.` dentro del quoted segment rompe
 * el matching por path segmentado). Aquí solo se evita duplicar el header.
 */
export const codexAdapter: Adapter = {
  id: "codex",
  name: "Codex CLI",
  detect: detectCodex,

  injectEngramProtocol(ctx) {
    return !hasEngramProtocol(ctx.configDir);
  },

  paths(configDir) {
    // Skills: estándar agentskills.io en ~/.agents/skills (NO ~/.codex/skills).
    // Con el configDir real (aunque venga de CODEX_HOME) el ancla es HOME — la
    // copia compartida con OpenCode; con --target-dir, el padre del target.
    const isRealConfigDir = samePath(configDir, process.env.CODEX_HOME ?? path.join(HOME, ".codex"));
    const agentsHome = isRealConfigDir ? HOME : path.dirname(configDir);
    const skillsDir = path.join(agentsHome, ".agents", "skills");
    return {
      systemPromptFile: path.join(configDir, "AGENTS.md"),
      agentsDir: path.join(configDir, "agents"),
      skillsDir,
      // Los custom prompts de Codex están deprecados: los commands se
      // instalan como skills (renderCommand produce <nombre>/SKILL.md).
      commandsDir: skillsDir,
      pluginsDir: null,
      scriptsDir: path.join(configDir, "scripts"),
      outputStylesDir: null,
      profilesDir: configDir,
    };
  },

  renderAgent(agent: CanonicalAgent, models: RuntimeModelMap) {
    const tierModel = resolveAgentModel(models, agent.name, agent.tier);

    // El orchestrator (primary) es un modo del agente principal: profile
    // (`codex --profile orchestrator`, developer_instructions con rol
    // developer) + skill de activación puntual dentro de una sesión.
    // Sin model ni effort: el primary usa SIEMPRE el modelo que el usuario
    // tenga por defecto (y puede cambiarlo en sesión) — solo los subagentes
    // fijan modelo por tier.
    if (agent.mode === "primary") {
      const profileLines = [
        "# Managed by jorgex-stack — modo orquestador del agente principal.",
        `# Uso: codex --profile ${agent.name}`,
        `developer_instructions = ${tomlMultiline(agent.body)}`,
      ];

      const skillDescription = `${agent.description} Invoke to switch into ${agent.name} mode and apply its flow to the current task.`;
      const skill = `---\nname: ${agent.name}\ndescription: ${JSON.stringify(skillDescription)}\n---\n${agent.body}`;

      return [
        { file: `${agent.name}.config.toml`, content: profileLines.join("\n") + "\n", kind: "profile" as const },
        { file: `${agent.name}/SKILL.md`, content: skill, kind: "skill" as const },
      ];
    }

    const lines = [
      `name = ${tomlString(agent.name)}`,
      `description = ${tomlString(agent.description)}`,
    ];
    if (tierModel.model !== "default") lines.push(`model = ${tomlString(tierModel.model)}`);
    if (tierModel.variant) lines.push(`model_reasoning_effort = ${tomlString(tierModel.variant)}`);
    // readonly (y bash none/git-read) → sandbox read-only; con escritura → workspace.
    lines.push(`sandbox_mode = ${tomlString(agent.readonly ? "read-only" : "workspace-write")}`);
    lines.push(`developer_instructions = ${tomlMultiline(agent.body)}`);

    return [{ file: `${agent.name}.toml`, content: lines.join("\n") + "\n", kind: "agent" as const }];
  },

  renderCommand(file, content) {
    // Commands → skills (custom prompts deprecados en Codex).
    const name = file.replace(/\.md$/, "");
    let description = name;
    let body = content;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    if (fm) {
      const match = /(?:^|\n)description:\s*(.+)/.exec(fm[1]!);
      if (match) description = match[1]!.trim();
      body = content.slice(fm[0].length);
    }
    body = body.replace(/\{\{input\}\}/g, "the user's request in this conversation");
    return {
      file: `${name}/SKILL.md`,
      content: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
    };
  },

  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { scriptsDir } = this.paths(ctx.configDir);

    // Mismo formato que Claude Code; el tool de shell en Codex se llama "shell".
    const hooksFile = path.join(ctx.configDir, "hooks.json");
    const content = upsertNativeHooks(readTextIfExists(hooksFile), canonical, scriptsDir, (matcher) =>
      matcher.split("|").some((p) => p.trim() === "Bash") ? "shell" : matcher,
    );
    actions.push({ kind: "write", target: hooksFile, content });
    ctx.warnings.push(
      "Codex: los hooks no-managed requieren aprobación manual — ejecuta /hooks dentro de codex para activarlos.",
    );

    const scriptsSource = path.join(ctx.stackDir, "scripts");
    if (fs.existsSync(scriptsSource)) {
      for (const f of fs.readdirSync(scriptsSource)) {
        actions.push({ kind: "copy", source: path.join(scriptsSource, f), target: path.join(scriptsDir, f) });
      }
    }
    return actions;
  },

  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const file = path.join(ctx.configDir, "config.toml");
    const original = readTextIfExists(file);
    const contentSource = original === null || original.trim() === "" ? null : original;
    let content = contentSource;

    // Permisos por defecto: solo en config fresca o vacía. Una config
    // existente no se auto-expande jamás.
    if (contentSource === null) {
      const defaults = loadCanonicalDefaults(ctx.stackDir)["codex"] ?? {};
      for (const [key, value] of Object.entries(defaults)) {
        const line = `${key} = ${tomlString(String(value))}\n`;
        content = content === null ? line : line + content;
      }

      ctx.warnings.push(
        "Codex: fresh config enables read-anywhere via the jorgex-read-anywhere permission profile; broad local reads can expose secrets not covered by deny rules.",
      );

      content = upsertTomlSection(content, "permissions.jorgex-read-anywhere", 'extends = ":workspace"');
      content = upsertTomlSection(
        content,
        "permissions.jorgex-read-anywhere.filesystem",
        [
          '":root" = "read"',
          '"*.env" = "deny"',
          '"*.env.*" = "deny"',
          '"~/.ssh/**" = "deny"',
          '"~/.aws/credentials" = "deny"',
          '"~/.npmrc" = "deny"',
          '"~/.git-credentials" = "deny"',
          '"**/id_rsa" = "deny"',
          '"**/id_ed25519" = "deny"',
          '"**/*.pem" = "deny"',
          '"**/*.key" = "deny"',
        ].join("\n"),
      );
      content += [
        '\n[permissions.jorgex-read-anywhere.filesystem.":workspace_roots"]',
        '"." = "write"',
        '"*.env" = "deny"',
        '"*.env.*" = "deny"',
        '".ssh/**" = "deny"',
        '".aws/credentials" = "deny"',
        '".npmrc" = "deny"',
        '".git-credentials" = "deny"',
        '"**/id_rsa" = "deny"',
        '"**/id_ed25519" = "deny"',
        '"**/*.pem" = "deny"',
        '"**/*.key" = "deny"',
        "",
      ].join("\n");
    }

    for (const [name, server] of Object.entries(canonical.servers)) {
      const section = `mcp_servers.${name}`;
      if (server.transport === "stdio") {
        // Con el plugin de marketplace ACTIVO, el MCP duplicaría las tools.
        // Si un sync anterior (pre-plugin) lo registró, se retira.
        if (server.command === "{{ENGRAM_BIN}}" && hasActiveEngramPlugin(ctx.configDir)) {
          if (content !== null) content = removeTomlSection(content, section);
          ctx.warnings.push(
            "Codex: Engram ya está integrado vía plugin de marketplace — no se registra el MCP para no duplicar las tools de memoria.",
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
        const args = (server.args ?? []).map(tomlString).join(", ");
        content = upsertTomlSection(content, section, `command = ${tomlString(command)}\nargs = [${args}]`);
      } else {
        const previousSection = readTomlSection(content, section);
        // D5: si el usuario tiene un valor LITERAL configurado, se preserva
        // (http_headers). En cualquier otro caso se escribe env_http_headers:
        // el header sale de una variable de entorno, nunca del archivo.
        const prevUsesEnvHeaders = previousSection?.includes("env_http_headers") ?? false;
        const literalPairs: string[] = [];
        const refPairs: string[] = [];
        for (const [key, raw] of Object.entries(server.headers ?? {})) {
          const envRef = /^\$\{(\w+)\}$/.exec(raw);
          // Key escapada y anclada para no casar dentro de otra clave.
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const previousValue =
            !prevUsesEnvHeaders && previousSection !== null
              ? new RegExp(`(?:^|[{,]\\s*)"?${escaped}"?\\s*=\\s*"([^"]*)"`, "m").exec(previousSection)?.[1]
              : undefined;
          if (previousValue) literalPairs.push(`${tomlString(key)} = ${tomlString(previousValue)}`);
          else refPairs.push(`${tomlString(key)} = ${tomlString(envRef ? envRef[1]! : raw)}`);
        }
        const body = [`url = ${tomlString(server.url!)}`];
        if (literalPairs.length > 0) body.push(`http_headers = { ${literalPairs.join(", ")} }`);
        if (refPairs.length > 0) body.push(`env_http_headers = { ${refPairs.join(", ")} }`);
        content = upsertTomlSection(content, section, body.join("\n"));
      }
    }

    if (content === null) return [];
    if (!content.endsWith("\n")) content += "\n";
    return [{ kind: "write", target: file, content }];
  },

  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      let content = removeMarkdownSection(prompt, "system-prompt");
      content = removeMarkdownSection(content, "engram-protocol");
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const configFile = path.join(ctx.configDir, "config.toml");
    const config = readTextIfExists(configFile);
    if (config !== null) {
      let content = config;
      for (const name of Object.keys(mcp.servers)) content = removeTomlSection(content, `mcp_servers.${name}`);
      actions.push({ kind: "write", target: configFile, content });
    }

    const hooksFile = path.join(ctx.configDir, "hooks.json");
    const hooksJson = readTextIfExists(hooksFile);
    if (hooksJson !== null) {
      const content = removeNativeHooks(hooksJson, hooks);
      if (content !== null) {
        actions.push({ kind: "write", target: hooksFile, content: content.trim() === "{}" ? "" : content });
      }
    }

    return actions;
  },
};
