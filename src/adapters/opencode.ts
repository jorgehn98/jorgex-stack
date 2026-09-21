import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange, PrimaryModelOwnershipChange } from "./types.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectOpenCode } from "../lib/detect.js";
import { HOME, samePath } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import { upsertJson } from "../lib/filemerge.js";
import { hookScriptNames } from "../lib/hooks-format.js";
import { createLocalCapabilityReport, hasManagedMarkdownSection } from "../lib/quality-capabilities.js";
import { stackRoot } from "../lib/paths.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";

const gitReadPrefix = "git --no-pager -c core.fsmonitor=false -c log.showSignature=false";
const gitReadCommands = [
  "diff", "diff --stat", "diff --name-only", "diff --cached", "log", "log --oneline -10",
].map((action) => `${gitReadPrefix} ${action} --no-ext-diff --no-textconv --end-of-options`);

/** Escalar YAML siempre double-quoted: válido y a prueba de ':' o comillas. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function readMcpConfig(file: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    if (code === "ENOENT") return null;
    throw new Error(`OpenCode: no se pudo leer la configuración MCP en ${file} (${code}).`);
  }
  if (content.trim() !== "") {
    try {
      if (objectValue(JSON.parse(content)) === null) throw new Error();
    } catch {
      throw new Error(`OpenCode: la configuración MCP en ${file} debe contener un objeto JSON válido.`);
    }
  }
  return content;
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
const PRIMARY_MODEL_FIELD = "model";
const PRIMARY_PROVIDER_FIELD = "provider";
const PRIMARY_OPENAI_FIELD = "provider.openai";
const PRIMARY_MODELS_FIELD = "provider.openai.models";
const PRIMARY_SOL_FIELD = `provider.openai.models.${PRIMARY_MODEL_ID}`;
const PRIMARY_LIMIT_PREFIX = `provider.openai.models.${PRIMARY_MODEL_ID}.limit`;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCompatibleContext7Server(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  const current = objectValue(value);
  if (server.transport !== "http" || typeof server.url !== "string" || current === null) return false;
  return current.type === "remote" && current.url === server.url
    && (current.enabled === undefined || current.enabled === true);
}

function canonicalContext7Server(server: CanonicalMcp["servers"][string]): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(server.headers ?? {})) {
    const envRef = /^\$\{(\w+)\}$/.exec(raw);
    headers[key] = envRef ? `{env:${envRef[1]!}}` : raw;
  }
  return {
    type: "remote",
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function isCanonicalContext7Server(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  return isCompatibleContext7Server(server, value) && isDeepStrictEqual(value, canonicalContext7Server(server));
}

function assertCompatibleContext7(server: CanonicalMcp["servers"][string], value: unknown): void {
  if (value !== undefined && !isCompatibleContext7Server(server, value)) {
    throw new Error("OpenCode: MCP 'context7' entra en conflicto con una definición existente (endpoint, tipo o estado nativo incompatible). Conserva la configuración y corrige el conflicto antes de reintentar.");
  }
}

function ensureObject(parent: Record<string, unknown>, key: string, fieldPath: string): Record<string, unknown> {
  if (parent[key] === undefined) parent[key] = {};
  const value = objectValue(parent[key]);
  if (value === null) throw new Error(`OpenCode: '${fieldPath}' debe ser un objeto; corrígelo antes de reintentar sync.`);
  return value;
}

function ensureOwnedPrimaryObject(
  parent: Record<string, unknown>,
  key: string,
  field: string,
  owned: ReadonlySet<string> | undefined,
  changes: PrimaryModelOwnershipChange[],
): Record<string, unknown> {
  const created = parent[key] === undefined;
  const value = ensureObject(parent, key, field);
  if (created && owned?.has(field) !== true) changes.push({ field, owned: true });
  return value;
}

function pruneEmpty(parent: Record<string, unknown>, key: string): void {
  const value = objectValue(parent[key]);
  if (value !== null && Object.keys(value).length === 0) delete parent[key];
}

function hasOpenCodeManualApproval(configDir: string): boolean {
  const content = readTextIfExists(path.join(configDir, "opencode.json"));
  if (content === null) return false;

  try {
    const root = JSON.parse(content) as unknown;
    const permission = objectValue(objectValue(root)?.permission);
    const expected = loadCanonicalDefaults(stackRoot())["opencode"]?.["permission"];
    return permission !== null && expected !== undefined && isDeepStrictEqual(permission, expected);
  } catch {
    return false;
  }
}

export const opencodeAdapter: Adapter = {
  id: "opencode",
  name: "OpenCode",
  excludedPluginBasenames: ["engram.ts"],
  detect: detectOpenCode,

  reportCapabilities(configDir) {
    const prompt = readTextIfExists(path.join(configDir, "AGENTS.md"));
    return createLocalCapabilityReport("opencode", [
      ...(hasManagedMarkdownSection(prompt, "system-prompt")
        ? [{
            id: "policy-guidance",
            state: "prompt-only",
            reason: "The managed policy prompt is advisory and cannot enforce the policy",
            evidence: { source: "jorgex-stack-system-prompt", version: "1" },
          }]
        : []),
      ...(hasOpenCodeManualApproval(configDir)
        ? [{
            id: "tool-approval",
            state: "manual",
            reason: "Canonical approval declarations require a human decision; runtime activation is not certified",
            evidence: { source: "jorgex-stack-opencode-approval-policy", version: "1" },
          }]
        : []),
    ]);
  },

  injectEngramProtocol() {
    // La integración oficial de Engram aporta el protocolo en runtime; Stack no
    // duplica esa sección en AGENTS.md ni vuelve a desplegar el plugin legacy.
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

      if (agent.readonly || agent.bash !== "full" || !agent.spawn) lines.push("permission:");
      if (agent.readonly) lines.push("  edit: deny");
      if (agent.bash === "none") lines.push("  bash: deny");
      else if (agent.bash === "git-read") {
        lines.push('  bash:\n    "*": deny');
        for (const command of gitReadCommands) {
          lines.push(`    ${yamlString(command)}: allow`, `    ${yamlString(`${command} *`)}: allow`);
        }
        const permission = objectValue(loadCanonicalDefaults(stackRoot())["opencode"]?.permission);
        const bash = objectValue(permission?.bash);
        if (bash === null) throw new Error("OpenCode: canonical Bash policy is required for git-read agents.");
        for (const [pattern, decision] of Object.entries(bash)) {
          if (decision === "deny") lines.push(`    ${yamlString(pattern)}: deny`);
        }
      }
      if (!agent.spawn) lines.push("  task: deny");
    }

    // En OpenCode el primary ES nativo: aparece en el ciclo de Tab junto a
    // build/plan y es el agente que el usuario pilota directamente.
    return [
      {
        file: `${agent.name}.md`,
        content: `---\n${lines.join("\n")}\n---\n${agent.body}${agent.bash === "git-read" ? `\n\nUse only these read-only Git command prefixes; put refs and paths after --end-of-options:\n${gitReadCommands.map((command) => `- \`${command}\``).join("\n")}\n` : ""}`,
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
    const original = readMcpConfig(file);
    const contentSource = original === null || original.trim() === "" ? null : original;
    const isFreshConfig = contentSource === null;

    const mcpOwnership: McpOwnershipChange[] = [];
    const primaryModelOwnership: PrimaryModelOwnershipChange[] = [];
    const content = upsertJson(contentSource, (root) => {
      const rawMcp = root["mcp"];
      if (rawMcp !== undefined && objectValue(rawMcp) === null) {
        throw new Error("OpenCode: la clave 'mcp' debe ser un objeto; corrígela antes de reintentar sync.");
      }
      const existingMcp = rawMcp as Record<string, unknown> | undefined;
      const context7 = canonical.servers.context7;
      if (context7 !== undefined) assertCompatibleContext7(context7, existingMcp?.["context7"]);

      root["$schema"] ??= "https://opencode.ai/config.json";
      if (root[PRIMARY_MODEL_FIELD] === undefined) {
        root[PRIMARY_MODEL_FIELD] = PRIMARY_MODEL;
        if (ctx.ownedPrimaryModelFields?.has(PRIMARY_MODEL_FIELD) !== true) {
          primaryModelOwnership.push({ field: PRIMARY_MODEL_FIELD, owned: true });
        }
      } else if (typeof root[PRIMARY_MODEL_FIELD] !== "string" || root[PRIMARY_MODEL_FIELD].trim() === "") {
        throw new Error("OpenCode: 'model' debe ser un identificador provider/model no vacío; corrígelo antes de reintentar sync.");
      }

      const provider = ensureOwnedPrimaryObject(root, "provider", PRIMARY_PROVIDER_FIELD, ctx.ownedPrimaryModelFields, primaryModelOwnership);
      const openai = ensureOwnedPrimaryObject(provider, "openai", PRIMARY_OPENAI_FIELD, ctx.ownedPrimaryModelFields, primaryModelOwnership);
      const models = ensureOwnedPrimaryObject(openai, "models", PRIMARY_MODELS_FIELD, ctx.ownedPrimaryModelFields, primaryModelOwnership);
      const sol = ensureOwnedPrimaryObject(models, PRIMARY_MODEL_ID, PRIMARY_SOL_FIELD, ctx.ownedPrimaryModelFields, primaryModelOwnership);
      const limit = ensureOwnedPrimaryObject(sol, "limit", PRIMARY_LIMIT_PREFIX, ctx.ownedPrimaryModelFields, primaryModelOwnership);
      for (const [key, value] of Object.entries(PRIMARY_LIMITS)) {
        if (limit[key] !== undefined) continue;
        limit[key] = value;
        const field = `${PRIMARY_LIMIT_PREFIX}.${key}`;
        if (ctx.ownedPrimaryModelFields?.has(field) !== true) {
          primaryModelOwnership.push({ field, owned: true });
        }
      }

      // Permisos por defecto: se siembran en config fresca o vacía. Una
      // config existente se preserva byte a byte y solo avisa cuando el
      // bloque difiere del default; con --upgrade-permissions se reemplaza
      // el bloque entero (el pipeline hace backup antes de escribir).
      const defaults = loadCanonicalDefaults(ctx.stackDir)["opencode"];
      const canonicalPermission = defaults?.["permission"];
      if (isFreshConfig) {
        if (canonicalPermission !== undefined) {
          root["permission"] = canonicalPermission;
          ctx.warnings.push(
            "OpenCode: fresh config allows ordinary reads, edits, web access and Bash; sensitive operations ask, while protected paths and obvious destruction are denied. Native matching is not a universal filesystem sandbox.",
          );
        }
      } else if (canonicalPermission !== undefined && !isDeepStrictEqual(root["permission"], canonicalPermission)) {
        if (ctx.upgradePermissions === true) {
          root["permission"] = canonicalPermission;
        } else {
          ctx.warnings.push(
            "OpenCode: permission block differs from the stack default and was left untouched; re-run with --upgrade-permissions to replace it (a backup is created first), or edit it by hand. Overwriting discards your own permission changes, including any extra hardenings.",
          );
        }
      }

      const mcp = (root["mcp"] ??= {}) as Record<string, Record<string, unknown>>;
      const officialPluginPresent = hasOfficialEngramPlugin(ctx.configDir);
      for (const [name, server] of Object.entries(canonical.servers)) {
        const existing = mcp[name];
        const owned = ctx.ownedMcpServers?.has(name) === true;
        // Oficial preservado: con plugin oficial (`engram setup opencode`) el
        // MCP es oficial, no legacy del Stack. No se reclama ownership ni se
        // reescribe; el setup oficial es la única fuente. Usa el desinstalador
        // oficial para lo oficial.
        if (name === "engram" && officialPluginPresent) {
          if (owned) mcpOwnership.push({ server: name, owned: false });
          ctx.warnings.push(
            "OpenCode: Engram ya está integrado vía plugin oficial — no se registra el MCP para no duplicar ni reclamar ownership.",
          );
          continue;
        }
        if (name === "context7" && existing !== undefined) {
          // Context7 es requerido, pero una entrada previa compatible puede
          // pertenecer al usuario. Si el Stack la creó y el usuario la cambió,
          // se conserva y se libera ownership para no tocarla en uninstall.
          if (owned && !isCanonicalContext7Server(server, existing)) {
            mcpOwnership.push({ server: name, owned: false });
          }
          continue;
        }
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
          if (name === "context7" && existing === undefined && !owned) {
            mcpOwnership.push({ server: name, owned: true });
          }
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
          // Si el usuario usa otra integración de Engram (paquete npm), un
          // plugin legacy local podría duplicar el protocolo y los eventos.
          if (kept.some((u) => /engram/i.test(u))) {
            ctx.warnings.push(
              "OpenCode: hay un plugin de Engram registrado como paquete — revisa que no conviva con el engram.ts del stack (duplicaría la integración).",
            );
          }
        }
      }
    });

    return [{
      kind: "write",
      target: file,
      content,
      ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
      ...(primaryModelOwnership.length > 0 ? { primaryModelOwnership } : {}),
    }];
  },

  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile, pluginsDir } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      const content = removeSystemPromptSections(prompt);
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const configFile = path.join(ctx.configDir, "opencode.json");
    const config = readMcpConfig(configFile);
    if (config !== null) {
      const mcpOwnership: McpOwnershipChange[] = [];
      const primaryModelOwnership: PrimaryModelOwnershipChange[] = [];
      const content = upsertJson(config, (root) => {
        if (ctx.ownedPrimaryModelFields?.has(PRIMARY_MODEL_FIELD) === true) {
          if (root[PRIMARY_MODEL_FIELD] === PRIMARY_MODEL) delete root[PRIMARY_MODEL_FIELD];
          primaryModelOwnership.push({ field: PRIMARY_MODEL_FIELD, owned: false });
        }

        const provider = objectValue(root["provider"]);
        const openai = provider === null ? null : objectValue(provider["openai"]);
        const models = openai === null ? null : objectValue(openai["models"]);
        const sol = models === null ? null : objectValue(models[PRIMARY_MODEL_ID]);
        const limit = sol === null ? null : objectValue(sol["limit"]);
        if (limit !== null) {
          for (const [key, value] of Object.entries(PRIMARY_LIMITS)) {
            const field = `${PRIMARY_LIMIT_PREFIX}.${key}`;
            if (ctx.ownedPrimaryModelFields?.has(field) !== true) continue;
            if (limit[key] === value) delete limit[key];
          }
        }
        if (sol !== null && ctx.ownedPrimaryModelFields?.has(PRIMARY_LIMIT_PREFIX) === true) pruneEmpty(sol, "limit");
        if (models !== null && ctx.ownedPrimaryModelFields?.has(PRIMARY_SOL_FIELD) === true) pruneEmpty(models, PRIMARY_MODEL_ID);
        if (openai !== null && ctx.ownedPrimaryModelFields?.has(PRIMARY_MODELS_FIELD) === true) pruneEmpty(openai, "models");
        if (provider !== null && ctx.ownedPrimaryModelFields?.has(PRIMARY_OPENAI_FIELD) === true) pruneEmpty(provider, "openai");
        if (ctx.ownedPrimaryModelFields?.has(PRIMARY_PROVIDER_FIELD) === true) pruneEmpty(root, "provider");
        const managedFields = [
          PRIMARY_PROVIDER_FIELD,
          PRIMARY_OPENAI_FIELD,
          PRIMARY_MODELS_FIELD,
          PRIMARY_SOL_FIELD,
          PRIMARY_LIMIT_PREFIX,
          ...Object.keys(PRIMARY_LIMITS).map((key) => `${PRIMARY_LIMIT_PREFIX}.${key}`),
        ];
        for (const field of managedFields) {
          if (ctx.ownedPrimaryModelFields?.has(field) === true) primaryModelOwnership.push({ field, owned: false });
        }

        const rawMcpBlock = root["mcp"];
        if (rawMcpBlock !== undefined && objectValue(rawMcpBlock) === null) {
          throw new Error("OpenCode: la clave 'mcp' debe ser un objeto; corrígela antes de reintentar uninstall.");
        }
        const mcpBlock = rawMcpBlock as Record<string, unknown> | undefined;
        if (mcpBlock !== undefined) {
          const officialPluginPresent = hasOfficialEngramPlugin(ctx.configDir);
          for (const [name, server] of Object.entries(mcp.servers)) {
            // Oficial preservado: con plugin oficial el MCP es oficial
            // (`engram setup opencode`), no legacy del Stack. Uninstall lo
            // conserva incluso con --remove-engram; ese flag solo retira
            // legacy aún propio. Usa el desinstalador oficial para lo oficial.
            if (name === "engram" && officialPluginPresent) {
              ctx.warnings.push(
                "OpenCode: MCP 'engram' oficial (plugin) se conserva; usa el desinstalador oficial de Engram para retirarlo.",
              );
              continue;
            }
            if (name === "context7") {
              const canonical = isCanonicalContext7Server(server, mcpBlock[name]);
              const owned = ctx.ownedMcpServers?.has(name) === true;
              if (owned) {
                if (canonical) delete mcpBlock[name];
                mcpOwnership.push({ server: name, owned: false });
              }
              continue;
            }
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
          // los archivos — el plugin oficial o legacy se conserva en disco;
          // el manifest determina qué ownership puede retirarse.
          const pluginsDirPrefix = pathToFileURL(pluginsDir).href + "/";
          const kept = plugin.filter((url) => !url.startsWith(pluginsDirPrefix));
          if (kept.length === 0) delete root["plugin"];
          else root["plugin"] = kept;
        }
      });
      actions.push({
        kind: "write",
        target: configFile,
        content,
        ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
        ...(primaryModelOwnership.length > 0 ? { primaryModelOwnership } : {}),
      });
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

/**
 * Transferencia de ownership OpenCode al plugin oficial.
 *
 * `engram setup opencode` reemplaza el contenido en la MISMA ruta
 * `plugins/engram.ts` (no es un archivo nuevo) + registra MCP exacto y
 * statusline. La transferencia verifica esas tres capas en filesystem real y
 * retira solo ownership/manifest Stack: deja el archivo oficial intacto,
 * conserva `hooks.ts`/`worktree.ts` y plugins ajenos, preserva JSONC/config
 * ajena y evita recreación en sync/uninstall. Ambiguity/custom bloquea y
 * conserva el custom. OpenCode 2 fuera de scope (sin claims ni adapter v2).
 *
 * Sin booleanos declarativos: todo se deriva de paths/manifest reales.
 */

