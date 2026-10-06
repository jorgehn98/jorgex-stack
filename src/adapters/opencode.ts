import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import type { Adapter, FileAction, InstallContext, McpOwnershipChange, ConfigOwnershipChange } from "./types.js";
import { BROWSER_CONTROL_GUIDANCE, BROWSER_CONTROL_INCOMPATIBLE_WARNING, isBrowserControlCommand, SECRET_PATH_EXCEPTION, SECRET_PATH_PATTERNS, isCanonicalMcpServerEnabled } from "../lib/canonical.js";
import type { CanonicalAgent, CanonicalMcp } from "../lib/canonical.js";
import { agentModelChoice, type AgentModelChoices } from "../lib/agent-model.js";
import { detectOpenCode } from "../lib/detect.js";
import { HOME, resolveOpenCodeConfigDir, samePath } from "../lib/paths.js";
import { readTextIfExists } from "../lib/fsx.js";
import { editJsonc, editJsoncArray, parseJsoncObject, upsertJson } from "../lib/filemerge.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";

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
  if (content.trim() !== "" && parseJsoncObject(content).value === null) {
    throw new Error(`OpenCode: la configuración MCP en ${file} debe contener un objeto JSON válido.`);
  }
  return content;
}

/**
 * Escritura quirúrgica del server config: un archivo existente se edita como
 * JSONC (comentarios/orden/formato ajenos preservados) y una config nueva o
 * vacía se serializa limpia.
 */
function editConfigContent(source: string | null, mutate: (root: Record<string, unknown>) => void): string {
  if (source === null || source.trim() === "") return upsertJson(null, mutate);
  return editJsonc(source, mutate);
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

const CONFIG_FILENAME = "opencode.json";
const CONFIG_FILENAME_JSONC = "opencode.jsonc";
const CLI_FILENAME = "cli.json";
/** Entrada local del panel TUI en cli.json (ruta relativa al configDir). */
const TUI_PLUGIN_ENTRY = "./tui/subagents";
/** Id declarado por el plugin del panel; se usa para casar disable directives. */
const TUI_PLUGIN_ID = "jorgex.subagents";
/**
 * Copias fijas current-only del cliente v2 (Spec T19): el WAV audible `done.wav`,
 * el silencioso `silent.wav` y los dos archivos del panel TUI. Viven fuera de
 * `stack/plugins/` para no auto-cargarse como plugin de servidor; la entrada de
 * cli.json apunta a `./tui/subagents`.
 */
const CLIENT_ADDITIONAL_RESOURCES = [
  { source: "assets/opencode/sounds/done.wav", target: "sounds/done.wav" },
  { source: "assets/opencode/sounds/silent.wav", target: "sounds/silent.wav" },
  { source: "assets/opencode/tui/subagents/tui.tsx", target: "tui/subagents/tui.tsx" },
  { source: "assets/opencode/tui/subagents/state.mjs", target: "tui/subagents/state.mjs" },
] as const;
const BROWSER_CONTROL_SERVER = "browser-control";

/**
 * Un MCP manual `browser-control` solo equivale al launcher gestionado si es
 * local, está efectivamente habilitado y expuesto por Code Mode, y su command
 * es `[command, ...args]` con el nombre canónico o una ruta absoluta al mismo
 * binario (la invocación ya es `readyMCP`). No se
 * exige igualdad del objeto completo: los campos desconocidos del usuario se
 * preservan. Un `type` remoto, un command ausente/distinto, `disabled: true`
 * nativo, `enabled: false` legacy o `codemode: false` no pueden anunciar el MCP
 * obligatorio de Code Mode.
 */
function isCompatibleBrowserControlServer(
  value: unknown,
  invocation: { command: string; args: readonly string[] },
): boolean {
  const entry = objectValue(value);
  if (entry === null || entry["type"] !== "local") return false;
  if (entry["disabled"] === true || entry["enabled"] === false || entry["codemode"] === false) return false;
  const command = entry["command"];
  return Array.isArray(command)
    && isBrowserControlCommand(command[0], invocation.command)
    && isDeepStrictEqual(command.slice(1), [...invocation.args]);
}

/**
 * El objeto gestionado de Browser Control solo es el canónico EXACTO si su forma
 * completa es `{ type: 'local', command: [command, ...args] }`: sin campos
 * extra del usuario ni command/flags modificados. El uninstall retira el objeto
 * entero solo en ese caso; cualquier desviación se conserva íntegra y únicamente
 * libera la autoridad de ownership. La comparación usa la invocación ya
 * verificada, nunca una receta sobre `--eval` ni igualdad parcial de command.
 */
function isExactCanonicalBrowserControlServer(
  value: unknown,
  invocation: { command: string; args: readonly string[] },
): boolean {
  return isDeepStrictEqual(value, { type: "local", command: [invocation.command, ...invocation.args] });
}


function fieldId(basename: string, ...segments: string[]): string {
  return JSON.stringify([basename, ...segments]);
}

function ownedField(basename: string, ...segments: string[]): string {
  return fieldId(basename, ...segments);
}

/** Registra como owned un campo solo si el write real lo creó. */
function claimFieldId(
  owned: ReadonlySet<string> | undefined,
  changes: ConfigOwnershipChange[],
  field: string,
): void {
  if (owned?.has(field) !== true) changes.push({ field, owned: true });
}

function claimOwnedField(
  owned: ReadonlySet<string> | undefined,
  changes: ConfigOwnershipChange[],
  basename: string,
  ...segments: string[]
): void {
  claimFieldId(owned, changes, ownedField(basename, ...segments));
}

/** Raíz de estado nativa de OpenCode (el migrador CLI lee state/kv.json). */
function opencodeStateDir(ctx: InstallContext): string {
  // Sandbox --target-dir: raíz sintética confinada al target, nunca el estado
  // personal (XDG_STATE_HOME/HOME). La señal es explícita, no comparación de rutas.
  if (ctx.targetDir !== undefined) return path.join(ctx.targetDir, ".jorgex-stack", "opencode");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(HOME, ".local", "state"), "opencode");
}

/**
 * Fuentes legacy que el migrador nativo v2 consume al primer arranque. Si
 * existen y `cli.json` aún no se creó, precrearlo bloquearía esa migración.
 */
function hasPendingCliMigration(ctx: InstallContext): boolean {
  for (const name of ["tui.json", "tui.jsonc"]) {
    if (readTextIfExists(path.join(ctx.configDir, name)) !== null) return true;
  }
  return readTextIfExists(path.join(opencodeStateDir(ctx), "kv.json")) !== null;
}

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/**
 * Overlay v2 fresh (Spec T04): `external_directory` permitido, `read`/`edit`
 * denegados sobre secretos y `*.env.example` re-permitido después para ganar
 * la última coincidencia. Git/shell quedan sin reglas propias: la base v2 los
 * permite y no se importan los asks de otros runtimes.
 */
function freshPermissions(): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "external_directory", resource: "*", effect: "allow" }];
  for (const action of ["read", "edit"] as const) {
    for (const resource of SECRET_PATH_PATTERNS) rules.push({ action, resource, effect: "deny" });
    rules.push({ action, resource: SECRET_PATH_EXCEPTION, effect: "allow" });
  }
  return rules;
}

