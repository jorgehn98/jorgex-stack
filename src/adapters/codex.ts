import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange, ConfigOwnershipChange } from "./types.js";
import type { CanonicalAgent, CanonicalMcp } from "../lib/canonical.js";
import { agentModelChoice, type AgentModelChoices } from "../lib/agent-model.js";
import { detectCodex } from "../lib/detect.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import { HOME, samePath } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import {
  readTomlSection,
  hasTomlChildSection,
  headerName as tomlHeaderName,
  multilineStringMask,
  removeTomlSection,
  upsertTomlSection,
} from "../lib/filemerge.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";

/** String TOML de una línea (los escapes de JSON son válidos en basic strings). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function readMcpConfig(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    if (code === "ENOENT") return null;
    throw new Error(`Codex: no se pudo leer la configuración MCP en ${file} (${code}).`);
  }
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

function stdioMcpSection(server: CanonicalMcp["servers"][string]): string {
  const args = (server.args ?? []).map(tomlString).join(", ");
  return `command = ${tomlString(server.command!)}\nargs = [${args}]`;
}

function isManagedOptionalStdioServer(server: CanonicalMcp["servers"][string], section: string | null): boolean {
  return server.optional === true
    && server.transport === "stdio"
    && section?.trim() === stdioMcpSection(server);
}

/**
 * Plugin de marketplace engram ACTIVO: sus hooks y skill de memoria son la
 * integración del plugin; el setup oficial registra aparte un MCP user
 * (`engram setup codex`) que Stack no posee ni muta. Un plugin presente pero
 * `enabled = false` NO cuenta: en ese caso el MCP manual es la integración
 * real y debe conservarse.
 */
function hasActiveEngramPlugin(configDir: string): boolean {
  const config = readTextIfExists(path.join(configDir, "config.toml"));
  if (config === null) return false;
  const match = /\[plugins\."engram@[^"]*"\]([^[]*)/.exec(config);
  return match !== null && !/enabled\s*=\s*false/.test(match[1]!);
}

const CODEX_JSON_STRING = String.raw`"(?:\\.|[^"\\\r\n])*"`;
const CODEX_JSON_VALUE = String.raw`(?:${CODEX_JSON_STRING}|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|true|false)`;
const CODEX_JSON_STRING_ARRAY = String.raw`\[(?:\s*${CODEX_JSON_STRING}(?:\s*,\s*${CODEX_JSON_STRING})*\s*)?\]`;
const CODEX_KEY = String.raw`(?:[A-Za-z0-9_-]+|${CODEX_JSON_STRING})`;
const CODEX_ASSIGNMENT = new RegExp(String.raw`^\s*(${CODEX_KEY})\s*=\s*(${CODEX_JSON_STRING_ARRAY}|${CODEX_JSON_VALUE})\s*(?:#.*)?$`);

