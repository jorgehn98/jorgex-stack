import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange } from "./types.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectOpenCode } from "../lib/detect.js";
import { HOME, samePath } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import { removeMarkdownSection, upsertJson } from "../lib/filemerge.js";
import { hookScriptNames } from "../lib/hooks-format.js";
import { DESTRUCTIVE_GIT_DENY } from "../lib/git-guard.js";

/** Escalar YAML siempre double-quoted: válido y a prueba de ':' o comillas. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function isManagedOptionalStdioServer(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  if (!server.optional || server.transport !== "stdio" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const current = value as Record<string, unknown>;
  const expectedCommand = [server.command, ...(server.args ?? [])];
  return Object.keys(current).length === 2
    && current.type === "local"
    && Array.isArray(current.command)
    && current.command.length === expectedCommand.length
    && current.command.every((arg, index) => arg === expectedCommand[index]);
}

const PRIMARY_MODEL = "openai/gpt-5.6-sol";
const PRIMARY_MODEL_ID = "gpt-5.6-sol";
const PRIMARY_LIMITS = { context: 872000, input: 744000, output: 128000 } as const;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (parent[key] === undefined) parent[key] = {};
  return objectValue(parent[key]);
}

function pruneEmpty(parent: Record<string, unknown>, key: string): void {
  const value = objectValue(parent[key]);
  if (value !== null && Object.keys(value).length === 0) delete parent[key];
}

export const opencodeAdapter: Adapter = {
  id: "opencode",
  name: "OpenCode",
  detect: detectOpenCode,

  injectEngramProtocol() {
    // El plugin engram.ts (que este mismo install despliega) inyecta el
    // protocolo en runtime — única fuente, sin sección duplicada en AGENTS.md.
    return false;
  },

  paths(configDir) {
    // Skills: OpenCode lee ~/.agents/skills nativamente (verificado en
    // packages/opencode/src/skill/index.ts) — la misma copia sirve a Codex,
    // sin duplicar en ~/.config/opencode/skills. Con el configDir real
    // (aunque venga de OPENCODE_CONFIG_DIR) el ancla es HOME; con --target-dir,
    // su padre (mismo patrón que Codex en pruebas).
    const isRealConfigDir = samePath(
      configDir,
      process.env.OPENCODE_CONFIG_DIR ?? path.join(HOME, ".config", "opencode"),
    );
    const agentsHome = isRealConfigDir ? HOME : path.dirname(configDir);
    return {
      systemPromptFile: path.join(configDir, "AGENTS.md"),
      agentsDir: path.join(configDir, "agents"),
      skillsDir: path.join(agentsHome, ".agents", "skills"),
      commandsDir: path.join(configDir, "commands"),
      pluginsDir: path.join(configDir, "plugins"),
      scriptsDir: path.join(configDir, "scripts"),
      outputStylesDir: null,
      profilesDir: null,
    };
  },

  renderAgent(agent: CanonicalAgent, models: RuntimeModelMap) {
    const lines: string[] = [`description: ${yamlString(agent.description)}`, `mode: ${agent.mode}`];

    // Paridad con la config original: los primary no fijan modelo ni permisos
    // (usan el modelo seleccionado por el usuario y los defaults globales).
    if (agent.mode === "subagent") {
      const tierModel = resolveAgentModel(models, agent.name, agent.tier);
      lines.push(`model: ${tierModel.model}`);
      if (tierModel.variant) lines.push(`variant: ${tierModel.variant}`);

      lines.push("permission:");
      lines.push(`  edit: ${agent.readonly ? "deny" : "allow"}`);
      if (agent.bash === "none") lines.push("  bash: deny");
      else if (agent.bash === "git-read") lines.push('  bash:\n    "git diff*": allow\n    "git log*": allow');
      else {
        // full-bash: todo permitido EXCEPTO git destructivo. OpenCode evalúa por
        // orden (última regla que matchea gana), así que "*" allow va primero.
        const deny = DESTRUCTIVE_GIT_DENY.map((p) => `    ${yamlString(p)}: deny`).join("\n");
        lines.push(`  bash:\n    "*": allow\n${deny}`);
      }
      if (!agent.spawn) lines.push("  task: deny");
    }

    // En OpenCode el primary ES nativo: aparece en el ciclo de Tab junto a
    // build/plan y es el agente que el usuario pilota directamente.
    return [
      {
        file: `${agent.name}.md`,
        content: `---\n${lines.join("\n")}\n---\n${agent.body}`,
        kind: "agent" as const,
      },
    ];
  },

  renderCommand(file, content) {
    // Dialecto de input: {{input}} (canónico) → $ARGUMENTS (placeholder
    // oficial de OpenCode, igual que Claude Code — opencode.ai/docs/commands).
    return { file, content: content.replace(/\{\{input\}\}/g, "$ARGUMENTS") };
  },

  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { scriptsDir } = this.paths(ctx.configDir);

    // OpenCode no tiene hooks declarativos: el plugin puente (hooks.ts) lee su
    // propio hooks.json. Traducción: PostToolUse/Bash → tool.execute.after/bash,
    // con x-command-includes como filtro y la ruta del script relativa al configDir.
    const bashEntries: Record<string, string[]> = {};
    for (const [event, entries] of Object.entries(canonical.hooks)) {
      if (event !== "PostToolUse") {
        ctx.warnings.push(`opencode: evento de hook '${event}' aún no soportado por el puente — omitido.`);
        continue;
      }
      for (const entry of entries) {
        if (!(entry.matcher ?? "").split("|").some((p) => p.trim().toLowerCase() === "bash")) {
          ctx.warnings.push(`opencode: matcher de hook '${entry.matcher}' no soportado — omitido.`);
          continue;
        }
        const includes = entry["x-command-includes"] ?? "*";
        for (const hook of entry.hooks) {
          const match = /\{\{SCRIPTS_DIR\}\}[/\\]([\w./\\-]+)/.exec(hook.command);
          if (!match) {
            ctx.warnings.push(`opencode: hook sin {{SCRIPTS_DIR}} no traducible: ${hook.command}`);
            continue;
          }
          const script = `scripts/${path.basename(match[1]!)}`;
          (bashEntries[includes] ??= []).push(script);
        }
      }
    }

    const hooksFile = path.join(ctx.configDir, "hooks.json");
    const content = upsertJson(readTextIfExists(hooksFile), (root) => {
      const afterValue = (root["tool.execute.after"] ??= {});
      if (afterValue === null || typeof afterValue !== "object" || Array.isArray(afterValue)) {
        ctx.warnings.push("opencode: tool.execute.after no es un objeto; hooks gestionados omitidos.");
        return;
      }

      const after = afterValue as Record<string, unknown>;
      const bashValue = after["bash"];
      if (bashValue !== undefined && !Array.isArray(bashValue)
        && (bashValue === null || typeof bashValue !== "object")) {
        ctx.warnings.push("opencode: tool.execute.after.bash no es un array ni un mapa; hooks gestionados omitidos.");
        return;
      }

      const bash = Array.isArray(bashValue)
        ? { "*": bashValue }
        : (bashValue ?? {}) as Record<string, unknown>;
      after["bash"] = bash;
      const managedScripts = new Set(Object.values(bashEntries).flat());
      for (const [includes, scripts] of Object.entries(bash)) {
        if (!Array.isArray(scripts)) continue;
        const preserved = scripts.filter(
          (script) => typeof script !== "string" || !managedScripts.has(script),
        );
        if (preserved.length > 0) bash[includes] = preserved;
        else delete bash[includes];
      }
      for (const [includes, scripts] of Object.entries(bashEntries)) {
        const current = bash[includes];
        if (current !== undefined && !Array.isArray(current)) {
          ctx.warnings.push(`opencode: trigger bash '${includes}' no es un array; hook gestionado omitido.`);
          continue;
        }
        const list = (bash[includes] ??= []) as unknown[];
        for (const s of scripts) if (!list.includes(s)) list.push(s);
      }
    });
    actions.push({ kind: "write", target: hooksFile, content });

    // Los scripts canónicos viajan junto al hooks.json del runtime.
    const scriptsSource = path.join(ctx.stackDir, "scripts");
    if (fs.existsSync(scriptsSource)) {
      for (const f of fs.readdirSync(scriptsSource)) {
        actions.push({ kind: "copy", source: path.join(scriptsSource, f), target: path.join(scriptsDir, f) });
      }
    }
    return actions;
  },

  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const file = path.join(ctx.configDir, "opencode.json");
    const { pluginsDir } = this.paths(ctx.configDir);
    const original = readTextIfExists(file);
    const contentSource = original === null || original.trim() === "" ? null : original;
    const isFreshConfig = contentSource === null;

    const mcpOwnership: McpOwnershipChange[] = [];
    const content = upsertJson(contentSource, (root) => {
      root["$schema"] ??= "https://opencode.ai/config.json";
      root["model"] ??= PRIMARY_MODEL;

      const provider = ensureObject(root, "provider");
      const openai = provider === null ? null : ensureObject(provider, "openai");
      const models = openai === null ? null : ensureObject(openai, "models");
      const sol = models === null ? null : ensureObject(models, PRIMARY_MODEL_ID);
      const limit = sol === null ? null : ensureObject(sol, "limit");
      if (limit === null) {
        ctx.warnings.push("OpenCode: provider.openai.models.gpt-5.6-sol.limit no es un objeto; se conserva sin sobrescribir.");
      } else {
        for (const [key, value] of Object.entries(PRIMARY_LIMITS)) limit[key] ??= value;
      }

      // Permisos por defecto: solo en config fresca o vacía. Una config
      // existente no se auto-expande jamás.
      const defaults = loadCanonicalDefaults(ctx.stackDir)["opencode"];
      if (isFreshConfig && defaults?.["permission"] !== undefined) {
        root["permission"] = defaults["permission"];
        ctx.warnings.push(
          "OpenCode: fresh config enables read-anywhere via external_directory:*; edits, web egress and arbitrary bash remain approval-gated, but broad local reads can expose secrets not covered by deny rules.",
        );
      }

      const mcp = (root["mcp"] ??= {}) as Record<string, Record<string, unknown>>;
      for (const [name, server] of Object.entries(canonical.servers)) {
        const existing = mcp[name];
        const owned = ctx.ownedMcpServers?.has(name) === true;
        if (!isCanonicalMcpServerEnabled(name, server, ctx.enabledMcpServers)) {
          if (owned) {
            if (isManagedOptionalStdioServer(server, existing)) delete mcp[name];
            mcpOwnership.push({ server: name, owned: false });
          }
          continue;
        }
        if (server.optional && existing !== undefined) {
          if (!owned || !isManagedOptionalStdioServer(server, existing)) {
            if (owned) mcpOwnership.push({ server: name, owned: false });
            ctx.warnings.push(`OpenCode: MCP opcional '${name}' ya pertenece a la configuración del usuario; se conserva.`);
            continue;
          }
        }
        if (server.transport === "stdio") {
          if (server.command === "{{ENGRAM_BIN}}" && ctx.engramBin === null) {
            ctx.warnings.push(
              "Engram no detectado: el MCP 'engram' no se registra. Instálalo (github.com/Gentleman-Programming/engram) y re-ejecuta sync.",
            );
            continue;
          }
          const command = server.command === "{{ENGRAM_BIN}}" ? ctx.engramBin! : server.command!;
          mcp[name] = { type: "local", command: [command, ...(server.args ?? [])] };
          if (server.optional && existing === undefined && !owned) mcpOwnership.push({ server: name, owned: true });
        } else {
          const previous = mcp[name] as { headers?: Record<string, string> } | undefined;
          const headers: Record<string, string> = {};
          for (const [key, raw] of Object.entries(server.headers ?? {})) {
            const envRef = /^\$\{(\w+)\}$/.exec(raw);
            // D5: el valor que el usuario ya tenga configurado manda. Sin
            // valor previo se escribe la REFERENCIA nativa de OpenCode
            // ({env:VAR}): el secreto vive en el entorno, nunca en el archivo.
            headers[key] = previous?.headers?.[key] || (envRef ? `{env:${envRef[1]!}}` : raw);
          }
          mcp[name] = {
            type: "remote",
            url: server.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
        }
      }

      // Los plugins locales viven en pluginsDir y OpenCode los AUTO-CARGA al
      // arrancar (opencode.ai/docs/plugins): no se registran en el array
      // `plugin` — ahí solo van los paquetes npm del usuario. Los registros
      // file:// nuestros de versiones anteriores se retiran (redundantes con
      // el auto-load; mantenerlos arriesga doble carga).
      if (pluginsDir !== null) {
        const plugin = root["plugin"] as string[] | undefined;
        if (Array.isArray(plugin)) {
          const pluginsDirPrefix = pathToFileURL(pluginsDir).href + "/";
          const kept = plugin.filter((url) => !url.startsWith(pluginsDirPrefix));
          if (kept.length === 0) delete root["plugin"];
          else root["plugin"] = kept;
          // Si el usuario usa OTRA integración de engram (paquete npm), la
          // copia local engram.ts del stack duplicaría protocolo y eventos.
          if (kept.some((u) => /engram/i.test(u))) {
            ctx.warnings.push(
              "OpenCode: hay un plugin de Engram registrado como paquete — revisa que no conviva con el engram.ts del stack (duplicaría la integración).",
            );
          }
        }
      }
    });

    return [{ kind: "write", target: file, content, ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}) }];
  },

  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile, pluginsDir } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      let content = removeMarkdownSection(prompt, "system-prompt");
      content = removeMarkdownSection(content, "engram-protocol");
      content = removeMarkdownSection(content, "browser");
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const configFile = path.join(ctx.configDir, "opencode.json");
    const config = readTextIfExists(configFile);
    if (config !== null) {
      const mcpOwnership: McpOwnershipChange[] = [];
      const content = upsertJson(config, (root) => {
        if (root["model"] === PRIMARY_MODEL) delete root["model"];

        const provider = objectValue(root["provider"]);
        const openai = provider === null ? null : objectValue(provider["openai"]);
        const models = openai === null ? null : objectValue(openai["models"]);
        const sol = models === null ? null : objectValue(models[PRIMARY_MODEL_ID]);
        const limit = sol === null ? null : objectValue(sol["limit"]);
        if (limit !== null) {
          for (const [key, value] of Object.entries(PRIMARY_LIMITS)) {
            if (limit[key] === value) delete limit[key];
          }
          pruneEmpty(sol!, "limit");
          pruneEmpty(models!, PRIMARY_MODEL_ID);
          pruneEmpty(openai!, "models");
          pruneEmpty(provider!, "openai");
          pruneEmpty(root, "provider");
        }

        const mcpBlock = root["mcp"] as Record<string, unknown> | undefined;
        if (mcpBlock) {
          for (const [name, server] of Object.entries(mcp.servers)) {
            if (!server.optional) {
              delete mcpBlock[name];
              continue;
            }
            if (ctx.ownedMcpServers?.has(name) === true) {
              if (isManagedOptionalStdioServer(server, mcpBlock[name])) delete mcpBlock[name];
              mcpOwnership.push({ server: name, owned: false });
            }
          }
          if (Object.keys(mcpBlock).length === 0) delete root["mcp"];
        }
        const plugin = root["plugin"] as string[] | undefined;
        if (Array.isArray(plugin) && pluginsDir !== null) {
          // Registros file:// bajo nuestro pluginsDir: residuos de versiones
          // antiguas (los locales se auto-cargan del dir). Quitarlos no toca
          // los archivos — engram.ts se conserva en disco vía preserveEngram.
          const pluginsDirPrefix = pathToFileURL(pluginsDir).href + "/";
          const kept = plugin.filter((url) => !url.startsWith(pluginsDirPrefix));
          if (kept.length === 0) delete root["plugin"];
          else root["plugin"] = kept;
        }
      });
      actions.push({ kind: "write", target: configFile, content, ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}) });
    }

    const hooksFile = path.join(ctx.configDir, "hooks.json");
    const hooksJson = readTextIfExists(hooksFile);
    if (hooksJson !== null) {
      const ourScripts = hookScriptNames(hooks);
      const content = upsertJson(hooksJson, (root) => {
        const after = root["tool.execute.after"] as Record<string, Record<string, string[]>> | undefined;
        if (!after) return;
        for (const tool of Object.keys(after)) {
          const byCommand = after[tool]!;
          for (const includes of Object.keys(byCommand)) {
            byCommand[includes] = byCommand[includes]!.filter(
              (script) => !ourScripts.some((s) => script.includes(s)),
            );
            if (byCommand[includes]!.length === 0) delete byCommand[includes];
          }
          if (Object.keys(byCommand).length === 0) delete after[tool];
        }
        if (Object.keys(after).length === 0) delete root["tool.execute.after"];
      });
      actions.push({ kind: "write", target: hooksFile, content: content.trim() === "{}" ? "" : content });
    }

    return actions;
  },
};