/**
 * Hojas exactas del cliente v2 (Spec T19:12). Los paths de audio se derivan de
 * la raíz efectiva (`ctx.configDir`): `done.wav` es el único audible y
 * `silent.wav` (PCM16 de muestras cero, no vacío) sirve los cinco alias
 * restantes para evitar el fallback builtin. Ambos se copian por
 * `planAdditionalResources` en el mismo configDir.
 */
interface CliDefaultLeaf {
  segments: readonly string[];
  value: unknown;
}

function cliDefaultLeaves(configDir: string): CliDefaultLeaf[] {
  const sound = (name: string): string => path.join(configDir, "sounds", name);
  return [
    { segments: ["theme", "name"], value: "system" },
    { segments: ["theme", "mode"], value: "system" },
    { segments: ["session", "verbosity"], value: "low" },
    { segments: ["session", "permissions"], value: "autoaccept" },
    { segments: ["session", "tps"], value: true },
    { segments: ["debug", "turn_tokens"], value: true },
    { segments: ["attention", "notifications"], value: true },
    { segments: ["attention", "sound"], value: true },
    { segments: ["attention", "volume"], value: 0.1 },
    { segments: ["attention", "sounds", "done"], value: sound("done.wav") },
    { segments: ["attention", "sounds", "subagent_done"], value: sound("silent.wav") },
    { segments: ["attention", "sounds", "question"], value: sound("silent.wav") },
    { segments: ["attention", "sounds", "permission"], value: sound("silent.wav") },
    { segments: ["attention", "sounds", "error"], value: sound("silent.wav") },
    { segments: ["attention", "sounds", "default"], value: sound("silent.wav") },
  ];
}

/** Contenedores propios (prefijos de las hojas), de más superficial a más profundo. */
function cliContainerPaths(leaves: readonly CliDefaultLeaf[]): string[][] {
  const seen = new Set<string>();
  const paths: string[][] = [];
  for (const leaf of leaves) {
    for (let depth = 1; depth < leaf.segments.length; depth++) {
      const prefix = leaf.segments.slice(0, depth);
      const key = JSON.stringify(prefix);
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(prefix);
    }
  }
  return paths;
}

/**
 * Un contenedor propio presente pero no-objeto (escalar/array) es dato ambiguo
 * del usuario: no se puede sembrar esa rama sin sobrescribirlo. Devuelve la
 * ruta afectada para preservar los bytes y dejar remedio, o null si el árbol es
 * compatible (contenedores ausentes u objetos).
 */
function findInvalidCliContainer(root: Record<string, unknown>, leaves: readonly CliDefaultLeaf[]): string | null {
  for (const prefix of cliContainerPaths(leaves)) {
    let node: Record<string, unknown> = root;
    let absent = false;
    for (const segment of prefix) {
      const next = node[segment];
      if (next === undefined) {
        absent = true;
        break;
      }
      const block = objectValue(next);
      if (block === null) return prefix.join(".");
      node = block;
    }
    if (absent) continue;
  }
  return null;
}

/**
 * Directiva de desactivación documentada: una entrada `-X` desactiva plugins
 * cuyo id/ruta casa X. Se soportan la igualdad exacta, `*` global y el prefijo
 * `prefijo.*` del contrato oficial; no se adivinan otras gramáticas glob.
 */
function pluginDisableMatches(pattern: string, candidate: string): boolean {
  if (pattern === candidate || pattern === "*") return true;
  if (pattern.endsWith(".*")) return candidate.startsWith(pattern.slice(0, -1));
  return false;
}

/** Una entrada manual (string igual o `{ package }` igual) ya registra el panel. */
function panelEntryPresent(entries: readonly unknown[]): boolean {
  return entries.some((entry) =>
    entry === TUI_PLUGIN_ENTRY || objectValue(entry)?.["package"] === TUI_PLUGIN_ENTRY);
}

/** Una disable directive existente alcanza la ruta o el id del panel. */
function panelEntryDisabled(entries: readonly unknown[]): boolean {
  return entries.some((entry) => {
    if (typeof entry !== "string" || !entry.startsWith("-") || entry.length < 2) return false;
    const pattern = entry.slice(1);
    return pluginDisableMatches(pattern, TUI_PLUGIN_ENTRY) || pluginDisableMatches(pattern, TUI_PLUGIN_ID);
  });
}

interface CliPluginsPlan {
  readonly create: boolean;
  readonly appendIndex: number | null;
  readonly warning: string | null;
}

/**
 * Decide el registro de `./tui/subagents` sobre el `plugins` existente: crea el
 * contenedor si falta, no duplica una entrada manual igual (sin claim) y se
 * detiene ante un `plugins` no-array o una disable directive que alcance el
 * panel (se preserva sin neutralizarla con un override posterior).
 */
function planCliPlugins(root: Record<string, unknown>): CliPluginsPlan {
  const raw = root["plugins"];
  if (raw === undefined) return { create: true, appendIndex: 0, warning: null };
  if (!Array.isArray(raw)) {
    return { create: false, appendIndex: null, warning: "OpenCode: 'cli.json' tiene 'plugins' que no es un array; se conserva sin tocar y no se registra ./tui/subagents." };
  }
  if (panelEntryDisabled(raw)) {
    return { create: false, appendIndex: null, warning: "OpenCode: una directiva de desactivación en 'cli.json.plugins' alcanza el panel jorgex.subagents; se conserva y no se registra ./tui/subagents." };
  }
  if (panelEntryPresent(raw)) return { create: false, appendIndex: null, warning: null };
  return { create: false, appendIndex: raw.length, warning: null };
}

/**
 * Proyección del archivo compacto del cliente v2 (`cli.json`, separado del
 * server config): siembra SOLO las hojas T19 ausentes —revisando todas aunque
 * `session.verbosity` ya exista—, conserva cualquier valor ajeno (igual,
 * custom, false o null) sin reclamarlo, y nunca precrea el archivo mientras
 * exista una fuente legacy (tui.json/kv.json) que el migrador nativo deba
 * consumir primero. Los contenedores y hojas que crea se reclaman en el ledger
 * actual; los preexistentes no.
 */
function planCliConfig(ctx: InstallContext): FileAction | null {
  const file = path.join(ctx.configDir, CLI_FILENAME);
  const existing = readTextIfExists(file);
  const leaves = cliDefaultLeaves(ctx.configDir);

  // Ausente o vacío/solo espacios: se siembra salvo que el migrador nativo
  // tenga una fuente legacy pendiente.
  if (existing === null || existing.trim() === "") {
    if (hasPendingCliMigration(ctx)) {
      ctx.warnings.push(
        "OpenCode: existe una fuente legacy (tui.json/kv.json) pendiente de la migración nativa; no se precrea cli.json. Inicia OpenCode v2 una vez y repite install para sembrar los defaults del cliente.",
      );
      return null;
    }
    return seedCliDefaults(ctx, leaves, null, {});
  }

  const parsed = parseJsoncObject(existing);
  if (parsed.value === null) {
    ctx.warnings.push("OpenCode: 'cli.json' no es un objeto JSON válido; se conserva sin tocar.");
    return null;
  }
  const invalid = findInvalidCliContainer(parsed.value, leaves);
  if (invalid !== null) {
    ctx.warnings.push(
      `OpenCode: 'cli.json' tiene '${invalid}' que no es un objeto; se conserva sin tocar. Corrige o elimina esa clave y repite install para sembrar los defaults del cliente.`,
    );
    return null;
  }
  return seedCliDefaults(ctx, leaves, existing, parsed.value);
}

