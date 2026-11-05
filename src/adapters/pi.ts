import { editJsonc, upsertJson } from "../lib/filemerge.js";
import { readTextIfExists } from "../lib/fsx.js";
import { planOwnedProjection } from "../lib/owned-projection.js";
import fs from "node:fs";
import path from "node:path";
import { BROWSER_CONTROL_GUIDANCE, BROWSER_CONTROL_INCOMPATIBLE_WARNING, isBrowserControlCommand, SECRET_PATH_EXCEPTION, SECRET_PATH_PATTERNS } from "../lib/canonical.js";
import type { Adapter, FileAction, InstallContext } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";
import { detectPi } from "../lib/detect.js";
import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";
const SUBAGENT_CONFIG = "extensions/subagent/config.json";
const SUBAGENT_TIMEOUT_FIELD = JSON.stringify([SUBAGENT_CONFIG, "timeoutMs"]);
const SUBAGENT_TIMEOUT_MS = 7200000;
const PERMISSION_CONFIG = "extensions/pi-permission-system/config.json";
const SETTINGS_FILE = "settings.json";
/** pi-subagents' built-ins start with `inheritSkills: false`; delegation needs this leaf. */
const INHERIT_SKILLS_FIELD = JSON.stringify([SETTINGS_FILE, "subagents", "agentOverrides", "delegate", "inheritSkills"]);

/**
 * Política nativa fresh: `yoloMode` aprueba los ask y conserva los deny
 * explícitos; `bash` se declara aparte porque el proveedor avisa si solo
 * hereda del `*` superior.
 */
function freshPermissionPolicy(): string {
  const secrets = Object.fromEntries(SECRET_PATH_PATTERNS.map((pattern) => [pattern, "deny"]));
  return JSON.stringify({
    $schema: "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
    yoloMode: true,
    permission: {
      "*": "allow",
      path: { "*": "allow", ...secrets, [SECRET_PATH_EXCEPTION]: "allow" },
      bash: { "*": "allow" },
      external_directory: "allow",
    },
  }, null, 2) + "\n";
}

function readSubagentConfig(file: string) {
  const raw = readTextIfExists(file);
  const config: unknown = raw === null ? {} : JSON.parse(raw);
  if (!isRecord(config)) throw new Error("Pi: configuración nativa de subagentes inválida (contenido omitido).");
  return { raw, config };
}

/**
 * Pi no hereda el catálogo de skills en sus subagentes built-in. Se activa una sola
 * hoja, sin reescribir un valor existente ni reclamar el archivo completo.
 */
function setDelegateSkills(root: Record<string, unknown>): void {
  const subs = (root.subagents ??= {}) as Record<string, unknown>;
  const ov = (subs.agentOverrides ??= {}) as Record<string, unknown>;
  const del = (ov.delegate ??= {}) as Record<string, unknown>;
  del.inheritSkills = true;
}

function planSkillVisibility(ctx: InstallContext): FileAction[] {
  const target = path.join(ctx.configDir, SETTINGS_FILE);
  let raw: string | null;
  try { raw = readTextIfExists(target); }
  catch { throw new Error("Pi: no se puede leer settings.json; revisa ruta/permisos. No se modifica."); }
  let settings: unknown = {};
  if (raw !== null && raw.trim() !== "") {
    try { settings = JSON.parse(raw); }
    catch { throw new Error("Pi: settings.json no es JSON válido; corrige o restaura antes de editar."); }
  }
  if (!isRecord(settings)) throw new Error("Pi: settings.json debe ser un objeto; corrígelo antes de reintentar.");
  const subagents = settings.subagents;
  if (subagents !== undefined && !isRecord(subagents)) throw new Error("Pi: 'subagents' debe ser un objeto; corrígelo antes de reintentar.");
  const overrides = subagents?.agentOverrides;
  if (overrides !== undefined && !isRecord(overrides)) throw new Error("Pi: 'subagents.agentOverrides' debe ser un objeto; corrígelo antes de reintentar.");
  const delegate = overrides?.delegate;
  if (delegate !== undefined && !isRecord(delegate)) throw new Error("Pi: 'subagents.agentOverrides.delegate' debe ser un objeto; corrígelo antes de reintentar.");
  const current = delegate?.inheritSkills;
  if (current !== undefined) {
    if (current !== true) ctx.warnings.push("Pi: 'subagents.agentOverrides.delegate.inheritSkills' ya está definido sin true; se conserva y los subagentes podrían no ver las skills. Revísalo si delegas roles.");
    return [];
  }
  return [{
    kind: "write",
    target,
    content: raw === null ? upsertJson(null, (root) => { setDelegateSkills(root); }) : editJsonc(raw, (root) => { setDelegateSkills(root); }),
    configOwnership: [{ field: INHERIT_SKILLS_FIELD, owned: true }],
  }];
}