const OPENCODE_STACK_KEPT_PLUGINS = ["hooks.ts", "worktree.ts"] as const;

/**
 * Único predicado oficial OpenCode (real, sin stubs de test).
 * Marcadores únicos del setup oficial en la misma ruta.
 * Compartido por adapter/doctor/uninstall para no duplicar ni aceptar
 * el marcador de test `engram official plugin`.
 */
export function isOfficialOpencodePluginContent(content: string): boolean {
  return (
    content.includes("ensureLocalReady") ||
    content.includes("CONFIGURED_ENGRAM_URL") ||
    content.includes("SESSION_ATTRIBUTED_WRITE_TOOLS") ||
    content.includes("canonicalEngramToolName") ||
    content.includes("localInstanceID")
  );
}

/** Legacy Stack: placeholders del canon o helpers propios tras install. */
function isStackLegacyOpencodePluginContent(content: string): boolean {
  if (content.includes("{{ENGRAM_BIN}}") || content.includes("{{ENGRAM_PROTOCOL}}")) return true;
  try {
    const canon = fs.readFileSync(
      path.join(stackRoot(), "plugins", "opencode", "engram.ts"),
      "utf8",
    );
    if (content === canon) return true;
  } catch {
    // Canon retirado tras la transferencia: cae a marcadores.
  }
  return (
    content.includes("resolveEngramBin") ||
    content.includes("stripPrivateTags") ||
    content.includes("declare const Bun")
  );
}