/**
 * Siembra las hojas T19 ausentes sobre un cli.json ausente/vacío o existente
 * válido. Devuelve null si no faltaba ninguna hoja (no se reimpone nada). El
 * registro del panel (`./tui/subagents`) se planifica siempre con las mismas
 * reglas de ausencia/preservación; `ctx.ownedConfigFields` es autoridad
 * del ledger, no un flag de ejecución.
 */
function seedCliDefaults(
  ctx: InstallContext,
  leaves: readonly CliDefaultLeaf[],
  existing: string | null,
  root: Record<string, unknown>,
): FileAction | null {
  const plugins = planCliPlugins(root);
  if (plugins.warning !== null) ctx.warnings.push(plugins.warning);
  const ownership: ConfigOwnershipChange[] = [];
  let changed = false;
  let content = editConfigContent(existing, (target) => {
    for (const leaf of leaves) {
      let node = target;
      for (let index = 0; index < leaf.segments.length - 1; index++) {
        const key = leaf.segments[index]!;
        const absent = node[key] === undefined;
        node = ensureOwnedConfigObject(
          node,
          key,
          ownedField(CLI_FILENAME, ...leaf.segments.slice(0, index + 1)),
          ctx.ownedConfigFields,
          ownership,
        );
        if (absent) changed = true;
      }
      const leafKey = leaf.segments[leaf.segments.length - 1]!;
      if (node[leafKey] !== undefined) continue;
      node[leafKey] = leaf.value;
      claimFieldId(ctx.ownedConfigFields, ownership, ownedField(CLI_FILENAME, ...leaf.segments));
      changed = true;
    }
    if (plugins.create) {
      target["plugins"] = [];
      claimFieldId(ctx.ownedConfigFields, ownership, ownedField(CLI_FILENAME, "plugins"));
      changed = true;
    }
  });
  if (plugins.appendIndex !== null) {
    content = editJsoncArray(content, { kind: "insert", path: ["plugins"], index: plugins.appendIndex, value: TUI_PLUGIN_ENTRY });
    claimFieldId(ctx.ownedConfigFields, ownership, ownedField(CLI_FILENAME, "plugins", TUI_PLUGIN_ENTRY));
    changed = true;
  }
  if (!changed) return null;
  return {
    kind: "write",
    target: path.join(ctx.configDir, CLI_FILENAME),
    content,
    ...(ownership.length > 0 ? { configOwnership: ownership } : {}),
  };
}

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
  if (value === null) throw new Error(`OpenCode: '${fieldPath}' debe ser un objeto; corrígelo antes de reintentar install.`);
  return value;
}

function ensureOwnedConfigObject(
  parent: Record<string, unknown>,
  key: string,
  field: string,
  owned: ReadonlySet<string> | undefined,
  changes: ConfigOwnershipChange[],
  fieldPath: string = field,
): Record<string, unknown> {
  const created = parent[key] === undefined;
  const value = ensureObject(parent, key, fieldPath);
  if (created && owned?.has(field) !== true) changes.push({ field, owned: true });
  return value;
}

/** Poda un contenedor SOLO si su propio ID file-qualificado es owned y quedó vacío. */
function pruneOwnedEmpty(
  parent: Record<string, unknown>,
  key: string,
  owned: (...segments: string[]) => boolean,
  ...ownerSegments: string[]
): void {
  if (!owned(...ownerSegments)) return;
  pruneEmpty(parent, key);
}

function pruneEmpty(parent: Record<string, unknown>, key: string): void {
  const value = objectValue(parent[key]);
  if (value !== null && Object.keys(value).length === 0) delete parent[key];
}

/**
 * Selector del server config nativo. `opencode.jsonc` es una fuente válida que
 * el host lee: si solo existe ese archivo se edita en su sitio con IDs basename
 * `opencode.jsonc` (nunca se crea un `opencode.json` paralelo que el host
 * ignoraría). Si coexisten `opencode.json` y `opencode.jsonc` el archivo
 * efectivo es ambiguo y se falla cerrado. Un único helper para
 * main/unmerge/read/diag.
 */
function selectOpenCodeServerFile(configDir: string): { selection: { file: string; basename: string } } | { conflict: string[] } {
  const json = path.join(configDir, CONFIG_FILENAME);
  const jsonc = path.join(configDir, CONFIG_FILENAME_JSONC);
  const hasJson = fs.existsSync(json);
  const hasJsonc = fs.existsSync(jsonc);
  if (hasJson && hasJsonc) return { conflict: [json, jsonc] };
  if (hasJsonc) return { selection: { file: jsonc, basename: CONFIG_FILENAME_JSONC } };
  return { selection: { file: json, basename: CONFIG_FILENAME } };
}


/**
 * Reconoce el bloque nativo v2 canónico (`permissions` ordenado idéntico al que
 * escribe el adapter). Solo acredita igualdad exacta: custom/modificado/ausente/
 * malformado/ilegible queda fuera y conserva una razón conservadora.
 */