function tomlAssignment(section: string, key: string): { present: boolean; raw?: string } {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=`);
  const lines = section.split(/\r?\n/);
  const mask = multilineStringMask(lines);
  for (const [index, line] of lines.entries()) {
    if (mask[index] || !keyPattern.test(line)) continue;
    const match = CODEX_ASSIGNMENT.exec(line);
    if (match) return { present: true, raw: match[2] };
    const equals = line.indexOf("=");
    const raw = equals === -1 ? undefined : line.slice(equals + 1).trim().replace(/\s+#.*$/, "");
    return { present: true, ...(raw?.startsWith("'") && raw.endsWith("'") ? { raw } : {}) };
  }
  return { present: false };
}

function parseTomlString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return undefined;
}

function context7HttpSection(server: CanonicalMcp["servers"][string]): string {
  const body = [`url = ${tomlString(server.url!)}`];
  const envHeaders: string[] = [];
  const literalHeaders: string[] = [];
  for (const [key, raw] of Object.entries(server.headers ?? {})) {
    const envRef = /^\$\{(\w+)\}$/.exec(raw);
    if (envRef) envHeaders.push(`${tomlString(key)} = ${tomlString(envRef[1]!)}`);
    else literalHeaders.push(`${tomlString(key)} = ${tomlString(raw)}`);
  }
  if (literalHeaders.length > 0) body.push(`http_headers = { ${literalHeaders.join(", ")} }`);
  if (envHeaders.length > 0) body.push(`env_http_headers = { ${envHeaders.join(", ")} }`);
  return body.join("\n");
}

function isCompatibleContext7Server(server: CanonicalMcp["servers"][string], section: string | null): boolean {
  if (server.transport !== "http" || typeof server.url !== "string" || section === null) return false;
  const url = tomlAssignment(section, "url");
  const command = tomlAssignment(section, "command");
  const type = tomlAssignment(section, "type");
  const enabled = tomlAssignment(section, "enabled");
  const declaredType = type.present ? parseTomlString(type.raw) : "http";
  return url.present
    && parseTomlString(url.raw) === server.url
    && !command.present
    && declaredType === "http"
    && (!enabled.present || enabled.raw?.trim() === "true");
}

function isCanonicalContext7Server(server: CanonicalMcp["servers"][string], section: string | null, config: string | null): boolean {
  return isCompatibleContext7Server(server, section) && section!.trim() === context7HttpSection(server)
    && !hasTomlChildSection(config, "mcp_servers.context7");
}

function assertCompatibleContext7(server: CanonicalMcp["servers"][string], section: string | null, config: string | null): void {
  if ((section === null && hasTomlChildSection(config, "mcp_servers.context7"))
    || (section !== null && !isCompatibleContext7Server(server, section))) {
    throw new Error("Codex: MCP 'context7' entra en conflicto con una definición existente (endpoint, tipo o estado nativo incompatible). Conserva la configuración y corrige el conflicto antes de reintentar.");
  }
}

const CODEX_PERMISSION_HEADERS = {
  base: "permissions.jorgex-yolo",
  network: "permissions.jorgex-yolo.network",
  filesystem: "permissions.jorgex-yolo.filesystem",
  workspaceRoots: 'permissions.jorgex-yolo.filesystem.":workspace_roots"',
} as const;

/**
 * Single source for the profile emitted below and checked by the diagnostic.
 * Solo se deniegan DIRECTORIOS: con Codex 0.158 y bubblewrap, dos o más
 * archivos denegados existentes hacen fallar todos los comandos del sandbox, y
 * `":root" = "write"` no arranca. Ampliar a archivos exige volver a probarlo.
 * Desde Codex 0.160 un directorio denegado que NO existe también rompe todo el
 * sandbox (`bwrap: Destination is not a file`): ver `missingCodexDeniedDirs`.
 */
const CODEX_PERMISSION_PROFILE = {
  base: [["extends", ":workspace"]],
  network: [["enabled", true]],
  filesystem: [
    [":root", "read"],
    ["~", "write"],
    ["~/.ssh", "deny"],
    ["~/.aws", "deny"],
  ],
  workspaceRoots: [[".", "write"]],
} as const;

const CODEX_PERMISSION_SECTIONS = [
  { header: CODEX_PERMISSION_HEADERS.base, entries: CODEX_PERMISSION_PROFILE.base, quoteKeys: false },
  { header: CODEX_PERMISSION_HEADERS.network, entries: CODEX_PERMISSION_PROFILE.network, quoteKeys: false },
  { header: CODEX_PERMISSION_HEADERS.filesystem, entries: CODEX_PERMISSION_PROFILE.filesystem, quoteKeys: true },
  { header: CODEX_PERMISSION_HEADERS.workspaceRoots, entries: CODEX_PERMISSION_PROFILE.workspaceRoots, quoteKeys: true },
] as const;

function renderCodexPermissionEntries(
  entries: readonly (readonly [string, string | boolean])[],
  quoteKeys: boolean,
): string {
  return entries.map(([key, value]) => `${quoteKeys ? JSON.stringify(key) : key} = ${JSON.stringify(value)}`).join("\n");
}

const CODEX_PERMISSION_PROFILE_NAME = "jorgex-yolo";

/**
 * Denied directories of the profile that do not exist under HOME, as [profile key, absolute path].
 * lstat: a dangling symlink is the user's own entry, never something to create over.
 */
function missingCodexDeniedDirs(): (readonly [string, string])[] {
  return CODEX_PERMISSION_PROFILE.filesystem
    .filter(([, access]) => access === "deny")
    .map(([key]) => [key, path.join(HOME, key.replace(/^~\//, ""))] as const)
    .filter(([, dir]) => !fs.lstatSync(dir, { throwIfNoEntry: false }));
}

const CODEX_STALE_PERMISSIONS_WARNING =
  "Codex: permission profile differs from the stack default and was left untouched; review/edit the native config.toml manually after creating a backup. Replacing permissions can discard personal choices and extra hardenings.";

/** Header normalizado (segmentos sin comillas) para comparar/leer secciones. */
function codexNormalizedHeader(header: string): string {
  return tomlHeaderName(`[${header}]`) ?? header;
}

/** Valor string de una clave escalar del root TOML (ignora comentarios); undefined si ausente o no escalar. */
function readCodexRootValue(config: string, key: string): string | undefined {
  const lines = config.replace(/\r\n/g, "\n").split("\n");
  const mask = multilineStringMask(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=`);
  for (const [index, line] of lines.entries()) {
    if (mask[index]) continue;
    if (line.trim().startsWith("[")) break;
    if (!keyPattern.test(line)) continue;
    const match = CODEX_ASSIGNMENT.exec(line.trim());
    return match === null ? undefined : parseTomlString(match[2]);
  }
  return undefined;
}