function readOpencodePluginFile(configDir: string): string | null {
  return readTextIfExists(path.join(configDir, "plugins", "engram.ts"));
}

function hasOfficialEngramPlugin(configDir: string): boolean {
  const content = readOpencodePluginFile(configDir);
  return content !== null && isOfficialOpencodePluginContent(content);
}

function readExistingOpencodeConfigs(configDir: string): Array<{ file: string; raw: string }> {
  const out: Array<{ file: string; raw: string }> = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const raw = readTextIfExists(path.join(configDir, name));
    if (raw !== null) out.push({ file: path.join(configDir, name), raw });
  }
  return out;
}

function readExistingTuiConfigs(configDir: string): Array<{ file: string; raw: string }> {
  const out: Array<{ file: string; raw: string }> = [];
  for (const name of ["tui.json", "tui.jsonc"]) {
    const raw = readTextIfExists(path.join(configDir, name));
    if (raw !== null) out.push({ file: path.join(configDir, name), raw });
  }
  return out;
}

function isExactOpencodeEngramMcpValue(value: unknown, engramBin?: string): boolean {
  const record = objectValue(value);
  if (record === null) return false;
  if (record["type"] !== "local") return false;
  const command = record["command"];
  if (!Array.isArray(command) || command.length !== 3) return false;
  if (command[1] !== "mcp" || command[2] !== "--tools=agent") return false;
  if (typeof command[0] !== "string") return false;
  if (engramBin !== undefined && engramBin !== "") return command[0] === engramBin;
  return (command[0] as string).includes("engram");
}