export const opencodeAdapter: Adapter = {
  id: "opencode",
  name: "OpenCode",
  detect: detectOpenCode,


  paths(configDir) {
    // Skills: OpenCode lee ~/.agents/skills nativamente (verificado en
    // packages/opencode/src/skill/index.ts) — la misma copia sirve a Codex,
    // sin duplicar en ~/.config/opencode/skills. Con el configDir real
    // (aunque venga de OPENCODE_CONFIG_DIR) el ancla es HOME; con --target-dir,
    // su padre (mismo patrón que Codex en pruebas).
    const isRealConfigDir = samePath(configDir, resolveOpenCodeConfigDir());
    const agentsHome = isRealConfigDir ? HOME : path.dirname(configDir);
    return {
      systemPromptFile: path.join(configDir, "AGENTS.md"),
      agentsDir: path.join(configDir, "agents"),
      skillsDir: path.join(agentsHome, ".agents", "skills"),
      pluginsDir: path.join(configDir, "plugins"),
      scriptsDir: path.join(configDir, "scripts"),
    };
  },

  renderAgent(agent: CanonicalAgent, models: AgentModelChoices) {
    const lines: string[] = [`description: ${yamlString(agent.description)}`, `mode: ${agent.mode}`];

    const selected = agentModelChoice(models, agent.name);
    // v2 usa un único `provider/model#variant`. Se serializa con yamlString
    // (JSON double-quoted) para que un modelo manual con comillas o saltos de
    // línea no inyecte campos, comentarios ni delimitadores en el frontmatter.
    const modelRef = selected.variant ? `${selected.model}#${selected.variant}` : selected.model;
    if (selected.model) lines.push(`model: ${yamlString(modelRef!)}`);

    // Reglas nativas: los lectores no reciben shell/escritura y ningún hijo delega.
    const rules: PermissionRule[] = [];
    if (agent.readonly) rules.push({ action: "edit", resource: "*", effect: "deny" });
    if (agent.bash === "none") {
      rules.push({ action: "shell", resource: "*", effect: "deny" });
    }
    if (!agent.spawn) rules.push({ action: "subagent", resource: "*", effect: "deny" });
    if (rules.length > 0) lines.push(`permissions: ${JSON.stringify(rules)}`);

    return [
      {
        file: `${agent.name}.md`,
        content: `---\n${lines.join("\n")}\n---\n${agent.body}`,
        kind: "agent" as const,
      },
    ];
  },


  adaptSystemPromptSections(sections, ctx) {
    const adapted = { ...sections };
    delete adapted.playwright;
    if (ctx.browserControlInvocation) adapted.browser = [sections.browser, BROWSER_CONTROL_GUIDANCE].filter(Boolean).join("\n\n");
    return adapted;
  },

  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const selection = selectOpenCodeServerFile(ctx.configDir);
    if ("conflict" in selection) {
      throw new Error(
        `OpenCode: coexisten '${path.basename(selection.conflict[0]!)}' y '${path.basename(selection.conflict[1]!)}'; el archivo efectivo del host es ambiguo, así que se conservan ambos sin fusionar ni ignorar ninguno. Deja solo opencode.jsonc (o opencode.json) antes de reintentar install.`,
      );
    }
    const { file, basename: base } = selection.selection;
    const { pluginsDir } = this.paths(ctx.configDir);
    const original = readMcpConfig(file);
    const contentSource = original === null || original.trim() === "" ? null : original;
    const isFreshConfig = contentSource === null;

    const mcpOwnership: McpOwnershipChange[] = [];
    const configOwnership: ConfigOwnershipChange[] = [];
    const mutate = (root: Record<string, unknown>): void => {
      const rawMcp = root["mcp"];
      if (rawMcp !== undefined && objectValue(rawMcp) === null) {
        throw new Error("OpenCode: la clave 'mcp' debe ser un objeto; corrígela antes de reintentar install.");
      }
      const existingMcp = rawMcp as Record<string, unknown> | undefined;
      const nativeServers = objectValue(existingMcp?.["servers"]);
      // v2 anida los servidores en `mcp.servers`. Una entrada legacy plana del
      // mismo nombre se conserva y cuenta como existente: no se crea un
      // duplicado nativo que oculte la configuración efectiva del usuario.
      const inContext = (name: string): unknown => nativeServers?.[name] ?? existingMcp?.[name];
      let servers: Record<string, unknown> | null = nativeServers;
      const writableServers = (): Record<string, unknown> => {
        const mcp = (root["mcp"] ??= {}) as Record<string, unknown>;
        servers ??= ensureObject(mcp, "servers", "mcp.servers");
        return servers;
      };
      const context7 = canonical.servers.context7;
      if (context7 !== undefined) assertCompatibleContext7(context7, inContext("context7"));

      root["$schema"] ??= "https://opencode.ai/config.json";

      // Permisos v2: lista ordenada que se siembra en config fresca o vacía.
      // Una config existente se preserva y solo avisa.
      const permissions = freshPermissions();
      if (isFreshConfig) {
        root["permissions"] = permissions;
        ctx.warnings.push(
          "OpenCode: fresh config allows ordinary reads, edits, web access and Bash; secrets are denied while *.env.example stays readable. Native matching is not a universal filesystem sandbox.",
        );
      } else if (!isDeepStrictEqual(root["permissions"], permissions)) {
        ctx.warnings.push(
          "OpenCode: permissions block differs from the stack default and was left untouched; review/edit the native opencode.json or opencode.jsonc manually after creating a backup. Replacing permissions can discard personal choices and extra hardenings.",
        );
      }

      // Defaults v2 de servidor: solo campos ausentes; nunca sobrescriben un
      // valor manual. Los aliases legacy ya deciden su equivalente nativo, así
      // que no se siembra un default que los ocultaría (migrate-v1). Cada campo
      // creado se registra en el ledger file-qualificado para su uninstall.
      if (root["update"] === undefined && root["autoupdate"] === undefined) {
        root["update"] = "auto";
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "update");
      }

      const compaction = ensureOwnedConfigObject(
        root, "compaction", ownedField(base, "compaction"), ctx.ownedConfigFields, configOwnership, "compaction");
      if (compaction["auto"] === undefined) {
        compaction["auto"] = true;
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "compaction", "auto");
      }
      const keep = objectValue(compaction["keep"]);
      if (compaction["keep"] !== undefined && keep === null) {
        throw new Error("OpenCode: 'compaction.keep' debe ser un objeto; corrígelo antes de reintentar install.");
      }
      // `preserve_recent_tokens` (V1) ya decide el presupuesto retenido.
      if (compaction["preserve_recent_tokens"] === undefined && keep?.["tokens"] === undefined) {
        const keepBlock = keep ?? {};
        if (keep === null) {
          compaction["keep"] = keepBlock;
          claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "compaction", "keep");
        }
        keepBlock["tokens"] = 20000;
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "compaction", "keep", "tokens");
      }

      if (root["formatter"] === undefined) {
        root["formatter"] = true;
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "formatter");
      }
      if (root["lsp"] === undefined) {
        root["lsp"] = false;
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "lsp");
      }

      const worktree = ensureOwnedConfigObject(
        root, "worktree", ownedField(base, "worktree"), ctx.ownedConfigFields, configOwnership, "worktree");
      if (worktree["directory"] === undefined) {
        worktree["directory"] = "worktrees";
        claimOwnedField(ctx.ownedConfigFields, configOwnership, base, "worktree", "directory");
      }

      const pluginState = inspectOpencodeEngramPlugin(ctx.configDir);
      const officialPluginPresent = pluginState === "official";
      const pluginUnknown = pluginState === "unknown";
      for (const [name, server] of Object.entries(canonical.servers)) {
        const existing = inContext(name);
        const owned = ctx.ownedMcpServers?.has(name) === true;
        // Oficial preservado: con plugin oficial (`engram setup opencode`) el
        // MCP es oficial, no legacy del Stack. No se reclama ownership ni se
        // reescribe; el setup oficial es la única fuente. Usa el desinstalador
        // oficial para lo oficial. Ilegible (unknown) también se preserva sin
        // tocar ownership: no se puede probar legacy.
        if (name === "engram" && (officialPluginPresent || pluginUnknown)) {
          if (officialPluginPresent && owned) mcpOwnership.push({ server: name, owned: false });
          ctx.warnings.push(
            officialPluginPresent
              ? "OpenCode: Engram ya está integrado vía plugin oficial — no se registra el MCP para no duplicar ni reclamar ownership."
              : "OpenCode: plugin engram.ts ilegible — se conserva el MCP sin reclamar ownership hasta poder verificarlo.",
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
            if (isManagedOptionalStdioServer(server, existing)) {
              if (nativeServers !== null) delete nativeServers[name];
              if (existingMcp !== undefined && existing === existingMcp[name]) delete existingMcp[name];
            }
            mcpOwnership.push({ server: name, owned: false });
          }
          continue;
        }
        if (server.optional && existing !== undefined) {
          if (!owned || !isManagedOptionalStdioServer(server, existing)) {
            throw new Error(`OpenCode: ${name}: conflicto con servidor MCP existente ajeno o modificado; se conserva. Retira esa entrada explícitamente antes de activar DevTools gestionado.`);
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
          writableServers()[name] = { type: "local", command: [command, ...(server.args ?? [])] };
          if (server.optional && existing === undefined && !owned) mcpOwnership.push({ server: name, owned: true });
        } else {
          const previous = existing as { headers?: Record<string, string> } | undefined;
          const headers: Record<string, string> = {};
          for (const [key, raw] of Object.entries(server.headers ?? {})) {
            const envRef = /^\$\{(\w+)\}$/.exec(raw);
            // D5: el valor que el usuario ya tenga configurado manda. Sin
            // valor previo se escribe la REFERENCIA nativa de OpenCode
            // ({env:VAR}): el secreto vive en el entorno, nunca en el archivo.
            headers[key] = previous?.headers?.[key] || (envRef ? `{env:${envRef[1]!}}` : raw);
          }
          writableServers()[name] = {
            type: "remote",
            url: server.url,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
          if (name === "context7" && existing === undefined && !owned) {
            mcpOwnership.push({ server: name, owned: true });
          }
        }
      }

      const browserControl = ctx.browserControlInvocation;
      if (browserControl !== undefined) {
        const existing = inContext(BROWSER_CONTROL_SERVER);
        if (existing === undefined) {
          writableServers()[BROWSER_CONTROL_SERVER] = { type: "local", command: [browserControl.command, ...browserControl.args] };
          mcpOwnership.push({ server: BROWSER_CONTROL_SERVER, owned: true });
        } else if (!isCompatibleBrowserControlServer(existing, browserControl)) {
          ctx.warnings.push(`OpenCode: ${BROWSER_CONTROL_INCOMPATIBLE_WARNING}`);
          // Sin launcher equivalente tampoco se proyecta la guía que lo anuncia.
          ctx.browserControlInvocation = undefined;
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
          const retired = new Set(["hooks.ts", "worktree.ts"].map((name) => path.join(pluginsDir, name)).filter((file) => ctx.ownedFiles?.has(file)).map((file) => pathToFileURL(file).href));
          const kept = plugin.filter((url) => !retired.has(url));
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
    };
    const content = editConfigContent(contentSource, mutate);

    const actions: FileAction[] = [{
      kind: "write",
      target: file,
      content,
      ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
      ...(configOwnership.length > 0 ? { configOwnership } : {}),
    }];
    const cliAction = planCliConfig(ctx);
    if (cliAction !== null) actions.push(cliAction);
    return actions;
  },

  /**
   * Copias fijas current-only del cliente v2 (Spec T19): los dos WAV de sonido
   * y los dos archivos del panel TUI, desde `stack/assets/opencode/` al
   * configDir derivado de ctx. Viven fuera de `stack/plugins/` para no
   * auto-cargarse como plugin de servidor ni relajar `planPlugins`. Una fuente
   * ausente/ilegible bloquea el plan antes de cualquier write: nunca se omite en
   * silencio.
   */
  planAdditionalResources(ctx: InstallContext): FileAction[] {
    return CLIENT_ADDITIONAL_RESOURCES.map(({ source, target }): FileAction => {
      const sourcePath = path.join(ctx.stackDir, source);
      try {
        fs.readFileSync(sourcePath);
      } catch (error) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
        throw new Error(
          `OpenCode: el asset canónico '${sourcePath}' falta o no se puede leer (${code}); no se proyecta ningún recurso adicional. Restaura el paquete antes de reintentar.`,
        );
      }
      return { kind: "copy", source: sourcePath, target: path.join(ctx.configDir, target) };
    });
  },

  planUnmerge(mcp: CanonicalMcp, ctx: InstallContext): FileAction[] {
    const actions: FileAction[] = [];
    const { systemPromptFile, pluginsDir } = this.paths(ctx.configDir);

    const prompt = readTextIfExists(systemPromptFile);
    if (prompt !== null) {
      const content = removeSystemPromptSections(prompt);
      actions.push({ kind: "write", target: systemPromptFile, content });
    }

    const selection = selectOpenCodeServerFile(ctx.configDir);
    const conflict = "conflict" in selection;
    if (conflict) {
      ctx.warnings.push(
        "OpenCode: coexisten 'opencode.json' y 'opencode.jsonc'; el archivo efectivo del host es ambiguo, así que se conserva sin retirar campos gestionados. Deja solo uno antes de reintentar.",
      );
    }
    const configFile = conflict ? "" : (selection as { selection: { file: string } }).selection.file;
    const base = conflict ? CONFIG_FILENAME : (selection as { selection: { basename: string } }).selection.basename;
    const config = conflict ? null : readMcpConfig(configFile);
    if (config !== null) {
      const mcpOwnership: McpOwnershipChange[] = [];
      const configOwnership: ConfigOwnershipChange[] = [];
      const content = editConfigContent(config, (root) => {
        // Defaults v2 de servidor owned: se retiran solo si siguen siendo el
        // valor canónico del archivo correcto; un valor modificado se preserva.
        // Los contenedores vacíos se podan para no dejar residuos.
        const isOwned = (...segments: string[]): boolean =>
          ctx.ownedConfigFields?.has(ownedField(base, ...segments)) === true;
        const release = (...segments: string[]): void => {
          if (isOwned(...segments)) {
            configOwnership.push({ field: ownedField(base, ...segments), owned: false });
          }
        };

        if (isOwned("update") && root["update"] === "auto") delete root["update"];
        release("update");
        if (isOwned("formatter") && root["formatter"] === true) delete root["formatter"];
        release("formatter");
        if (isOwned("lsp") && root["lsp"] === false) delete root["lsp"];
        release("lsp");

        release("agents");
        const agentsBlock = objectValue(root["agents"]);
        if (agentsBlock !== null) {
          const planBlock = objectValue(agentsBlock["plan"]);
          if (planBlock !== null && isOwned("agents", "plan", "disabled") && planBlock["disabled"] === true) {
            delete planBlock["disabled"];
          }
          release("agents", "plan");
          release("agents", "plan", "disabled");
          pruneOwnedEmpty(agentsBlock, "plan", isOwned, "agents", "plan");
          pruneOwnedEmpty(root, "agents", isOwned, "agents");
        }

        release("compaction");
        const compactionBlock = objectValue(root["compaction"]);
        if (compactionBlock !== null) {
          if (isOwned("compaction", "auto") && compactionBlock["auto"] === true) delete compactionBlock["auto"];
          release("compaction", "auto");
          const keepBlock = objectValue(compactionBlock["keep"]);
          if (keepBlock !== null && isOwned("compaction", "keep", "tokens") && keepBlock["tokens"] === 20000) {
            delete keepBlock["tokens"];
          }
          release("compaction", "keep");
          release("compaction", "keep", "tokens");
          pruneOwnedEmpty(compactionBlock, "keep", isOwned, "compaction", "keep");
          pruneOwnedEmpty(root, "compaction", isOwned, "compaction");
        }

        release("worktree");
        const worktreeBlock = objectValue(root["worktree"]);
        if (worktreeBlock !== null) {
          if (isOwned("worktree", "directory") && worktreeBlock["directory"] === "worktrees") {
            delete worktreeBlock["directory"];
          }
          release("worktree", "directory");
          pruneOwnedEmpty(root, "worktree", isOwned, "worktree");
        }

        const rawMcpBlock = root["mcp"];
        if (rawMcpBlock !== undefined && objectValue(rawMcpBlock) === null) {
          throw new Error("OpenCode: la clave 'mcp' debe ser un objeto; corrígela antes de reintentar uninstall.");
        }
        const mcpBlock = rawMcpBlock as Record<string, unknown> | undefined;
        if (mcpBlock !== undefined) {
          const nativeServers = objectValue(mcpBlock["servers"]);
          // v2 anida en `mcp.servers`; una entrada legacy plana se considera
          // igual para no dejar residuos. Solo se retira la que coincidió: la
          // otra entrada sigue siendo del usuario.
          const currentServer = (name: string): unknown => nativeServers?.[name] ?? mcpBlock[name];
          const removeServer = (name: string): void => {
            if (nativeServers !== null && name in nativeServers) delete nativeServers[name];
            else delete mcpBlock[name];
          };
          const pluginState = inspectOpencodeEngramPlugin(ctx.configDir);
          const officialPluginPresent = pluginState === "official";
          const pluginUnknown = pluginState === "unknown";
          for (const [name, server] of Object.entries(mcp.servers)) {
            // Oficial preservado: con plugin oficial el MCP es oficial
            // (`engram setup opencode`), no legacy del Stack. Uninstall lo
            // conserva incluso con --remove-engram; ese flag solo retira
            // legacy aún propio. Usa el desinstalador oficial para lo oficial.
            // Ilegible (unknown) jamás se clasifica como legacy: también se
            // conserva el MCP y su ownership/estado.
            if (name === "engram" && (officialPluginPresent || pluginUnknown)) {
              ctx.warnings.push(
                officialPluginPresent
                  ? "OpenCode: MCP 'engram' oficial (plugin) se conserva; usa el desinstalador oficial de Engram para retirarlo."
                  : "OpenCode: plugin engram.ts ilegible — MCP 'engram' y su estado se conservan sin verificar.",
              );
              continue;
            }
            if (name === "context7") {
              const canonical = isCanonicalContext7Server(server, currentServer(name));
              const owned = ctx.ownedMcpServers?.has(name) === true;
              if (owned) {
                if (canonical) removeServer(name);
                mcpOwnership.push({ server: name, owned: false });
              }
              continue;
            }
            if (!server.optional) {
              removeServer(name);
              continue;
            }
            if (ctx.ownedMcpServers?.has(name) === true) {
              if (isManagedOptionalStdioServer(server, currentServer(name))) removeServer(name);
              mcpOwnership.push({ server: name, owned: false });
            }
          }
          // Native MCP ownership is recorded in the common manifest. A modified entry stays untouched.
          if (ctx.preserveEngram !== undefined && ctx.ownedMcpServers?.has(BROWSER_CONTROL_SERVER) === true) {
            const entry = nativeServers?.[BROWSER_CONTROL_SERVER];
            const invocation = ctx.browserControlInvocation;
            if (entry !== undefined && invocation !== undefined) {
              if (isExactCanonicalBrowserControlServer(entry, invocation)) {
                removeServer(BROWSER_CONTROL_SERVER);
              } else {
                ctx.warnings.push(
                  "OpenCode: el MCP 'browser-control' está personalizado/modificado respecto al comando nativo; se conserva completo y solo se libera el ownership.",
                );
              }
              mcpOwnership.push({ server: BROWSER_CONTROL_SERVER, owned: false });
            }
          }
          if (nativeServers !== null && Object.keys(nativeServers).length === 0) delete mcpBlock["servers"];
          if (Object.keys(mcpBlock).length === 0) delete root["mcp"];
        }
        const plugin = root["plugin"] as string[] | undefined;
        if (Array.isArray(plugin) && pluginsDir !== null) {
          // Registros file:// bajo nuestro pluginsDir: residuos de versiones
          // antiguas (los locales se auto-cargan del dir). Quitarlos no toca
          // los archivos — el plugin oficial o legacy se conserva en disco;
          // el manifest determina qué ownership puede retirarse.
          const retired = new Set(["hooks.ts", "worktree.ts"].map((name) => path.join(pluginsDir, name)).filter((file) => ctx.ownedFiles?.has(file)).map((file) => pathToFileURL(file).href));
          const kept = plugin.filter((url) => !retired.has(url));
          if (kept.length === 0) delete root["plugin"];
          else root["plugin"] = kept;
        }
      });
      actions.push({
        kind: "write",
        target: configFile,
        content,
        ...(mcpOwnership.length > 0 ? { mcpOwnership } : {}),
        ...(configOwnership.length > 0 ? { configOwnership } : {}),
      });
    }

    // `cli.json` es un target compartido del Stack. Se declara SIEMPRE que el
    // archivo exista en el root correcto: (a) protege el archivo de un borrado
    // whole-file en uninstall aunque el ledger todavía no tenga el campo (p.ej.
    // la primera pasada, donde el ctx se construyó antes del write) y (b) lo
    // corrobora en el inventario del manifest. Sin el campo owned la acción es
    // un no-op byte-idéntico: diffPlan la marca "unchanged" y no se reescribe
    // nada. Con campos owned solo se retira la hoja que siga siendo el valor
    // canónico, preservando claves ajenas y comentarios JSONC.
    const cliFile = path.join(ctx.configDir, CLI_FILENAME);
    const cliRaw = readTextIfExists(cliFile);
    if (cliRaw !== null) {
      const cliLeaves = cliDefaultLeaves(ctx.configDir);
      const cliOwned = ctx.ownedConfigFields;
      const cliField = (...segments: string[]): string => ownedField(CLI_FILENAME, ...segments);
      const pluginsContainerField = cliField("plugins");
      const pluginsEntryField = cliField("plugins", TUI_PLUGIN_ENTRY);
      const hasOwnedCliField =
        cliLeaves.some((leaf) => cliOwned?.has(cliField(...leaf.segments)) === true)
        || cliContainerPaths(cliLeaves).some((prefix) => cliOwned?.has(cliField(...prefix)) === true)
        || cliOwned?.has(pluginsContainerField) === true
        || cliOwned?.has(pluginsEntryField) === true;
      if (hasOwnedCliField) {
        const cliOwnership: ConfigOwnershipChange[] = [];
        let content = editConfigContent(cliRaw, (root) => {
          // Solo se retira la hoja owned que siga siendo el valor canónico; un
          // valor modificado se preserva. La marca se libera siempre.
          for (const leaf of cliLeaves) {
            const field = cliField(...leaf.segments);
            if (cliOwned?.has(field) !== true) continue;
            let node: Record<string, unknown> | null = root;
            for (const segment of leaf.segments.slice(0, -1)) {
              node = node === null ? null : objectValue(node[segment]);
            }
            const leafKey = leaf.segments[leaf.segments.length - 1]!;
            if (node !== null && isDeepStrictEqual(node[leafKey], leaf.value)) delete node[leafKey];
            cliOwnership.push({ field, owned: false });
          }
          // Contenedores propios vacíos: se podan solo si su ID es owned (un
          // `{}` ajeno preexistente sobrevive) y de más profundo a más
          // superficial para que el padre quede vacío tras podar al hijo.
          for (const prefix of [...cliContainerPaths(cliLeaves)].sort((a, b) => b.length - a.length)) {
            const field = cliField(...prefix);
            if (cliOwned?.has(field) !== true) continue;
            let parent: Record<string, unknown> | null = root;
            for (const segment of prefix.slice(0, -1)) {
              parent = parent === null ? null : objectValue(parent[segment]);
            }
            const key = prefix[prefix.length - 1]!;
            if (parent !== null) pruneEmpty(parent, key);
            cliOwnership.push({ field, owned: false });
          }
        });
        // Entrada propia del panel: solo se retira el string canónico único; un
        // duplicado o una forma de objeto ajena se preservan. La marca se libera.
        if (cliOwned?.has(pluginsEntryField) === true) {
          const parsed = parseJsoncObject(content);
          const entries = parsed.value !== null && Array.isArray(parsed.value["plugins"]) ? parsed.value["plugins"] : null;
          if (entries !== null) {
            const indices = entries.flatMap((entry, index) => (entry === TUI_PLUGIN_ENTRY ? [index] : []));
            const objectForm = entries.some((entry) => objectValue(entry)?.["package"] === TUI_PLUGIN_ENTRY);
            if (indices.length === 1 && !objectForm) {
              content = editJsoncArray(content, { kind: "remove", path: ["plugins"], index: indices[0]! });
            }
          }
          cliOwnership.push({ field: pluginsEntryField, owned: false });
        }
        // Contenedor propio creado: se poda solo si quedó vacío y sin
        // comentarios ajenos; un `plugins` preexistente nunca se toca.
        if (cliOwned?.has(pluginsContainerField) === true) {
          content = editJsoncArray(content, { kind: "prune", path: ["plugins"] });
          cliOwnership.push({ field: pluginsContainerField, owned: false });
        }
        actions.push({
          kind: "write",
          target: cliFile,
          content,
          configOwnership: cliOwnership,
        });
      } else if (cliRaw.trim() !== "") {
        actions.push({ kind: "write", target: cliFile, content: cliRaw });
      }
    }

    return actions;
  },
};