function isCodexPermissionBlockCurrent(config: string, defaults: Record<string, unknown>): boolean {
  const expectedApproval = defaults["approval_policy"];
  const expectedDefault = defaults["default_permissions"];
  if (typeof expectedApproval !== "string" || typeof expectedDefault !== "string") return true;
  if (readCodexRootValue(config, "approval_policy") !== expectedApproval) return false;
  if (readCodexRootValue(config, "default_permissions") !== expectedDefault) return false;
  return CODEX_PERMISSION_SECTIONS.every(({ header, entries, quoteKeys }) =>
    (readTomlSection(config, codexNormalizedHeader(header)) ?? "").trim()
      === renderCodexPermissionEntries(entries, quoteKeys).trim(),
  );
}

export const codexAdapter: Adapter = {
  id: "codex",
  name: "Codex CLI",
  detect: detectCodex,


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
      pluginsDir: null,
      scriptsDir: path.join(configDir, "scripts"),
    };
  },

  renderAgent(agent: CanonicalAgent, models: AgentModelChoices) {
    const selected = agentModelChoice(models, agent.name);

    const lines = [
      `name = ${tomlString(agent.name)}`,
      `description = ${tomlString(agent.description)}`,
    ];
    if (selected.model) lines.push(`model = ${tomlString(selected.model)}`);
    if (selected.variant) lines.push(`model_reasoning_effort = ${tomlString(selected.variant)}`);
    // Codex hereda el sandbox del padre; un rol no impone aislamiento por agente.
    lines.push(`developer_instructions = ${tomlMultiline(agent.body)}`);

    return [{ file: `${agent.name}.toml`, content: lines.join("\n") + "\n", kind: "agent" as const }];
  },


  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const file = path.join(ctx.configDir, "config.toml");
    const original = readMcpConfig(file);
    const contentSource = original === null || original.trim() === "" ? null : original;
    let content = contentSource;
    const mcpOwnership: McpOwnershipChange[] = [];
    const configOwnership: ConfigOwnershipChange[] = [];
    let ensureDirs: string[] | undefined;

    const context7 = canonical.servers.context7;
    if (context7 !== undefined) {
      assertCompatibleContext7(context7, readTomlSection(contentSource, "mcp_servers.context7"), contentSource);
    }

    // Permisos por defecto: solo en config fresca o vacía. Una config
    // existente no se auto-expande jamás.
    if (contentSource === null) {
      const defaults = loadCanonicalDefaults(ctx.stackDir)["codex"] ?? {};
      for (const [key, value] of Object.entries(defaults)) {
        const line = `${key} = ${tomlString(String(value))}\n`;
        content = content === null ? line : line + content;
      }

      ctx.warnings.push(
        "Codex: fresh config never asks for approval and runs in the provider sandbox with home-wide writes and network. Only ~/.ssh and ~/.aws are denied; .env files, .npmrc and loose keys are NOT protected.",
      );

      // Nunca con --target-dir: ese modo no toca el HOME real.
      if (ctx.targetDir === undefined) {
        const missing = missingCodexDeniedDirs();
        if (missing.length > 0) {
          ensureDirs = missing.map(([, dir]) => dir);
          ctx.warnings.push(
            `Codex: ${missing.map(([key]) => key).join(" and ")} missing; created empty with mode 700 when this config is applied, because Codex 0.160+ fails every sandboxed command if a denied directory does not exist.`,
          );
        }
      }

      content = upsertTomlSection(
        content,
        CODEX_PERMISSION_HEADERS.base,
        renderCodexPermissionEntries(CODEX_PERMISSION_PROFILE.base, false),
      );
      content = upsertTomlSection(
        content,
        CODEX_PERMISSION_HEADERS.network,
        renderCodexPermissionEntries(CODEX_PERMISSION_PROFILE.network, false),
      );
      content = upsertTomlSection(
        content,
        CODEX_PERMISSION_HEADERS.filesystem,
        renderCodexPermissionEntries(CODEX_PERMISSION_PROFILE.filesystem, true),
      );
      content += [
        `\n[${CODEX_PERMISSION_HEADERS.workspaceRoots}]`,
        renderCodexPermissionEntries(CODEX_PERMISSION_PROFILE.workspaceRoots, true),
        "",
      ].join("\n");
    }

    // Config existente: solo comparar/avisar; los permisos ajenos se preservan.
    if (contentSource !== null) {
      const codexDefaults = loadCanonicalDefaults(ctx.stackDir)["codex"];
      if (codexDefaults !== undefined && !isCodexPermissionBlockCurrent(contentSource, codexDefaults)) {
        ctx.warnings.push(CODEX_STALE_PERMISSIONS_WARNING);
      }
      // El config.toml preservado no se toca; solo se crea el directorio que su perfil activo necesita.
      // Doctor y dry-run reciben el mismo aviso pero nunca aplican el plan.
      if (ctx.targetDir === undefined && readCodexRootValue(contentSource, "default_permissions") === CODEX_PERMISSION_PROFILE_NAME) {
        const filesystem = readTomlSection(contentSource, codexNormalizedHeader(CODEX_PERMISSION_HEADERS.filesystem)) ?? "";
        const missing = missingCodexDeniedDirs().filter(([key]) => parseTomlString(tomlAssignment(filesystem, key).raw) === "deny");
        if (missing.length > 0) ensureDirs = missing.map(([, dir]) => dir);
        for (const [key] of missing) {
          const warning = `Codex: profile ${CODEX_PERMISSION_PROFILE_NAME} denies ${key} but that directory does not exist; Codex 0.160+ then fails every sandboxed command (bwrap: Destination is not a file). It is created empty with mode 700 when this config is applied; manual fix: mkdir -m 700 ${key}`;
          if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
        }
      }
    }

    for (const [name, server] of Object.entries(canonical.servers)) {
      // Plugin oficial activo: sus hooks y skill no incluyen este MCP; el
      // setup (`engram setup codex`) registra un MCP user separado.
      // Preservar cualquier `engram` existente (oficial o ajeno), liberar
      // ownership previo del Stack si lo tiene y no recrearlo si falta.
      if (name === "engram" && hasActiveEngramPlugin(ctx.configDir)) {
        if (ctx.ownedMcpServers?.has(name) === true) {
          mcpOwnership.push({ server: name, owned: false });
        }
        ctx.warnings.push(
          "Codex: plugin oficial de Engram activo — sus hooks y skill no incluyen el MCP; el setup registra un MCP user separado que Stack no posee ni muta.",
        );
        continue;
      }
      const section = `mcp_servers.${name}`;
      const existing = readTomlSection(content, section);
      const owned = ctx.ownedMcpServers?.has(name) === true;
      if (name === "context7" && existing !== null) {
        // Una definición compatible previa es suficiente para Context7. Solo
        // se libera ownership si el usuario modificó la entrada creada por el
        // Stack; nunca se reemplazan sus headers ni campos adicionales.
        if (owned && !isCanonicalContext7Server(server, existing, content)) {
          mcpOwnership.push({ server: name, owned: false });
        }
        continue;
      }
      if (!isCanonicalMcpServerEnabled(name, server, ctx.enabledMcpServers)) {
        if (owned) {
          if (isManagedOptionalStdioServer(server, existing)) content = removeTomlSection(content!, section);
          mcpOwnership.push({ server: name, owned: false });
        }
        continue;
      }
      if (server.optional && existing !== null) {
        if (!owned || !isManagedOptionalStdioServer(server, existing)) {
          throw new Error(`Codex: ${name}: conflicto con servidor MCP existente ajeno o modificado; se conserva. Retira esa entrada explícitamente antes de activar DevTools gestionado.`);
        }
      }
      if (server.transport === "stdio") {
        if (server.command === "{{ENGRAM_BIN}}" && ctx.engramBin === null) {
          ctx.warnings.push(
            "Engram no detectado: el MCP 'engram' no se registra. Abre jorgex-stack → Instalar/configurar → Configuración por runtime y elige Aplicar para instalar/configurar la integración oficial.",
          );
          continue;
        }
        const command = server.command === "{{ENGRAM_BIN}}" ? ctx.engramBin! : server.command!;
        content = upsertTomlSection(content, section, `command = ${tomlString(command)}\nargs = [${(server.args ?? []).map(tomlString).join(", ")}]`);
        if (server.optional && existing === null && !owned) mcpOwnership.push({ server: name, owned: true });
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
        if (name === "context7" && existing === null && !owned) {
          mcpOwnership.push({ server: name, owned: true });
        }
      }
    }

    if (content === null) return [];
    if (!content.endsWith("\n")) content += "\n";
    return [{
      kind: "write",
      target: file,
      content,
      ...(ensureDirs !== undefined ? { ensureDirs } : {}),
      ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
      ...(configOwnership.length > 0 ? { configOwnership } : {}),
    }];
  },

  planUnmerge(mcp: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      const content = removeSystemPromptSections(prompt);
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const configFile = path.join(ctx.configDir, "config.toml");
    const config = readMcpConfig(configFile);
    if (config !== null) {
      let content = config;
      const configOwnership: ConfigOwnershipChange[] = [];
      const mcpOwnership: McpOwnershipChange[] = [];
      for (const [name, server] of Object.entries(mcp.servers)) {
        const section = `mcp_servers.${name}`;
        if (name === "context7") {
          const current = readTomlSection(content, section);
          const canonical = isCanonicalContext7Server(server, current, content);
          const owned = ctx.ownedMcpServers?.has(name) === true;
          if (owned) {
            if (canonical) {
              content = removeTomlSection(content, section);
            }
            mcpOwnership.push({ server: name, owned: false });
          }
          continue;
        }
        // Oficial preservado: con plugin Engram activo el MCP es oficial
        // (`engram setup codex`), no legacy del Stack. Uninstall lo conserva
        // incluso con --remove-engram; ese flag solo retira legacy aún propio.
        if (name === "engram" && hasActiveEngramPlugin(ctx.configDir)) {
          ctx.warnings.push(
            "Codex: MCP 'engram' oficial (plugin) se conserva; usa el desinstalador oficial de Engram para retirarlo.",
          );
          continue;
        }
        if (!server.optional) {
          content = removeTomlSection(content, section);
          continue;
        }
        if (ctx.ownedMcpServers?.has(name) === true) {
          if (isManagedOptionalStdioServer(server, readTomlSection(content, section))) {
            content = removeTomlSection(content, section);
          }
          mcpOwnership.push({ server: name, owned: false });
        }
      }
      actions.push({
        kind: "write",
        target: configFile,
        content,
        ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
        ...(configOwnership.length > 0 ? { configOwnership } : {}),
      });
    }

    return actions;
  },
};

