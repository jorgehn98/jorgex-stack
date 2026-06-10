import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext } from "./types.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import type { RuntimeModelMap } from "../lib/model-map.js";
import { detectCodex } from "../lib/detect.js";
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

export const codexAdapter: Adapter = {
  id: "codex",
  name: "Codex CLI",
  detect: detectCodex,

  paths(configDir) {
    // Skills: estándar agentskills.io en ~/.agents/skills (NO ~/.codex/skills).
    // Se deriva del padre del configDir para que --target-dir en pruebas
    // escriba <target-padre>/.agents/skills y nunca toque el real.
    const skillsDir = path.join(path.dirname(configDir), ".agents", "skills");
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
    const tierModel = models[agent.tier];

    // El orchestrator (primary) es un modo del agente principal: profile
    // (`codex --profile orchestrator`, developer_instructions con rol
    // developer) + skill de activación puntual dentro de una sesión.
    if (agent.mode === "primary") {
      const profileLines = [
        "# Managed by jorgex-stack — modo orquestador del agente principal.",
        `# Uso: codex --profile ${agent.name}`,
        `developer_instructions = ${tomlMultiline(agent.body)}`,
      ];
      if (tierModel.model !== "default") profileLines.push(`model = ${tomlString(tierModel.model)}`);
      if (tierModel.variant) profileLines.push(`model_reasoning_effort = ${tomlString(tierModel.variant)}`);

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
      matcher === "Bash" ? "shell" : matcher,
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
    let content = readTextIfExists(file);

    for (const [name, server] of Object.entries(canonical.servers)) {
      const section = `mcp_servers.${name}`;
      if (server.transport === "stdio") {
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
        const headerPairs = Object.entries(server.headers ?? {}).map(([key, raw]) => {
          const envRef = /^\$\{(\w+)\}$/.exec(raw);
          const fromSecrets = envRef ? (ctx.secrets[envRef[1]!] ?? "") : raw;
          // D5: preservar el valor que el usuario ya tenga configurado.
          const previousValue =
            previousSection !== null
              ? new RegExp(`"?${key}"?\\s*=\\s*"([^"]*)"`).exec(previousSection)?.[1]
              : undefined;
          const value = fromSecrets !== "" ? fromSecrets : (previousValue ?? "");
          return `${tomlString(key)} = ${tomlString(value)}`;
        });
        const body = [`url = ${tomlString(server.url!)}`];
        if (headerPairs.length > 0) body.push(`http_headers = { ${headerPairs.join(", ")} }`);
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