/**
 * Transferencia de ownership OpenCode al plugin oficial v2 nativo.
 *
 * `engram setup opencode` reemplaza el contenido en la MISMA ruta
 * `plugins/engram.ts` (no es un archivo nuevo) + registra MCP exacto y
 * el statusline `opencode-subagent-statusline` que la reconciliación retira.
 * La transferencia verifica esas capas en filesystem real y retira solo
 * ownership/manifest Stack: deja el archivo oficial intacto, conserva
 * `hooks.ts`/`worktree.ts` y plugins ajenos, preserva JSONC/config ajena y
 * evita recreación en install/uninstall. Ambiguity/custom bloquea y conserva el
 * custom.
 *
 * Devuelve señales booleanas (`ownershipRetired`/`retired`/`recreateOnSync`/
 * `preserveOfficialOnUninstall`) derivadas de paths/manifest reales.
 */


/** Avanza desde una comilla hasta cerrarla, respetando escapes. */
function skipOpencodePluginQuoted(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

/** Salta espacios y comentarios; devuelve el índice del siguiente token de código. */
function skipOpencodePluginTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    return index;
  }
  return index;
}

/** `true` si en `index` empieza `word` como token completo (no dentro de otro identificador). */
function isOpencodePluginWordAt(source: string, index: number, word: string): boolean {
  if (!source.startsWith(word, index)) return false;
  const before = index === 0 ? "" : source[index - 1]!;
  const after = source[index + word.length] ?? "";
  return !/[\w$]/.test(before) && !/[\w$]/.test(after);
}