/**
 * Verificador oficial Codex por capas (solo lectura).
 *
 * Lee filesystem/config real, sin refs declarativas:
 * - plugin: header `[plugins."engram@<ref>"]` sin `enabled = false`. La ref
 *   rolling `main` es la vía oficial aprobada; se deriva de config.toml y se
 *   devuelve como `acceptedRef`.
 * - mcp: sección `[mcp_servers.engram]` exacta (command == engramBin,
 *   args == ["mcp","--tools=agent"]). Un MCP que apunta a otro binario es
 *   conflicto: falla sin reescribir y preserva bloques ajenos.
 * - instructions/compact: archivos de `model_instructions_file` y
 *   `experimental_compact_prompt_file` (o defaults `engram-instructions.md` /
 *   `engram-compact-prompt.md`) existentes y no vacíos.
 *
 * No escribe ni reclama nada; `[mcp_servers.ajeno]` y resto ajeno intactos.
 */
function parseCodexEngramPluginRef(config: string): string | null {
  const header = /\[plugins\."engram@([^"]+)"\]/.exec(config);
  if (header === null) return null;
  const block = /\[plugins\."engram@[^"]*"\]([^[]*)/.exec(config);
  if (block !== null && /enabled\s*=\s*false/.test(block[1]!)) return null;
  return header[1]!;
}