export function piSystemPromptFile(targetDir?: string): string {
  const configDir = targetDir === undefined
    ? process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent")
    : path.join(path.resolve(targetDir), "pi-agent");
  return path.join(configDir, "AGENTS.md");
}

/**
 * Proyección mínima de los recursos compartidos que Pi consume fuera de su
 * paquete nativo; el registro gestionado del runtime se mantiene en su
 * lifecycle nativo.
 */
export const piAdapter: Adapter = {
  id: "pi",
  name: "Pi",
  detect: detectPi,
  adaptSystemPromptSections(sections, ctx) {
    return ctx.browserControlInvocation ? { ...sections, browser: [sections.browser, BROWSER_CONTROL_GUIDANCE].filter(Boolean).join("\n\n") } : sections;
  },
  planUnmerge(canonical, ctx) {
    const prompt = path.join(ctx.configDir, "AGENTS.md");
    const actions: FileAction[] = [{ kind: "write", target: prompt, content: removeSystemPromptSections(readTextIfExists(prompt) ?? "") }];
    const target = path.join(ctx.configDir, "mcp.json");
    const raw = readTextIfExists(target);
    if (raw !== null) actions.push({ kind: "write", target, content: editJsonc(raw, (root) => {
      if (!isRecord(root.mcpServers)) throw new Error("Pi: mcpServers inválido; se conserva.");
      for (const name of ctx.ownedMcpServers ?? []) {
        const current = root.mcpServers[name];
        if (!isRecord(current)) continue;
        const canonicalContext = { url: canonical.servers.context7?.url, headers: { CONTEXT7_API_KEY: "" } };
        const canonicalBrowser = { command: "browser-control-mcp", args: [] };
        const expected = name === "context7" ? canonicalContext : name === "browser-control" ? canonicalBrowser : null;
        if (expected && JSON.stringify(current) === JSON.stringify(expected)) delete root.mcpServers[name];
      }
    }) });
    if (ctx.ownedConfigFields?.has(INHERIT_SKILLS_FIELD)) {
      const target = path.join(ctx.configDir, SETTINGS_FILE);
      const raw = readTextIfExists(target);
      let settings: unknown;
      try { settings = raw === null ? null : JSON.parse(raw); } catch { settings = null; }
      const subs = isRecord(settings) ? settings.subagents : undefined;
      const ov = isRecord(subs) ? subs.agentOverrides : undefined;
      const del = isRecord(ov) ? ov.delegate : undefined;
      if (raw !== null && isRecord(del) && del.inheritSkills === true) actions.push({
        kind: "write", target,
        content: upsertJson(raw, (root) => {
          const subs = root.subagents as Record<string, unknown>;
          const ov = subs.agentOverrides as Record<string, unknown>;
          const del = ov.delegate as Record<string, unknown>;
          delete del.inheritSkills;
          if (Object.keys(del).length === 0) delete ov.delegate;
          if (Object.keys(ov).length === 0) delete subs.agentOverrides;
          if (Object.keys(subs).length === 0) delete root.subagents;
        }),
        configOwnership: [{ field: INHERIT_SKILLS_FIELD, owned: false }],
      });
    }
    if (ctx.ownedConfigFields?.has(SUBAGENT_TIMEOUT_FIELD)) {
      const target = path.join(ctx.configDir, SUBAGENT_CONFIG);
      const { raw, config } = readSubagentConfig(target);
      if (raw !== null) actions.push({
        kind: "write", target,
        content: config.timeoutMs === SUBAGENT_TIMEOUT_MS ? editJsonc(raw, (root) => { delete root.timeoutMs; }) : raw,
        configOwnership: [{ field: SUBAGENT_TIMEOUT_FIELD, owned: false }],
      });
    }
    return actions;
  },

  paths(configDir) {
    const piConfigDir = path.dirname(piSystemPromptFile());
    const agentsHome = samePath(configDir, piConfigDir) ? HOME : path.dirname(configDir);
    return {
      systemPromptFile: path.join(configDir, "AGENTS.md"),
      skillsDir: path.join(agentsHome, ".agents", "skills"),
      pluginsDir: null,
      scriptsDir: path.join(configDir, "scripts"),
    };
  },

  planAdditionalResources(ctx) {
    const source = path.join(ctx.stackDir, "assets", "pi", "jorgex-header.ts");
    fs.readFileSync(source);
    return planOwnedProjection({ kind: "copy", source, target: path.join(ctx.configDir, "extensions", "jorgex-header.ts") }, ctx);
  },

  planMainConfig(canonical, ctx) {
    const target = path.join(ctx.configDir, "mcp.json");
    let created = false;
    const content = upsertJson(readTextIfExists(target), (root) => {
      root.mcpServers ??= {};
      if (!isRecord(root.mcpServers)) throw new Error(`Pi: mcpServers inválido en ${target}`);
      if (root.mcpServers.context7 !== undefined) {
        if (!isRecord(root.mcpServers.context7) || root.mcpServers.context7.url !== canonical.servers.context7?.url) throw new Error(`Pi: Context7 incompatible en ${target}`);
        return;
      }
      const server = canonical.servers.context7;
      if (!server || server.transport !== "http" || !server.url) throw new Error("Pi: falta Context7 HTTP canónico");
      root.mcpServers.context7 = { url: server.url, headers: { CONTEXT7_API_KEY: "" } };
      created = true;
    });
    const ownership = created ? [{ server: "context7", owned: true }] : [];
    const nativeContent = ctx.browserControlInvocation ? upsertJson(content, (root) => {
      const servers = root.mcpServers as Record<string, unknown>;
      if (servers["browser-control"] === undefined) {
        servers["browser-control"] = { command: ctx.browserControlInvocation!.command, args: [...ctx.browserControlInvocation!.args] };
        ownership.push({ server: "browser-control", owned: true });
      } else {
        const current = servers["browser-control"];
        if (!isRecord(current) || !isBrowserControlCommand(current.command, ctx.browserControlInvocation!.command) || JSON.stringify(current.args ?? []) !== JSON.stringify(ctx.browserControlInvocation!.args) || current.enabled === false || current.disabled === true) {
          ctx.warnings.push(`Pi: ${BROWSER_CONTROL_INCOMPATIBLE_WARNING}`);
          // Sin launcher equivalente tampoco se proyecta la guía que lo anuncia.
          ctx.browserControlInvocation = undefined;
        }
      }
    }) : content;
    const subagentTarget = path.join(ctx.configDir, SUBAGENT_CONFIG);
    const { raw, config } = readSubagentConfig(subagentTarget);
    const subagentActions: FileAction[] = Object.hasOwn(config, "timeoutMs") ? [] : [{
      kind: "write", target: subagentTarget,
      content: raw === null
        ? upsertJson(null, (root) => { root.timeoutMs = SUBAGENT_TIMEOUT_MS; })
        : editJsonc(raw, (root) => { root.timeoutMs = SUBAGENT_TIMEOUT_MS; }),
      configOwnership: [{ field: SUBAGENT_TIMEOUT_FIELD, owned: true }],
    }];
    // Solo si falta: una política existente nunca se reescribe ni se reclama.
    const permissionTarget = path.join(ctx.configDir, PERMISSION_CONFIG);
    const permissionActions: FileAction[] = fs.lstatSync(permissionTarget, { throwIfNoEntry: false }) === undefined
      ? [{ kind: "write", target: permissionTarget, content: freshPermissionPolicy() }]
      : [];
    if (permissionActions.length > 0) {
      ctx.warnings.push("Pi: fresh permission policy enables yoloMode and denies only secret paths; enforcement belongs to the native extension and is not a sandbox.");
    }
    return [{ kind: "write", target, content: nativeContent, mcpOwnership: ownership }, ...subagentActions, ...permissionActions, ...planSkillVisibility(ctx)];
  },


};


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function verifyOfficialSetup(args: { configDir: string }): Promise<{ ok: boolean; layers: string[]; duplicates: boolean }> {
  const raw = readTextIfExists(path.join(args.configDir, "settings.json"));
  const settings: unknown = raw === null ? {} : JSON.parse(raw);
  const packages = isRecord(settings) && Array.isArray(settings.packages) ? settings.packages : [];
  const gentle = packages.filter((entry: unknown) => (typeof entry === "string" ? entry : isRecord(entry) ? entry.source : undefined) === "npm:gentle-engram");
  return { ok: gentle.length === 1, layers: [gentle.length === 1 ? "native-package" : "native-package:missing-or-pinned"], duplicates: gentle.length > 1 };
}
registerOfficialSetupVerifier("pi", verifyOfficialSetup);