/** Cuerpo balanceado del objeto literal que abre en `open`; `null` si no cierra. */
function readOpencodePluginObjectBody(source: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < source.length; ) {
    const char = source[index]!;
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipOpencodePluginTrivia(source, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipOpencodePluginQuoted(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
    index += 1;
  }
  return null;
}

/**
 * Cuerpo del objeto de `export default { … }` a nivel de código. Se saltan
 * comentarios y strings, así que un `export default` dentro de un comentario o
 * de un literal no acredita. `null` si no hay entrypoint con esa forma.
 */
function readDefaultExportObjectBody(source: string): string | null {
  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipOpencodePluginTrivia(source, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipOpencodePluginQuoted(source, index);
      continue;
    }
    if (isOpencodePluginWordAt(source, index, "export")) {
      const afterExport = skipOpencodePluginTrivia(source, index + "export".length);
      if (isOpencodePluginWordAt(source, afterExport, "default")) {
        const open = skipOpencodePluginTrivia(source, afterExport + "default".length);
        return source[open] === "{" ? readOpencodePluginObjectBody(source, open) : null;
      }
    }
    index += 1;
  }
  return null;
}

/** Propiedades de primer nivel del cuerpo de un objeto (clave → valor crudo). */
function readOpencodePluginTopLevelProperties(body: string): Map<string, string> {
  const properties = new Map<string, string>();
  let depth = 0;
  let segmentStart = 0;
  const record = (segmentEnd: number): void => {
    const segment = body.slice(segmentStart, segmentEnd).trim();
    segmentStart = segmentEnd + 1;
    const match = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(segment);
    if (match !== null) properties.set(match[1]!, match[2]!.trim());
  };
  for (let index = 0; index < body.length; ) {
    const char = body[index]!;
    if (char === "/" && (body[index + 1] === "/" || body[index + 1] === "*")) {
      index = skipOpencodePluginTrivia(body, index);
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipOpencodePluginQuoted(body, index);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) record(index);
    index += 1;
  }
  if (segmentStart < body.length) record(body.length);
  return properties;
}