/**
 * MCP exacto en opencode.json/jsonc.
 * Solo JSON estructural válido acredita; JSON truncado/malformado o
 * fragmentos sueltos en JSONC ilegible fallan cerrados (sin regex).
 */
export function checkOpencodeOfficialMcp(configDir: string, engramBin?: string): boolean {
  for (const { raw } of readExistingOpencodeConfigs(configDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const root = objectValue(parsed);
    const mcp = root !== null ? objectValue(root["mcp"]) : null;
    if (mcp !== null && isExactOpencodeEngramMcpValue(mcp["engram"], engramBin)) return true;
  }
  return false;
}

/**
 * Statusline oficial: `statusline.command` con engram en opencode.json/jsonc
 * o plugin `opencode-subagent-statusline` en tui.json/jsonc.
 * Solo JSON estructural válido acredita; JSONC ilegible falla cerrado.
 */
export function checkOpencodeOfficialStatusline(configDir: string): boolean {
  for (const { raw } of readExistingOpencodeConfigs(configDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const root = objectValue(parsed);
    const statusline = root !== null ? objectValue(root["statusline"]) : null;
    if (statusline !== null) {
      const command = statusline["command"];
      if (typeof command === "string" && command.includes("engram")) return true;
    }
  }
  for (const { raw } of readExistingTuiConfigs(configDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const root = objectValue(parsed);
    const plugin = root !== null ? root["plugin"] : undefined;
    if (Array.isArray(plugin) && plugin.some((entry) => typeof entry === "string" && /statusline/i.test(entry))) {
      return true;
    }
  }
  return false;
}

export function checkOpencodeDuplicates(configDir: string): boolean {
  for (const { raw } of readExistingOpencodeConfigs(configDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // JSONC ilegible: no se afirma duplicado sin evidencia parseable.
      continue;
    }
    const root = objectValue(parsed);
    const plugin = root !== null ? root["plugin"] : undefined;
    if (Array.isArray(plugin) && plugin.some((entry) => typeof entry === "string" && /engram/i.test(entry))) {
      return true;
    }
  }
  return false;
}

/**
 * Verificador oficial OpenCode por capas (solo lectura, registrado en T12).
 * Capas: plugin (misma ruta, contenido oficial vs legacy canónico),
 * MCP exacto y statusline. Preserva JSONC/config ajena; sin claim OpenCode2.
 */
export async function verifyOfficialSetup(args: { configDir: string; engramBin: string }): Promise<{
  ok: boolean;
  layers: string[];
  duplicates: boolean;
  reason?: string;
}> {
  const plugin = readOpencodePluginFile(args.configDir);
  const hasPlugin = plugin !== null && isOfficialOpencodePluginContent(plugin);
  const hasMcp = checkOpencodeOfficialMcp(args.configDir, args.engramBin);
  const hasStatusline = checkOpencodeOfficialStatusline(args.configDir);
  const duplicates = checkOpencodeDuplicates(args.configDir);
  const passed: string[] = [];
  const missing: string[] = [];
  if (hasPlugin) passed.push("plugin");
  else missing.push(plugin === null ? "plugin:missing" : "plugin:legacy-or-foreign");
  if (hasMcp) passed.push("mcp");
  else missing.push("mcp:missing");
  if (hasStatusline) passed.push("statusline");
  else missing.push("statusline:missing");
  if (duplicates) missing.push("duplicates:detected");
  if (missing.length === 0) {
    return { ok: true, layers: passed, duplicates: false };
  }
  const reason = duplicates
    ? `OpenCode: setup oficial Engram con plugin Engram duplicado; se conserva sin reclamar.`
    : `OpenCode: setup oficial Engram incompleto (falta: ${missing.join(", ")}).`;
  return {
    ok: false,
    layers: [...passed, ...missing],
    duplicates,
    reason,
  };
}

registerOfficialSetupVerifier("opencode", verifyOfficialSetup);

/**
 * Decide en filesystem real si el legacy puede retirarse. Solo `true` con
 * reemplazo oficial verificado (plugin + MCP + statusline); cualquier
 * ambiguity/foreign/custom bloquea y conserva el archivo en la misma ruta.
 */
export async function shouldRetireLegacyEngram(args: { configDir: string }): Promise<{
  retire: boolean;
  reason: string;
}> {
  const plugin = readOpencodePluginFile(args.configDir);
  if (plugin === null) {
    return { retire: false, reason: "ambiguous: plugins/engram.ts ausente, sin reemplazo oficial verificable" };
  }
  if (isOfficialOpencodePluginContent(plugin)) {
    const hasMcp = checkOpencodeOfficialMcp(args.configDir);
    const hasStatusline = checkOpencodeOfficialStatusline(args.configDir);
    if (hasMcp && hasStatusline) {
      return { retire: true, reason: "official verified: plugin + MCP + statusline en filesystem" };
    }
    return {
      retire: false,
      reason: `ambiguous: plugin oficial sin MCP/statusline verificables (mcp=${hasMcp}, statusline=${hasStatusline})`,
    };
  }
  if (isStackLegacyOpencodePluginContent(plugin)) {
    return { retire: false, reason: "legacy Stack sin reemplazo oficial: setup pendiente, se conserva" };
  }
  return { retire: false, reason: "ambiguous: custom/foreign content en plugins/engram.ts, se conserva" };
}

/**
 * Transfiere ownership al oficial: verifica en filesystem, deja el archivo
 * oficial intacto (nunca lo borra ni reescribe), conserva hooks.ts/worktree.ts
 * y config ajena, y devuelve las señales para inventario/uninstall:
 * `recreateOnSync: false` (sync no recrea custom) y
 * `preserveOfficialOnUninstall: true` (uninstall conserva official incluso con
 * --remove-engram; solo legacy aún propio puede retirarse).
 */
export async function transferEngramOwnership(args: { configDir: string }): Promise<{
  ownershipRetired: boolean;
  retired: boolean;
  kept: string[];
  recreateOnSync: boolean;
  preserveOfficialOnUninstall: boolean;
  layers: string[];
  reason?: string;
}> {
  const pluginPath = path.join(args.configDir, "plugins", "engram.ts");
  const plugin = readTextIfExists(pluginPath);
  const kept = [...OPENCODE_STACK_KEPT_PLUGINS];
  if (plugin === null || !isOfficialOpencodePluginContent(plugin)) {
    const detail = plugin === null
      ? "plugins/engram.ts ausente"
      : isStackLegacyOpencodePluginContent(plugin)
        ? "legacy Stack sin reemplazo oficial"
        : "custom/foreign content";
    return {
      ownershipRetired: false,
      retired: false,
      kept,
      recreateOnSync: false,
      preserveOfficialOnUninstall: true,
      layers: [],
      reason: `OpenCode: transferencia bloqueada (${detail}); se conserva el archivo.`,
    };
  }
  const hasMcp = checkOpencodeOfficialMcp(args.configDir);
  const hasStatusline = checkOpencodeOfficialStatusline(args.configDir);
  const layers = ["plugin", ...(hasMcp ? ["mcp"] : ["mcp:missing"]), ...(hasStatusline ? ["statusline"] : ["statusline:missing"])];
  if (!hasMcp || !hasStatusline) {
    return {
      ownershipRetired: false,
      retired: false,
      kept,
      recreateOnSync: false,
      preserveOfficialOnUninstall: true,
      layers,
      reason: `OpenCode: transferencia bloqueada (plugin oficial sin MCP/statusline verificables); se conserva el archivo oficial.`,
    };
  }
  // Archivo oficial intacto: sin rm ni rewrite. hooks/worktree se conservan
  // en disco (Stack-owned restantes); la config ajena queda intacta porque no
  // se escribe nada aquí — el inventario (plan sin engram.ts) retira el
  // ownership Stack en el próximo install.
  return {
    ownershipRetired: true,
    retired: true,
    kept,
    recreateOnSync: false,
    preserveOfficialOnUninstall: true,
    layers: ["plugin", "mcp", "statusline"],
  };
};
