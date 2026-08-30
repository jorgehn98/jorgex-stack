import path from "node:path";
import fs from "node:fs";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange, PrimaryModelOwnershipChange } from "./types.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import { resolveAgentModel, type RuntimeModelMap } from "../lib/model-map.js";
import { detectCodex } from "../lib/detect.js";
import { isCanonicalMcpServerEnabled, loadCanonicalDefaults } from "../lib/canonical.js";
import { HOME, samePath, stackRoot } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import {
  readTomlSection,
  hasTomlRootKey,
  removeMarkdownSection,
  removeTomlRootKeyIfExact,
  removeTomlSection,
  upsertTomlRootKeyIfMissing,
  upsertTomlSection,
} from "../lib/filemerge.js";
import { removeNativeHooks, upsertNativeHooks } from "../lib/hooks-format.js";
import { createLocalCapabilityReport, hasManagedMarkdownSection } from "../lib/quality-capabilities.js";

/** String TOML de una línea (los escapes de JSON son válidos en basic strings). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

const PRIMARY_MODEL = '"gpt-5.6-sol"';
const PRIMARY_CONTEXT_WINDOW = "872000";
const PRIMARY_MODEL_FIELD = "model";
const PRIMARY_CONTEXT_FIELD = "model_context_window";

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

const CODEX_JSON_STRING = String.raw`"(?:\\.|[^"\\\r\n])*"`;
const CODEX_JSON_VALUE = String.raw`(?:${CODEX_JSON_STRING}|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|true|false)`;
const CODEX_JSON_STRING_ARRAY = String.raw`\[(?:\s*${CODEX_JSON_STRING}(?:\s*,\s*${CODEX_JSON_STRING})*\s*)?\]`;
const CODEX_KEY = String.raw`(?:[A-Za-z0-9_-]+|${CODEX_JSON_STRING})`;
const CODEX_ASSIGNMENT = new RegExp(String.raw`^\s*(${CODEX_KEY})\s*=\s*(${CODEX_JSON_STRING_ARRAY}|${CODEX_JSON_VALUE})\s*(?:#.*)?$`);
const CODEX_HEADER = new RegExp(String.raw`^\[\s*(${CODEX_KEY}(?:\s*\.\s*${CODEX_KEY})*)\s*\]\s*(?:#.*)?$`);

const CODEX_PERMISSION_HEADERS = {
  base: "permissions.jorgex-read-anywhere",
  filesystem: "permissions.jorgex-read-anywhere.filesystem",
  workspaceRoots: 'permissions.jorgex-read-anywhere.filesystem.":workspace_roots"',
} as const;

/** Single source for the profile emitted below and checked by the diagnostic. */
const CODEX_PERMISSION_PROFILE = {
  base: [["extends", ":workspace"]],
  filesystem: [
    [":root", "read"],
    ["*.env", "deny"],
    ["*.env.*", "deny"],
    ["~/.ssh/**", "deny"],
    ["~/.aws/credentials", "deny"],
    ["~/.npmrc", "deny"],
    ["~/.git-credentials", "deny"],
    ["**/id_rsa", "deny"],
    ["**/id_ed25519", "deny"],
    ["**/*.pem", "deny"],
    ["**/*.key", "deny"],
  ],
  workspaceRoots: [
    [".", "write"],
    ["*.env", "deny"],
    ["*.env.*", "deny"],
    [".ssh/**", "deny"],
    [".aws/credentials", "deny"],
    [".npmrc", "deny"],
    [".git-credentials", "deny"],
    ["**/id_rsa", "deny"],
    ["**/id_ed25519", "deny"],
    ["**/*.pem", "deny"],
    ["**/*.key", "deny"],
  ],
} as const;

const CODEX_PERMISSION_SECTIONS = [
  { header: CODEX_PERMISSION_HEADERS.base, entries: CODEX_PERMISSION_PROFILE.base, quoteKeys: false },
  { header: CODEX_PERMISSION_HEADERS.filesystem, entries: CODEX_PERMISSION_PROFILE.filesystem, quoteKeys: true },
  { header: CODEX_PERMISSION_HEADERS.workspaceRoots, entries: CODEX_PERMISSION_PROFILE.workspaceRoots, quoteKeys: true },
] as const;

function renderCodexPermissionEntries(
  entries: readonly (readonly [string, string])[],
  quoteKeys: boolean,
): string {
  return entries.map(([key, value]) => `${quoteKeys ? JSON.stringify(key) : key} = ${JSON.stringify(value)}`).join("\n");
}