/**
 * Único predicado oficial OpenCode (real, sin stubs de test).
 *
 * Reconoce la forma canónica del entrypoint nativo V2 que emite
 * `engram setup opencode` en la MISMA ruta: un `export default` cuyo objeto
 * declara `id: "engram"` y un `setup` con binding (la variante real incluye
 * además `server`). Es reconocimiento estático de forma, no autenticación del
 * publisher ni prueba de ABI/carga/protocolo. La instalación pertenece al
 * setup oficial; este lector no certifica autenticidad por igualdad de bytes.
 *
 * Los marcadores V1 sueltos (`ensureLocalReady`, `CONFIGURED_ENGRAM_URL`, …) ya
 * no acreditan: pueden aparecer en código ajeno o en comentarios. Por eso se
 * saltan comentarios y strings antes de buscar el entrypoint.
 */
export function isOfficialOpencodePluginContent(content: string): boolean {
  const body = readDefaultExportObjectBody(content);
  if (body === null) return false;
  const properties = readOpencodePluginTopLevelProperties(body);
  const id = properties.get("id");
  const setup = properties.get("setup");
  if (id === undefined || setup === undefined) return false;
  return /^(["'`])engram\1$/.test(id) && /^[A-Za-z_$][\w$]*$/.test(setup);
}

/**
 * Clasificación del plugin en la ruta compartida: `official` acredita el
 * setup oficial; `legacy-or-foreign` y `absent` no lo acreditan; `unknown`
 * indica que no se pudo leer. Solo `unknown` fuerza la preservación
 * fail-closed: nunca se clasifica como legacy ni se muta.
 */
export type OpencodePluginState = "official" | "legacy-or-foreign" | "absent" | "unknown";

export function inspectOpencodePluginFile(file: string): OpencodePluginState {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : "UNKNOWN";
    if (code === "ENOENT") return "absent";
    return "unknown";
  }
  return isOfficialOpencodePluginContent(content) ? "official" : "legacy-or-foreign";
}

export function inspectOpencodeEngramPlugin(configDir: string): OpencodePluginState {
  return inspectOpencodePluginFile(path.join(configDir, "plugins", "engram.ts"));
}


function readOpencodePluginFile(configDir: string): string | null {
  return readTextIfExists(path.join(configDir, "plugins", "engram.ts"));
}

/**
 * Lectura estructural estricta (JSONC válido, sin dependencias ni regex):
 * distingue ausente (ENOENT, se ignora) de ilegible/malformado/no-objeto.
 * Un archivo existente no verificable bloquea la verificación aunque otro
 * aporte capas: no se puede descartar conflicto ni duplicado oculto.
 */
export type OpencodeConfigRead =
  | { file: string; status: "absent" }
  | { file: string; status: "ok"; parsed: Record<string, unknown> }
  | { file: string; status: "unverifiable"; reason: string };

export function readOpencodeConfigFile(file: string): OpencodeConfigRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : "UNKNOWN";
    if (code === "ENOENT") return { file, status: "absent" };
    return { file, status: "unverifiable", reason: `${file}: ilegible (${code})` };
  }
  const parsed = parseJsoncObject(raw);
  if (parsed.value === null) {
    return { file, status: "unverifiable", reason: `${file}: JSONC malformado (${parsed.error ?? "desconocido"})` };
  }
  return { file, status: "ok", parsed: parsed.value };
}