function isExactCodexEngramMcp(section: string | null, engramBin: string): boolean {
  if (section === null) return false;
  const command = parseTomlString(tomlAssignment(section, "command").raw);
  if (command !== engramBin) return false;
  const argsRaw = tomlAssignment(section, "args").raw;
  if (argsRaw === undefined) return false;
  try {
    const args = JSON.parse(argsRaw) as unknown;
    return Array.isArray(args) && args.length === 2 && args[0] === "mcp" && args[1] === "--tools=agent";
  } catch {
    return false;
  }
}

function resolveCodexInstructionPath(
  config: string | null,
  configDir: string,
  key: string,
  fallback: string,
): string {
  const ref = config !== null ? readCodexRootValue(config, key) : undefined;
  const rel = typeof ref === "string" && ref.trim() !== "" ? ref.trim() : fallback;
  return path.isAbsolute(rel) ? rel : path.join(configDir, rel);
}

function isNonEmptyFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return false;
    return fs.readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export async function verifyOfficialSetup(args: { configDir: string; engramBin: string }): Promise<{
  ok: boolean;
  layers: string[];
  acceptedRef?: string;
  duplicates: boolean;
  reason?: string;
}> {
  const config = readTextIfExists(path.join(args.configDir, "config.toml"));
  const pluginRef = config !== null ? parseCodexEngramPluginRef(config) : null;
  const mcpSection = config !== null ? readTomlSection(config, "mcp_servers.engram") : null;
  const hasMcp = mcpSection !== null && typeof args.engramBin === "string" && args.engramBin !== ""
    ? isExactCodexEngramMcp(mcpSection, args.engramBin)
    : false;
  const mcpPresentButForeign = mcpSection !== null && !hasMcp;
  const instructionsFile = resolveCodexInstructionPath(config, args.configDir, "model_instructions_file", "engram-instructions.md");
  const compactFile = resolveCodexInstructionPath(
    config,
    args.configDir,
    "experimental_compact_prompt_file",
    "engram-compact-prompt.md",
  );
  const hasInstructions = isNonEmptyFile(instructionsFile);
  const hasCompact = isNonEmptyFile(compactFile);

  const passed: string[] = [];
  const missing: string[] = [];
  if (pluginRef !== null) passed.push("plugin");
  else missing.push("plugin:missing");
  if (hasMcp) passed.push("mcp");
  else missing.push(mcpPresentButForeign ? "mcp:conflict" : "mcp:missing");
  if (hasInstructions) passed.push("instructions");
  else missing.push("instructions:missing");
  if (hasCompact) passed.push("compact");
  else missing.push("compact:missing");

  if (missing.length === 0) {
    return { ok: true, layers: passed, acceptedRef: pluginRef!, duplicates: false };
  }
  const detail = mcpPresentButForeign
    ? `MCP 'engram' en conflicto (no apunta al binario oficial ${args.engramBin}); se preserva la config ajena sin reescribir.`
    : `Codex: setup oficial Engram incompleto (falta: ${missing.join(", ")}).`;
  return {
    ok: false,
    layers: [...passed, ...missing],
    ...(pluginRef !== null ? { acceptedRef: pluginRef } : {}),
    duplicates: false,
    reason: detail,
  };
}

registerOfficialSetupVerifier("codex", verifyOfficialSetup);