function parseCodexKey(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function parseCodexValue(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") || !Array.isArray(value) && (value === null || typeof value !== "object")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCodexHeader(line: string): string | null {
  const match = CODEX_HEADER.exec(line.trim());
  if (match === null) return null;
  for (const quoted of match[1]!.match(/"(?:\\.|[^"\\\r\n])*"/g) ?? []) {
    if (parseCodexKey(quoted) === null) return null;
  }
  return match[1]!.replace(/\s*\.\s*/g, ".");
}

type CodexScan = {
  root: Map<string, unknown>;
  sections: Map<string, Map<string, unknown>>;
};

function scanCodexToml(config: string): CodexScan | null {
  if (config.includes("'''") || config.includes('"""')) return null;
  const root = new Map<string, unknown>();
  const sections = new Map<string, Map<string, unknown>>();
  const headers = new Set<string>();
  const keys = new Set<string>();
  let section: string | null = null;

  for (const line of config.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      const header = parseCodexHeader(trimmed);
      if (header === null || headers.has(header)) return null;
      headers.add(header);
      if (header.startsWith(`${CODEX_PERMISSION_HEADERS.base}.`) && !CODEX_PERMISSION_SECTIONS.some((entry) => entry.header === header)) {
        return null;
      }
      section = header;
      if (CODEX_PERMISSION_SECTIONS.some((entry) => entry.header === header)) sections.set(header, new Map());
      continue;
    }

    const relevant = section === null || CODEX_PERMISSION_SECTIONS.some((entry) => entry.header === section);
    const match = CODEX_ASSIGNMENT.exec(trimmed);
    if (!relevant && match === null) continue;
    if (match === null) return null;
    const key = parseCodexKey(match[1]!);
    const value = parseCodexValue(match[2]!);
    if (key === null || value === undefined) return null;
    if (section === null && (key === "profile" || key === "sandbox_mode")) return null;
    const scope = section ?? "<root>";
    const declaration = `${scope}\u0000${key}`;
    if (keys.has(declaration)) return null;
    keys.add(declaration);
    if (section === null) root.set(key, value);
    else if (sections.has(section)) sections.get(section)!.set(key, value);
  }
  return { root, sections };
}

function hasCanonicalCodexPermissionProfile(scan: CodexScan): boolean {
  for (const { header, entries } of CODEX_PERMISSION_SECTIONS) {
    const actual = scan.sections.get(header);
    if (actual === undefined || actual.size !== entries.length) return false;
    for (const [key, expected] of entries) {
      if (actual.get(key) !== expected) return false;
    }
  }
  return true;
}

