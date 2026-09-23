import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange } from "./types.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectClaudeCode } from "../lib/detect.js";
import { readTextIfExists } from "../lib/fsx.js";
import { upsertJson } from "../lib/filemerge.js";
import { removeNativeHooks, upsertNativeHooks } from "../lib/hooks-format.js";
import { createLocalCapabilityReport, hasManagedMarkdownSection } from "../lib/quality-capabilities.js";
import { stackRoot } from "../lib/paths.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    throw new Error(`Claude Code: no se pudo leer la configuración MCP en ${file} (${code}).`);
  }
  if (content.trim() !== "") {
    try {
      if (!isRecord(JSON.parse(content))) throw new Error();
    } catch {
      throw new Error(`Claude Code: la configuración MCP en ${file} debe contener un objeto JSON válido.`);
    }
  }
  return content;
}

function isCompatibleContext7Server(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  if (server.transport !== "http" || typeof server.url !== "string" || !isRecord(value)) return false;
  return value.type === "http" && value.url === server.url;
}

function canonicalContext7Server(server: CanonicalMcp["servers"][string]): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(server.headers ?? {})) {
    headers[key] = /^\$\{(\w+)\}$/.test(raw) ? "" : raw;
  }
  return {
    type: "http",
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function isCanonicalContext7Server(server: CanonicalMcp["servers"][string], value: unknown): boolean {
  return isCompatibleContext7Server(server, value) && isDeepStrictEqual(value, canonicalContext7Server(server));
}

function assertCompatibleContext7(server: CanonicalMcp["servers"][string], value: unknown): void {
  if (value !== undefined && !isCompatibleContext7Server(server, value)) {
    throw new Error("Claude Code: MCP 'context7' entra en conflicto con una definición existente (endpoint o tipo incompatible). Conserva la configuración y corrige el conflicto antes de reintentar.");
  }
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
  // Provider-only: el agente engram omite `tools` y hereda todo del provider
  // oficial — una allowlist Stack filtraría sus tools oficiales.
  if (agent.name === "engram") return null;
  if (!agent.readonly) return null;
  // Skill SIEMPRE: todos los subagentes cargan agent-delegation como primera
  // acción obligatoria — sin la tool en la allowlist no podrían.
  const tools = ["Read", "Grep", "Glob", "Skill"];
  if (agent.bash !== "none") tools.push("Bash");
  return tools.join(", ");
}

/** Engram integrado por el plugin oficial de marketplace; sus hooks y skill de memoria no sustituyen al MCP user separado que registra el setup oficial y que Stack no posee ni muta. */
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

    // Sin bloqueos por-subagente: el git destructivo (reset/clean/checkout con
    // descarte/restore/push --force) cae en el `ask` global de `Bash` y pide
    // aprobación explícita — decisión #153 (2026-09-17): ask con vía de escape,
    // no bloqueo. El primary hereda el global sin más.

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

    // Permisos por defecto: se siembran en config fresca o vacía (vía este
    // hooks-path en settings.json, nunca vía main-config). Una config
    // existente se preserva byte a byte y solo avisa cuando el bloque
    // difiere del default; con --upgrade-permissions se reemplaza el bloque
    // entero (el pipeline hace backup antes de escribir).
    const defaults = loadCanonicalDefaults(ctx.stackDir)["claude-code"];
    const canonicalPermissions = defaults?.["permissions"];
    if (contentSource === null) {
      if (canonicalPermissions !== undefined) {
        content = upsertJson(content, (root) => {
          if (root["permissions"] === undefined) {
            root["permissions"] = canonicalPermissions;
            ctx.warnings.push(
              "Claude Code: fresh config enables read-anywhere via Read/Grep/Glob allow rules; shell, writes and web egress remain approval-gated, but broad local reads can expose secrets not covered by deny rules.",
            );
          }
        });
      }
    } else if (canonicalPermissions !== undefined) {
      content = upsertJson(content, (root) => {
        if (isDeepStrictEqual(root["permissions"], canonicalPermissions)) return;
        if (ctx.upgradePermissions === true) {
          root["permissions"] = canonicalPermissions;
        } else {
          ctx.warnings.push(
            "Claude Code: permissions block differs from the stack default and was left untouched; re-run with --upgrade-permissions to replace it (a backup is created first), or edit it by hand. Overwriting discards your own permission changes, including any extra hardenings.",
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
    const content = upsertJson(readMcpConfig(file), (root) => {
      const rawServers = root["mcpServers"];
      if (rawServers !== undefined && !isRecord(rawServers)) {
        throw new Error("Claude Code: la clave 'mcpServers' debe ser un objeto; corrígela antes de reintentar sync.");
      }
      const existingServers = rawServers as Record<string, unknown> | undefined;
      const context7 = canonical.servers.context7;
      if (context7 !== undefined) assertCompatibleContext7(context7, existingServers?.["context7"]);

      const servers = (root["mcpServers"] ??= {}) as Record<string, Record<string, unknown>>;
      for (const [name, server] of Object.entries(canonical.servers)) {
        // Plugin oficial activo: sus hooks y skill no incluyen este MCP; el
        // setup (`engram setup claude-code`) registra un MCP user separado.
        // Preservar cualquier `engram` existente (oficial o ajeno), liberar
        // ownership previo del Stack si lo tiene y no recrearlo si falta.
        if (name === "engram" && hasEngramPlugin(ctx.configDir)) {
          if (ctx.ownedMcpServers?.has(name) === true) {
            mcpOwnership.push({ server: name, owned: false });
          }
          ctx.warnings.push(
            "Claude Code: plugin oficial de Engram activo — sus hooks y skill no incluyen el MCP; el setup registra un MCP user separado que Stack no posee ni muta.",
          );
          continue;
        }
        const existing = servers[name];
        const owned = ctx.ownedMcpServers?.has(name) === true;
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
          if (name === "context7" && existing === undefined && !owned) {
            mcpOwnership.push({ server: name, owned: true });
          }
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
      const content = removeSystemPromptSections(prompt);
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
    const main = readMcpConfig(mainFile);
    if (main !== null) {
      const mcpOwnership: McpOwnershipChange[] = [];
      const content = upsertJson(main, (root) => {
        const rawServers = root["mcpServers"];
        if (rawServers === undefined) return;
        if (!isRecord(rawServers)) {
          throw new Error("Claude Code: la clave 'mcpServers' debe ser un objeto; corrígela antes de reintentar uninstall.");
        }
        const servers = rawServers;
        for (const [name, server] of Object.entries(mcp.servers)) {
          if (name === "context7") {
            const canonical = isCanonicalContext7Server(server, servers[name]);
            const owned = ctx.ownedMcpServers?.has(name) === true;
            if (owned) {
              if (canonical) delete servers[name];
              mcpOwnership.push({ server: name, owned: false });
            }
            continue;
          }
          // Oficial preservado: con plugin Engram presente el MCP es oficial
          // (setup `engram setup claude-code`), no legacy del Stack. Uninstall
          // lo conserva incluso con --remove-engram; ese flag solo retira
          // legacy aún propio. Usa el desinstalador oficial para lo oficial.
          if (name === "engram" && hasEngramPlugin(ctx.configDir)) {
            ctx.warnings.push(
              "Claude Code: MCP 'engram' oficial (plugin) se conserva; usa el desinstalador oficial de Engram para retirarlo.",
            );
            continue;
          }
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

/**
 * Verificador oficial Claude Code por capas bajo Engram 2.0.0 (solo lectura).
 *
 * Lee filesystem/config real, sin booleanos declarativos:
 * - plugin: registry v2 `plugins/installed_plugins.json` con
 *   `plugins["engram@engram"][0]` de alcance user + installPath absoluto bajo
 *   `configDir/plugins/cache/engram` (rechaza ausente/foráneo/symlink en la
 *   ruta final o en cualquier ancestro existente, y escapes físicos; nunca
 *   sigue enlaces) y `settings.json enabledPlugins["engram@engram"]===true`.
 * - mcp: entrada exacta SOLO en la ubicación del modo efectivo (diagnóstico
 *   comprobado en Claude 2.1.267): predeterminado (`configDir == <home>/.claude`) →
 *   archivo hermano `<home>/.claude.json`; explícito (CLAUDE_CONFIG_DIR definida) →
 *   anidado `configDir/.claude.json`. La ubicación opuesta se rechaza. Tipo stdio,
 *   command == engramBin, args == ["mcp","--tools=agent"].
 * - hooks: `hooks/hooks.json` oficial bajo installPath con objeto `hooks`
 *   no vacío + al menos un script en `scripts/` bajo el mismo installPath.
 *   El origen del marketplace y los hooks JorgeX de settings.json se
 *   preservan, pero NO acreditan esta capa. El obsoleto `mcp/engram.json`
 *   nunca es evidencia MCP (solo reversión/solución).
 *
 * No escribe, no reemplaza binarios ni reclama nada; la config ajena intacta.
 */
function errnoCodeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code as string
    : "UNKNOWN";
}

function resolveStrictInstallPath(configDir: string): { ok: boolean; installPath?: string; detail?: string } {
  const registryFile = path.join(configDir, "plugins", "installed_plugins.json");
  let raw: string;
  try {
    raw = fs.readFileSync(registryFile, "utf8");
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === "ENOENT") {
      return { ok: false, detail: `installPath:missing (registry ausente: ${registryFile})` };
    }
    return { ok: false, detail: `installPath:unreadable (${registryFile}: ${code}, ilegible)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, detail: `installPath:malformed (${registryFile}: JSON inválido, ilegible)` };
  }
  if (!isRecord(parsed) || (parsed["version"] as unknown) !== 2) {
    return { ok: false, detail: `installPath:malformed (${registryFile}: registry version 2 requerida, inválido)` };
  }
  const plugins = (parsed as Record<string, unknown>)["plugins"];
  if (!isRecord(plugins)) return { ok: false, detail: `plugin:malformed (plugins no es objeto en ${registryFile})` };
  const entry = (plugins as Record<string, unknown>)["engram@engram"];
  if (!Array.isArray(entry) || entry.length === 0 || !isRecord(entry[0])) {
    return { ok: false, detail: `plugin:missing (engram@engram ausente en ${registryFile})` };
  }
  const first = entry[0] as Record<string, unknown>;
  if (first["scope"] !== "user") return { ok: false, detail: `plugin:disabled (scope user requerido en ${registryFile})` };
  const installPath = first["installPath"];
  if (typeof installPath !== "string" || installPath === "" || !path.isAbsolute(installPath)) {
    return { ok: false, detail: `installPath:missing (absoluto requerido en ${registryFile})` };
  }
  const expectedRoot = path.resolve(path.join(configDir, "plugins", "cache", "engram"));
  const resolved = path.resolve(installPath);
  if (resolved !== expectedRoot && !resolved.startsWith(expectedRoot + path.sep)) {
    return { ok: false, detail: `installPath:foreign (${resolved} fuera de ${expectedRoot})` };
  }
  // Alias en la ruta final o en cualquier ancestro existente entre configDir
  // (exclusivo, frontera como el homeDir del núcleo) e installPath (lstat por
  // componente, sin seguir enlaces): un ancestro symlinked (p.ej.
  // plugins/cache -> /tmp/outside) escapa físicamente del árbol de caché
  // aunque el path esté léxicamente contenido.
  const configResolved = path.resolve(configDir);
  let cursor: string | null = resolved;
  while (cursor !== null && cursor !== configResolved) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        return { ok: false, detail: `installPath:symlink rechazado (${cursor} es un alias; no se sigue)` };
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : "UNKNOWN";
      if (code !== "ENOENT") {
        return { ok: false, detail: `installPath:ilegible (${cursor}: ${code}, no se puede descartar alias)` };
      }
      // Intermedio ausente: no puede ser un alias existente; seguir
      // ascendiendo para revisar los ancestros que sí existan.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent === configResolved || parent.startsWith(configResolved + path.sep) ? parent : null;
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, detail: "installPath: no es un directorio" };
    }
  } catch {
    return { ok: false, detail: "installPath:missing (no existe)" };
  }
  return { ok: true, installPath: resolved };
}

function checkStrictEnabled(configDir: string): { ok: boolean; detail?: string } {
  const settingsFile = path.join(configDir, "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(settingsFile, "utf8");
  } catch (error) {
    const code = errnoCodeOf(error);
    if (code === "ENOENT") {
      return { ok: false, detail: `plugin:missing (settings ausente: ${settingsFile})` };
    }
    return { ok: false, detail: `plugin:unreadable (${settingsFile}: ${code}, ilegible)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, detail: `plugin:malformed (${settingsFile}: JSON inválido, ilegible)` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: `plugin:malformed (${settingsFile}: objeto JSON requerido, inválido)` };
  }
  const enabled = (parsed as Record<string, unknown>)["enabledPlugins"];
  if (enabled === undefined) {
    return { ok: false, detail: `plugin:disabled (enabledPlugins ausente en ${settingsFile})` };
  }
  if (!isRecord(enabled)) {
    return { ok: false, detail: `plugin:malformed (${settingsFile}: enabledPlugins no es objeto, inválido)` };
  }
  if ((enabled as Record<string, unknown>)["engram@engram"] === true) {
    return { ok: true };
  }
  return { ok: false, detail: `plugin:disabled (enabledPlugins en ${settingsFile})` };
}

function isExactClaudeEngramMcp(value: unknown, engramBin: string): boolean {
  if (!isRecord(value)) return false;
  return (
    value["type"] === "stdio" &&
    value["command"] === engramBin &&
    Array.isArray(value["args"]) &&
    (value["args"] as unknown[]).length === 2 &&
    (value["args"] as unknown[])[0] === "mcp" &&
    (value["args"] as unknown[])[1] === "--tools=agent"
  );
}

/**
 * El modo efectivo lo decide la presencia explícita de CLAUDE_CONFIG_DIR más
 * homeDir + configDir (diagnóstico comprobado en Claude 2.1.267):
 * explícito (env definida, aunque igual a `<home>/.claude`) → anidado
 * `configDir/.claude.json`; por defecto (env ausente + `configDir ==
 * <home>/.claude`) → hermano `<home>/.claude.json`.
 * Sin homeDir se infiere por el nombre base, igual que los backup targets.
 * El booleano explícito se propaga desde setup/doctor; cuando se omite se
 * consulta `process.env.CLAUDE_CONFIG_DIR` para conservar el comportamiento directo.
 */
function isExplicitClaudeMode(isExplicit?: boolean): boolean {
  if (isExplicit !== undefined) return isExplicit;
  return process.env.CLAUDE_CONFIG_DIR !== undefined;
}

function isDefaultClaudeConfigDir(configDir: string, homeDir?: string, isExplicit?: boolean): boolean {
  if (isExplicitClaudeMode(isExplicit)) return false;
  if (homeDir !== undefined) {
    return path.resolve(configDir) === path.resolve(path.join(homeDir, ".claude"));
  }
  return path.basename(path.resolve(configDir)) === ".claude";
}

/** Ubicación exacta del MCP según el modo efectivo; solo ella es evidencia. */
function claudeOfficialMcpFile(configDir: string, homeDir?: string, isExplicit?: boolean): string {
  if (isDefaultClaudeConfigDir(configDir, homeDir, isExplicit)) {
    const home = homeDir ?? path.dirname(path.resolve(configDir));
    return path.join(home, ".claude.json");
  }
  return path.join(configDir, ".claude.json");
}

function checkClaudeOfficialMcp(configDir: string, engramBin: string, homeDir?: string, isExplicit?: boolean): boolean {
  // Engram 2.0.0 escribe el MCP exacto SOLO en la ubicación del modo
  // efectivo. El layout opuesto-solo se rechaza; el obsoleto
  // mcp/engram.json nunca es evidencia.
  const file = claudeOfficialMcpFile(configDir, homeDir, isExplicit);
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) return false;
    const servers = parsed["mcpServers"];
    if (!isRecord(servers)) return false;
    if (isExactClaudeEngramMcp(servers["engram"], engramBin)) return true;
  } catch {
    return false;
  }
  return false;
}

function hasObsoleteClaudeMcp(configDir: string): boolean {
  try {
    return fs.statSync(path.join(configDir, "mcp", "engram.json"), { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

function checkClaudeOfficialHooksAt(installPath: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(installPath, "hooks", "hooks.json"), "utf8")) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const hooks = parsed["hooks"];
  if (!isRecord(hooks) || Object.keys(hooks).length === 0) return false;
  try {
    const entries = fs.readdirSync(path.join(installPath, "scripts"));
    if (!entries.some((entry) => entry.endsWith(".sh"))) return false;
  } catch {
    return false;
  }
  return true;
}

export async function verifyOfficialSetup(args: {
  configDir: string;
  engramBin: string;
  homeDir?: string;
  isExplicitClaudeConfigDir?: boolean;
}): Promise<{
  ok: boolean;
  layers: string[];
  duplicates: boolean;
  reason?: string;
}> {
  const explicit = isExplicitClaudeMode(args.isExplicitClaudeConfigDir);
  const resolved = resolveStrictInstallPath(args.configDir);
  const enabled = checkStrictEnabled(args.configDir);
  const hasPlugin = resolved.ok && enabled.ok;
  const pluginDetail = !resolved.ok
    ? (resolved.detail ?? "plugin:missing")
    : !enabled.ok
      ? (enabled.detail ?? "plugin:disabled (enabledPlugins)")
      : null;
  const hasMcp = typeof args.engramBin === "string" && args.engramBin !== ""
    ? checkClaudeOfficialMcp(args.configDir, args.engramBin, args.homeDir, explicit)
    : false;
  const hasHooks = resolved.ok && resolved.installPath !== undefined
    ? checkClaudeOfficialHooksAt(resolved.installPath)
    : false;
  const passed: string[] = [];
  const missing: string[] = [];
  if (hasPlugin) passed.push("plugin");
  else missing.push(pluginDetail ?? "plugin:missing");
  if (hasMcp) passed.push("mcp");
  else missing.push("mcp:missing");
  if (hasHooks) passed.push("hooks");
  else missing.push("hooks:missing");
  if (missing.length === 0) {
    return { ok: true, layers: passed, duplicates: false };
  }
  const obsolete = hasObsoleteClaudeMcp(args.configDir);
  if (obsolete && !hasMcp) {
    return {
      ok: false,
      layers: [...passed, ...missing],
      duplicates: false,
      reason: `Claude Code: incompatible existing setup (obsolete mcp/engram.json without valid MCP in ${claudeOfficialMcpFile(args.configDir, args.homeDir, explicit)}). Update to Engram 2.0.0+ and rerun install; never auto-replace existing binary. (falta: ${missing.join(", ")}).`,
    };
  }
  return {
    ok: false,
    layers: [...passed, ...missing],
    duplicates: false,
    reason: `Claude Code: setup oficial Engram incompleto (falta: ${missing.join(", ")}).`,
  };
}

registerOfficialSetupVerifier("claude-code", verifyOfficialSetup);