function readExistingOpencodeConfigs(configDir: string): Array<Extract<OpencodeConfigRead, { status: "ok" }>> {
  const out: Array<Extract<OpencodeConfigRead, { status: "ok" }>> = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const read = readOpencodeConfigFile(path.join(configDir, name));
    if (read.status === "ok") out.push(read);
  }
  return out;
}

/**
 * Razones unverifiable de los cuatro archivos inspeccionados. Cualquier
 * archivo existente no verificable estructuralmente bloquea el setup oficial.
 */
export function collectUnverifiableOpencodeConfigs(configDir: string): string[] {
  const reasons: string[] = [];
  for (const name of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"]) {
    const read = readOpencodeConfigFile(path.join(configDir, name));
    if (read.status === "unverifiable") reasons.push(read.reason);
  }
  return reasons;
}

function isExactOpencodeEngramMcpValue(value: unknown, engramBin?: string): boolean {
  const record = objectValue(value);
  if (record === null) return false;
  if (record["type"] !== "local") return false;
  if (Object.hasOwn(record, "disabled") && typeof record["disabled"] !== "boolean") return false;
  if (Object.hasOwn(record, "enabled") && typeof record["enabled"] !== "boolean") return false;
  // Entrada efectivamente habilitada: un servidor nativo `disabled: true` o
  // legacy `enabled: false` no acredita el MCP activo.
  if (record["disabled"] === true || record["enabled"] === false) return false;
  const command = record["command"];
  if (!Array.isArray(command) || command.length !== 3) return false;
  if (command[1] !== "mcp" || command[2] !== "--tools=agent") return false;
  if (typeof command[0] !== "string") return false;
  // Bin vacío nunca acredita (paridad Claude/Codex fail-closed); se exige
  // ruta exacta. Sin bin (chequeos internos de retiro) vale substring.
  if (engramBin === "") return false;
  if (engramBin !== undefined) return command[0] === engramBin;
  return (command[0] as string).includes("engram");
}

/**
 * MCP Engram efectivo en opencode.json/jsonc: contenedor nativo
 * `mcp.servers.engram` (precedencia) y legacy `mcp.engram`. Solo JSON
 * estructural válido acredita; JSON truncado/malformado o fragmentos sueltos
 * en JSONC ilegible fallan cerrados (sin regex).
 */
export function checkOpencodeOfficialMcp(configDir: string, engramBin?: string): boolean {
  for (const { parsed } of readExistingOpencodeConfigs(configDir)) {
    const mcp = objectValue(parsed["mcp"]);
    if (mcp === null) continue;
    const servers = objectValue(mcp["servers"]);
    // `mcp.servers.engram` es autoritativo cuando la clave existe (el host
    // nativo la hace prevalecer): aunque esté deshabilitada o malformada no se
    // cae al duplicado legacy habilitado. El legacy solo decide su ausencia.
    if (servers !== null && Object.prototype.hasOwnProperty.call(servers, "engram")) {
      if (isExactOpencodeEngramMcpValue(servers["engram"], engramBin)) return true;
      continue;
    }
    if (isExactOpencodeEngramMcpValue(mcp["engram"], engramBin)) return true;
  }
  return false;
}

export function checkOpencodeDuplicates(configDir: string): boolean {
  for (const { parsed } of readExistingOpencodeConfigs(configDir)) {
    const plugin = parsed["plugin"];
    if (Array.isArray(plugin) && plugin.some((entry) => typeof entry === "string" && /engram/i.test(entry))) {
      return true;
    }
  }
  return false;
}

/**
 * Verificador oficial OpenCode por capas (solo lectura, registrado en T12).
 * Capas: plugin (misma ruta, contenido oficial vs legacy canónico) y MCP
 * efectivo (nativo/legacy, habilitado). El statusline
 * `opencode-subagent-statusline` retirado no es requisito de verificación V2.
 * Preserva JSONC/config ajena; sin claim de carga en runtime.
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
  const duplicates = checkOpencodeDuplicates(args.configDir);
  const unverifiable = collectUnverifiableOpencodeConfigs(args.configDir);
  const passed: string[] = [];
  const missing: string[] = [];
  if (hasPlugin) passed.push("plugin");
  else missing.push(plugin === null ? "plugin:missing" : "plugin:legacy-or-foreign");
  if (hasMcp) passed.push("mcp");
  else missing.push("mcp:missing");
  if (duplicates) missing.push("duplicates:detected");
  if (unverifiable.length > 0) missing.push("config:unverifiable");
  if (missing.length === 0) {
    return { ok: true, layers: passed, duplicates: false };
  }
  const reason = duplicates && unverifiable.length === 0
    ? `OpenCode: setup oficial Engram con plugin Engram duplicado; se conserva sin reclamar.`
    : unverifiable.length > 0
      ? `OpenCode: setup oficial Engram no verificable (${unverifiable.join("; ")}).`
      : `OpenCode: setup oficial Engram incompleto (falta: ${missing.join(", ")}).`;
  return {
    ok: false,
    layers: [...passed, ...missing],
    duplicates,
    reason,
  };
}

registerOfficialSetupVerifier("opencode", verifyOfficialSetup);