/** Recognizes only the conservative single-line subset emitted by the canonical config. */
function hasCodexManualApproval(configDir: string): boolean {
  const config = readTextIfExists(path.join(configDir, "config.toml"));
  if (config === null) return false;
  const scan = scanCodexToml(config);
  if (scan === null) return false;
  try {
    const defaults = loadCanonicalDefaults(stackRoot())["codex"];
    const expectedApproval = defaults?.["approval_policy"];
    const expectedPermissions = defaults?.["default_permissions"];
    return typeof expectedApproval === "string"
      && typeof expectedPermissions === "string"
      && scan.root.get("approval_policy") === expectedApproval
      && scan.root.get("default_permissions") === expectedPermissions
      && hasCanonicalCodexPermissionProfile(scan);
  } catch {
    return false;
  }
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

  reportCapabilities(configDir) {
    const prompt = readTextIfExists(path.join(configDir, "AGENTS.md"));
    return createLocalCapabilityReport("codex", [
      ...(hasManagedMarkdownSection(prompt, "system-prompt")
        ? [{
            id: "policy-guidance",
            state: "prompt-only",
            reason: "The managed policy prompt is advisory and cannot enforce the policy",
            evidence: { source: "jorgex-stack-system-prompt", version: "1" },
          }]
        : []),
      ...(hasCodexManualApproval(configDir)
        ? [{
            id: "tool-approval",
            state: "manual",
            reason: "Canonical approval declarations require a human decision; runtime activation is not certified",
            evidence: { source: "jorgex-stack-codex-approval-policy", version: "1" },
          }]
        : []),
      {
        id: "external-verification",
        state: "unavailable",
        reason: "External verification is available only through the external verifier",
      },
    ]);
  },

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
    // developer). planSkills instala el workflow canónico compartido.
    // Sin model ni effort: el primary usa SIEMPRE el modelo que el usuario
    // tenga por defecto (y puede cambiarlo en sesión) — solo los subagentes
    // fijan modelo por tier.
    if (agent.mode === "primary") {
      const profileLines = [
        "# Managed by jorgex-stack — modo orquestador del agente principal.",
        `# Uso: codex --profile ${agent.name}`,
        `developer_instructions = ${tomlMultiline(agent.body)}`,
      ];

      return [{ file: `${agent.name}.config.toml`, content: profileLines.join("\n") + "\n", kind: "profile" as const }];
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
    const mcpOwnership: McpOwnershipChange[] = [];
    const primaryModelOwnership: PrimaryModelOwnershipChange[] = [];

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

      content = upsertTomlSection(
        content,
        CODEX_PERMISSION_HEADERS.base,
        renderCodexPermissionEntries(CODEX_PERMISSION_PROFILE.base, false),
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

    if (!hasTomlRootKey(content, PRIMARY_MODEL_FIELD)) {
      content = upsertTomlRootKeyIfMissing(content, PRIMARY_MODEL_FIELD, PRIMARY_MODEL);
      if (ctx.ownedPrimaryModelFields?.has(PRIMARY_MODEL_FIELD) !== true) {
        primaryModelOwnership.push({ field: PRIMARY_MODEL_FIELD, owned: true });
      }
    }
    if (!hasTomlRootKey(content, PRIMARY_CONTEXT_FIELD)) {
      content = upsertTomlRootKeyIfMissing(content, PRIMARY_CONTEXT_FIELD, PRIMARY_CONTEXT_WINDOW);
      if (ctx.ownedPrimaryModelFields?.has(PRIMARY_CONTEXT_FIELD) !== true) {
        primaryModelOwnership.push({ field: PRIMARY_CONTEXT_FIELD, owned: true });
      }
    }

    for (const [name, server] of Object.entries(canonical.servers)) {
      const section = `mcp_servers.${name}`;
      const existing = readTomlSection(content, section);
      const owned = ctx.ownedMcpServers?.has(name) === true;
      if (!isCanonicalMcpServerEnabled(name, server, ctx.enabledMcpServers)) {
        if (owned) {
          if (isManagedOptionalStdioServer(server, existing)) content = removeTomlSection(content!, section);
          mcpOwnership.push({ server: name, owned: false });
        }
        continue;
      }
      if (server.optional && existing !== null) {
        if (!owned || !isManagedOptionalStdioServer(server, existing)) {
          if (owned) mcpOwnership.push({ server: name, owned: false });
          ctx.warnings.push(`Codex: MCP opcional '${name}' ya pertenece a la configuración del usuario; se conserva.`);
          continue;
        }
      }
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
      }
    }

    if (content === null) return [];
    if (!content.endsWith("\n")) content += "\n";
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
    const { systemPromptFile } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      let content = removeMarkdownSection(prompt, "system-prompt");
      content = removeMarkdownSection(content, "engram-protocol");
      content = removeMarkdownSection(content, "browser");
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const configFile = path.join(ctx.configDir, "config.toml");
    const config = readTextIfExists(configFile);
    if (config !== null) {
      let content = config;
      const primaryModelOwnership: PrimaryModelOwnershipChange[] = [];
      if (ctx.ownedPrimaryModelFields?.has(PRIMARY_MODEL_FIELD) === true) {
        content = removeTomlRootKeyIfExact(content, PRIMARY_MODEL_FIELD, PRIMARY_MODEL);
        primaryModelOwnership.push({ field: PRIMARY_MODEL_FIELD, owned: false });
      }
      if (ctx.ownedPrimaryModelFields?.has(PRIMARY_CONTEXT_FIELD) === true) {
        content = removeTomlRootKeyIfExact(content, PRIMARY_CONTEXT_FIELD, PRIMARY_CONTEXT_WINDOW);
        primaryModelOwnership.push({ field: PRIMARY_CONTEXT_FIELD, owned: false });
      }
      const mcpOwnership: McpOwnershipChange[] = [];
      for (const [name, server] of Object.entries(mcp.servers)) {
        const section = `mcp_servers.${name}`;
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
        ...(primaryModelOwnership.length > 0 ? { primaryModelOwnership } : {}),
      });
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
