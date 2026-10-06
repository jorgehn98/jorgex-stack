import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import type { Adapter, FileAction, InstallContext, OpenCodeTargetEvidenceOption, RuntimeId } from "./adapters/types.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { piAdapter } from "./adapters/pi.js";
import { HOME, dataDir, samePath, stackRoot } from "./lib/paths.js";
import { detectEngram, engramVersion, lookPath, opencodeMajorVersion, planDetectedBinCommand } from "./lib/detect.js";
import { isContainedIn, readTextIfExists, sameFileContent, writeText } from "./lib/fsx.js";
import { removeNativeHooks } from "./lib/hooks-format.js";
import { createBackup } from "./lib/backup.js";
import { loadCanonicalMcp } from "./lib/canonical.js";
import { planAgents } from "./components/agents.js";
import { planSkills } from "./components/skills.js";
import { planSystemPrompt } from "./components/system-prompt.js";
import { planOwnedProjection } from "./lib/owned-projection.js";
import { readManifest, writeRuntimeManifest, type RuntimeManifest } from "./lib/manifest.js";
import { officialSetupVerifiers } from "./lib/official-engram-setup.js";
import { editJsonc, parseJsoncObject } from "./lib/filemerge.js";
import { installMissingEngram } from "./lib/engram-install.js";
import { prepareWritingStyle, applyWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot, type WritingStylePlan } from "./lib/writing-style.js";
import type { AgentModelChoices } from "./lib/agent-model.js";
import { includesOwnedFile, type OperationScope } from "./lib/operation-scope.js";

export const ADAPTERS: Record<RuntimeId, Adapter> = { "claude-code": claudeCodeAdapter, codex: codexAdapter, opencode: opencodeAdapter, pi: piAdapter };
export const PI_PACKAGES = ["pi-subagents", "@juicesharp/rpiv-ask-user-question", "pi-web-access", "@gotgenes/pi-permission-system", "gentle-engram", "@narumitw/pi-goal", "compact-tools"] as const;
export type NativeExecutor = (command: string, args: string[], env?: NodeJS.ProcessEnv) => string;
/** Only explicit lifecycle operations use this executor. No subprocess output is logged. */
export const executeNative: NativeExecutor = (bin, args, env) => {
  const invocation = planDetectedBinCommand(bin, args);
  if (!invocation) throw new Error("Invocación nativa no segura en esta plataforma.");
  try {
    return execFileSync(invocation.command, invocation.args, { env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch { throw new Error(`Falló ${path.basename(bin)} ${args.slice(0, 2).join(" ")}; revisa el proveedor. Puede haber cambios parciales.`); }
};
const BROWSER_CONTROL_BIN = "browser-control-mcp";
/**
 * Browser Control es opcional: una copia ya resoluble en el PATH se respeta sea
 * cual sea su gestor, y un fallo de instalación se devuelve como causa en lugar
 * de abortar la unidad. Cadena vacía significa disponible.
 */
function ensureBrowserControl(execute: NativeExecutor): string {
  if (lookPath(BROWSER_CONTROL_BIN)) return "";
  const pnpm = lookPath("pnpm");
  if (!pnpm) return "falta en el PATH y pnpm tampoco está disponible para instalarlo";
  try { execute(pnpm, ["add", "--global", "@opencode-ai/browser-control@latest"]); return ""; }
  catch { return "falló `pnpm add --global`; la causa probable es que pnpm no tiene directorio global configurado (ERR_PNPM_NO_GLOBAL_BIN_DIR)"; }
}
export interface InstallOptions extends OpenCodeTargetEvidenceOption {
  runtimes: RuntimeId[];
  scope?: OperationScope;
  targetDir?: string;
  dryRun: boolean;
  yes: boolean;
  writingStyle?: WritingStyleSnapshot;
  engram?: boolean;
  engramBin?: string | null;
  backupEngramData?: boolean;
  command?: "install" | "update";
  execute?: NativeExecutor;
  detect?: (runtime: RuntimeId) => ReturnType<Adapter["detect"]>;
  verifyEngram?: (runtime: RuntimeId, configDir: string, bin: string) => Promise<boolean>;
  onRuntimeStatus?: (runtime: string, status: RuntimeSyncStatus) => void;
}
export type RuntimeSyncStatus = "ok" | "failed" | "skipped" | "preview";
export function stateDirectory(targetDir?: string): string { return targetDir ? path.join(path.resolve(targetDir), ".jorgex-stack") : dataDir(); }
export function configDirectory(id: RuntimeId, targetDir?: string): string {
  return targetDir ? path.join(path.resolve(targetDir), id === "pi" ? "pi-agent" : id) : ADAPTERS[id].detect().configDir;
}
export function makeContext(adapter: Adapter, configDir: string, targetDir?: string): InstallContext & { writingStyle: WritingStylePlan } {
  const manifest = readManifest(path.join(stateDirectory(targetDir), "manifest.json"));
  const previous = manifest.runtimes[adapter.id];
  if (previous && !samePath(previous.configDir, configDir)) throw new Error(`${adapter.id}: configDir difiere del manifest; se conserva el perfil anterior.`);
  return {
    stackDir: stackRoot(), configDir, targetDir, engramBin: targetDir ? null : detectEngram(),
    models: {} as AgentModelChoices, warnings: [],
    writingStyle: prepareWritingStyle(resolveWritingStyleFile({ targetDir }), { rootDir: targetDir }),
    ownedFiles: new Set(Object.values(manifest.runtimes).flatMap((row) => row?.owned ?? [])),
    ownedMcpServers: new Set(previous?.mcpOwned), ownedConfigFields: new Set(previous?.configOwned),
  };
}
export function buildContentPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [...planSystemPrompt(adapter, ctx), ...planAgents(adapter, ctx), ...planSkills(adapter, ctx), ...(adapter.planAdditionalResources?.(ctx) ?? []).flatMap((action) => planOwnedProjection(action, ctx))];
}
export function buildPlan(adapter: Adapter, ctx: InstallContext): FileAction[] {
  return [...adapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx), ...buildContentPlan(adapter, ctx)];
}
export function buildScopedPlan(adapter: Adapter, ctx: InstallContext, scope: OperationScope): FileAction[] {
  if (scope.section === "skills") return planSkills(adapter, ctx);
  if (scope.section === "agents") return planAgents(adapter, ctx, scope.agent);
  if (scope.section === "config") return [...adapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx), ...planSystemPrompt(adapter, ctx), ...(adapter.planAdditionalResources?.(ctx) ?? []).flatMap((action) => planOwnedProjection(action, ctx))];
  return buildPlan(adapter, ctx);
}
export type PlannedChange = { action: FileAction; status: "create" | "update" | "unchanged" };
export function assertProjectionPath(target: string, boundary: string): void {
  if (!isContainedIn(target, boundary)) throw new Error(`Target fuera del hogar seleccionado: ${target}`);
  let parent = path.dirname(path.resolve(target));
  const root = path.resolve(boundary);
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("El hogar/target no puede ser un enlace simbólico.");
  while (parent !== root && isContainedIn(parent, root)) {
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Ancestro enlazado: ${parent}`);
    parent = path.dirname(parent);
  }
}
export function diffPlan(plan: FileAction[]): PlannedChange[] {
  return plan.map((action) => {
    const stat = fs.lstatSync(action.target, { throwIfNoEntry: false });
    if (!stat) return { action, status: "create" };
    if (action.kind === "copy" && action.symlink) {
      if (!stat.isSymbolicLink() || path.resolve(path.dirname(action.target), fs.readlinkSync(action.target)) !== path.resolve(action.source)) throw new Error(`Enlace en conflicto: ${action.target}`);
      return { action, status: "unchanged" };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Target no regular: ${action.target}`);
    const equal = action.kind === "write" ? fs.readFileSync(action.target, "utf8") === action.content : sameFileContent(action.source, action.target);
    return { action, status: equal ? "unchanged" : "update" };
  });
}
export function applyChanges(changes: PlannedChange[], onWritten?: (action: FileAction) => void, onOwnershipWritten?: (action: FileAction) => void): void {
  for (const { action, status } of changes) {
    if (status === "unchanged") continue;
    fs.mkdirSync(path.dirname(action.target), { recursive: true });
    if (action.kind === "write") fs.writeFileSync(action.target, action.content, { encoding: "utf8", flag: status === "create" ? "wx" : "w" });
    else if (action.symlink) fs.symlinkSync(path.resolve(action.source), action.target, process.platform === "win32" ? "junction" : "dir");
    else fs.copyFileSync(action.source, action.target, status === "create" ? fs.constants.COPYFILE_EXCL : 0);
    onWritten?.(action);
    if (action.kind === "write") onOwnershipWritten?.(action);
  }
}
export function assertOpenCodeV2Preflight(opts: { targetDir?: string; opencodeTargetMajor?: number }, bin?: string | null): void {
  const major = opts.targetDir ? opts.opencodeTargetMajor ?? Number(process.env.JORGEX_OPENCODE_TARGET_MAJOR) : bin ? opencodeMajorVersion(bin) : null;
  if (major !== 2) throw new Error("OpenCode v2 requerido; no se escribe configuración.");
}

/** Setup's extra TUI monitor is not the memory plugin. Preserve every other entry. */
export function retireExtraEngramMonitor(configDir: string, backupsRoot: string, createdFiles: ReadonlySet<string> = new Set()): void {
  for (const name of ["tui.json", "tui.jsonc", "cli.json"]) {
    const target = path.join(configDir, name);
    const raw = readTextIfExists(target);
    if (raw === null) continue;
    const parsed = parseJsoncObject(raw);
    if (parsed.value === null) throw new Error(`OpenCode: configuración de cliente inválida (${name}).`);
    const key = name === "cli.json" ? "plugins" : "plugin";
    const plugins = parsed.value[key];
    if (plugins !== undefined && !Array.isArray(plugins)) throw new Error(`OpenCode: ${name}.${key} inválido.`);
    if (!Array.isArray(plugins)) continue;
    const kept = plugins.filter((entry) => typeof entry !== "string" || !/^opencode-subagent-statusline(?:@[^/]+)?$/.test(entry));
    if (kept.length === plugins.length) continue;
    createBackup([target], "engram-monitor", backupsRoot);
    const content = editJsonc(raw, (root) => { if (kept.length) root[key] = kept; else delete root[key]; });
    if (createdFiles.has(name) && Object.keys(parseJsoncObject(content).value!).length === 0) fs.unlinkSync(target);
    else writeText(target, content);
  }
}

/** Retire only registrations pointing to script files recorded as ours. Provider hooks are untouched. */
export function planRetiredHooks(adapter: Adapter, ctx: InstallContext, owned: readonly string[]): FileAction[] {
  const scriptsDir = adapter.paths(ctx.configDir).scriptsDir;
  const scripts = owned.filter((file) => isContainedIn(file, scriptsDir));
  if (!scripts.length) return [];
  const target = path.join(ctx.configDir, adapter.id === "claude-code" ? "settings.json" : "hooks.json");
  const raw = readTextIfExists(target);
  if (raw === null) return [];
  if (adapter.id === "opencode") return [{ kind: "write", target, content: editJsonc(raw, (root) => {
    const after = root["tool.execute.after"] as Record<string, unknown> | undefined;
    const bash = after?.bash as Record<string, unknown> | undefined;
    if (!bash || Array.isArray(bash)) return;
    const relative = new Set(scripts.map((file) => path.relative(ctx.configDir, file).replace(/\\/g, "/")));
    for (const [key, value] of Object.entries(bash)) if (Array.isArray(value)) {
      const kept = value.filter((entry) => typeof entry !== "string" || !relative.has(entry));
      if (kept.length) bash[key] = kept; else delete bash[key];
    }
  }) }];
  const commands = new Set(scripts.map((file) => `node "${file}"`));
  return [{ kind: "write", target, content: removeNativeHooks(raw, commands) ?? "" }];
}

export async function runInstall(opts: InstallOptions): Promise<number> {
  if (opts.targetDir && opts.runtimes.length !== 1) throw new Error("--target-dir requiere un runtime.");
  const state = stateDirectory(opts.targetDir);
  const manifestPath = path.join(state, "manifest.json");
  const execute = opts.execute ?? executeNative;
  let engram = opts.engramBin === undefined ? opts.targetDir ? null : detectEngram() : opts.engramBin;
  const scope = opts.scope ?? { section: "all" };
  const configSelected = scope.section === "all" || scope.section === "config";
  const deliberate = configSelected && !opts.dryRun && !opts.targetDir;
  let engramPrepared = false;
  if (!engram && opts.engram && deliberate) {
    const acquired = await installMissingEngram();
    if (!acquired.ok) { p.log.error(acquired.reason); return 1; }
    engram = acquired.bin;
    engramPrepared = true;
    if (acquired.warning) p.log.warn(acquired.warning);
  }
  let exitCode = 0;
  // undefined: sin comprobar (o ejecución sin efectos nativos); "": disponible; texto: causa del fallo.
  let browserControlProblem: string | undefined;
  let manifestBackedUp = false;
  for (const id of opts.runtimes) {
    const adapter = ADAPTERS[id];
    let phase = "preflight";
    try {
      const detection = (opts.detect ?? ((runtime) => ADAPTERS[runtime].detect()))(id);
      if (!opts.targetDir && !detection.binPath) throw new Error(`${adapter.name} ausente; instálalo por su canal oficial antes de continuar.`);
      const configDir = opts.targetDir ? configDirectory(id, opts.targetDir) : detection.configDir;
      const ctx: InstallContext = makeContext(adapter, configDir, opts.targetDir);
      ctx.engramBin = engram;
      const style = opts.writingStyle ?? ctx.writingStyle!;
      ctx.writingStyle = style;
      if (id === "opencode") assertOpenCodeV2Preflight(opts, detection.binPath);
      const old = readManifest(manifestPath).runtimes[id];
      const row: RuntimeManifest = { configDir, owned: [...old?.owned ?? []], mcpOwned: [...old?.mcpOwned ?? []], configOwned: [...old?.configOwned ?? []], packages: [...old?.packages ?? []], engram: old?.engram, updatedAt: old?.updatedAt ?? new Date().toISOString() };
      const persist = () => {
        if (JSON.stringify(readManifest(manifestPath).runtimes[id]) === JSON.stringify(row)) return;
        if (!manifestBackedUp) {
          createBackup([manifestPath], "manifest", path.join(state, "backups"));
          manifestBackedUp = true;
        }
        writeRuntimeManifest(id, row, manifestPath);
      };
      if (deliberate) {
        phase = "integraciones nativas";
        if (!engram) throw new Error("Engram binario ausente; instala el prerrequisito oficial o autoriza su instalación desde el menú.");
        if (!engramPrepared) {
          const currentBin = engram;
          const acquired = await installMissingEngram({
            updateBin: currentBin,
            installedVersion: engramVersion(currentBin),
            beforeUpdate: async (version) => {
              let approved = opts.backupEngramData;
              if (approved === undefined) {
                if (!process.stdin.isTTY) throw new Error("Engram requiere decisión explícita de respaldo antes de actualizar; no se modifica el binario.");
                const answer = await p.confirm({ message: `¿Exportar todas las memorias y actualizar Engram al release oficial ${version}?`, initialValue: true });
                approved = !p.isCancel(answer) && answer;
              }
              if (!approved) throw new Error("Engram: actualización cancelada; respaldo no autorizado. Sin cambios.");
              fs.mkdirSync(path.join(state, "backups"), { recursive: true });
              execute(currentBin, ["export", path.join(state, "backups", `engram-export-${Date.now()}.json`), "--all"]);
              createBackup([currentBin], "engram-binary", path.join(state, "backups"));
            },
          });
          if (!acquired.ok) { p.log.error(acquired.reason); opts.onRuntimeStatus?.(id, "failed"); return 1; }
          engram = acquired.bin;
          ctx.engramBin = engram;
          engramPrepared = true;
          if (acquired.warning) p.log.warn(acquired.warning);
        }
        const initialConfig = diffPlan(adapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx)).filter((change) => change.status !== "unchanged");
        for (const { action } of initialConfig) assertProjectionPath(action.target, HOME);
        createBackup(initialConfig.filter((change) => change.status === "update").map((change) => change.action.target), `config-${id}`, path.join(state, "backups"));
        applyChanges(initialConfig, (action) => {
          if (action.kind === "write") {
            for (const change of action.mcpOwnership ?? []) row.mcpOwned = change.owned ? [...new Set([...row.mcpOwned!, change.server])] : row.mcpOwned!.filter((name) => name !== change.server);
            for (const change of action.configOwnership ?? []) row.configOwned = change.owned ? [...new Set([...row.configOwned!, change.field])] : row.configOwned!.filter((name) => name !== change.field);
          }
          persist();
        });
        ctx.ownedMcpServers = new Set(row.mcpOwned);
        ctx.ownedConfigFields = new Set(row.configOwned);
        const bin = detection.binPath!;
        const nativeEnv: NodeJS.ProcessEnv = { ENGRAM_BIN: engram };
        if (id === "pi") {
          const raw = readTextIfExists(path.join(configDir, "settings.json"));
          const settings = raw ? JSON.parse(raw) : {};
          const packages: unknown[] = settings.packages ?? [];
          if (!Array.isArray(packages)) throw new Error("Pi: packages inválido.");
          const sources = packages.map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" && "source" in entry ? entry.source : null);
          createBackup([path.join(configDir, "settings.json")], "pi-packages", path.join(state, "backups"));
          for (const source of sources) {
            if (typeof source !== "string" || !/^npm:jorgex-pi(?:@|$)/.test(source)) continue;
            execute(bin, ["remove", source]);
            const remaining = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8")).packages;
            if (!Array.isArray(remaining) || remaining.some((entry) => {
              const value = typeof entry === "string" ? entry : entry?.source;
              return typeof value === "string" && /^npm:jorgex-pi(?:@|$)/.test(value);
            })) throw new Error("Pi: retirada nativa de jorgex-pi incompleta; se conserva el estado restante sin activar otra carga.");
          }
          execute(bin, ["update", "--all"]);
          for (const name of PI_PACKAGES) {
            const source = `npm:${name}`;
            execute(bin, ["install", source]);
            const readback = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8"));
            const recorded: unknown[] = readback.packages ?? [];
            if (!Array.isArray(recorded) || !recorded.some((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" && "source" in entry ? entry.source : null) === source)) throw new Error(`Pi: registro nativo incompleto para ${name}.`);
            if (!sources.some((value) => typeof value === "string" && (value === source || value.startsWith(`${source}@`))) && !row.packages!.includes(source)) { row.packages!.push(source); persist(); }
          }
          const mcpFile = path.join(configDir, "mcp.json");
          const rawMcp = readTextIfExists(mcpFile);
          if (rawMcp !== null) {
            const parsed = parseJsoncObject(rawMcp).value;
            if (!parsed) throw new Error("Pi: mcp.json inválido; se conserva sin retirar Engram.");
            const servers = parsed.mcpServers as Record<string, unknown> | undefined;
            const server = servers?.engram as { command?: string; args?: unknown } | undefined;
            if (server !== undefined) {
              if (server.command !== engram || JSON.stringify(server.args) !== '["mcp","--tools=agent"]') throw new Error("Pi: Engram MCP personalizado; retíralo explícitamente antes de activar tools nativas.");
              createBackup([mcpFile], "pi-engram-mcp", path.join(state, "backups"));
              writeText(mcpFile, editJsonc(rawMcp, (root) => { delete (root.mcpServers as Record<string, unknown>).engram; }));
            }
          }
        } else {
          if (id === "claude-code") execute(bin, ["update"]);
          if (id === "opencode") { execute(bin, ["upgrade"]); assertOpenCodeV2Preflight(opts, bin); }
          if (id === "codex") execute(bin, ["update"]);
          const backupTargets = fs.existsSync(configDir) ? fs.readdirSync(configDir).map((name) => path.join(configDir, name)).filter((file) => fs.lstatSync(file).isFile()) : [];
          backupTargets.push(path.join(configDir, "plugins", "engram.ts"));
          if (id === "claude-code") backupTargets.push(process.env.CLAUDE_CONFIG_DIR ? path.join(configDir, ".claude.json") : path.join(HOME, ".claude.json"));
          createBackup(backupTargets, "engram-setup", path.join(state, "backups"));
          const verify = opts.verifyEngram ?? (async (runtime, directory, engramBin) => (await officialSetupVerifiers[runtime]?.({ configDir: directory, engramBin, homeDir: HOME }))?.ok === true);
          const initial = opts.verifyEngram ? undefined : await officialSetupVerifiers[id]?.({ configDir, engramBin: engram, homeDir: HOME });
          const preexisting = opts.verifyEngram ? await verify(id, configDir, engram) : initial?.ok === true;
          const createdTui = new Set(["tui.json", "tui.jsonc"].filter((name) => !fs.existsSync(path.join(configDir, name))));
          execute(engram, ["setup", id], nativeEnv);
          if (id === "claude-code") { execute(bin, ["plugin", "marketplace", "update", "engram"]); execute(bin, ["plugin", "update", "engram"]); }
          if (id === "codex") { execute(bin, ["plugin", "marketplace", "upgrade", "engram"]); execute(bin, ["plugin", "add", "engram@engram"]); }
          if (!(await verify(id, configDir, engram))) throw new Error("Engram: setup incompleto; faltan capas oficiales, revisa doctor.");
          if (!preexisting && initial?.layers?.length && initial.layers.every((layer) => layer.includes(":missing"))) { row.engram = true; persist(); }
          if (id === "opencode") retireExtraEngramMonitor(configDir, path.join(state, "backups"), createdTui);
        }
        if (id === "pi" || id === "opencode") {
          browserControlProblem ??= ensureBrowserControl(execute);
          if (browserControlProblem) ctx.warnings.push(`Browser Control no disponible: ${browserControlProblem}. No se añade su MCP ni su guía; el resto de la configuración continúa. Remedio: ejecuta \`pnpm setup\`, reabre la shell y vuelve a aplicar, o instala @opencode-ai/browser-control con tu gestor preferido.`);
          else p.log.info("Browser Control: carga la extensión Chromium del proveedor y adjunta una pestaña explícitamente. Tras actualizar, recarga la extensión/reinicia el relay con el proveedor; Stack no detiene sesiones ajenas.");
        }
      }
      if ((id === "pi" || id === "opencode") && !browserControlProblem) ctx.browserControlInvocation = { command: BROWSER_CONTROL_BIN, args: [] };
      phase = "proyección";
      const selectedPlan = buildScopedPlan(adapter, ctx, scope);
      const plan = [...(configSelected ? planRetiredHooks(adapter, ctx, row.owned) : []), ...selectedPlan];
      const changes = diffPlan(plan).filter((change) => change.status !== "unchanged");
      for (const { action } of changes) assertProjectionPath(action.target, opts.targetDir ?? HOME);
      if (!opts.dryRun) {
        if (configSelected && "installedContent" in style) applyWritingStyle(style as ReturnType<typeof prepareWritingStyle>);
        createBackup(changes.filter((change) => change.status === "update").map((change) => change.action.target), `install-${id}`, path.join(state, "backups"));
        const shared = new Set(configSelected ? planSystemPrompt(adapter, ctx).map((action) => action.target) : []);
        const configTargets = new Set(configSelected ? adapter.planMainConfig(loadCanonicalMcp(ctx.stackDir), ctx).map((action) => action.target) : []);
        const ownedCandidates = new Set(selectedPlan.filter((action) => !shared.has(action.target) && !configTargets.has(action.target)).map((action) => action.target));
        applyChanges(changes, (action) => {
          if (ownedCandidates.has(action.target) && !row.owned.includes(action.target)) row.owned.push(action.target);
          if (action.kind === "write") {
            for (const change of action.mcpOwnership ?? []) row.mcpOwned = change.owned ? [...new Set([...row.mcpOwned!, change.server])] : row.mcpOwned!.filter((name) => name !== change.server);
            for (const change of action.configOwnership ?? []) row.configOwned = change.owned ? [...new Set([...row.configOwned!, change.field])] : row.configOwned!.filter((name) => name !== change.field);
          }
          persist();
        });
        // An existing Stack-owned shared file is a reference, never a claim by equality.
        for (const target of ownedCandidates) if (ctx.ownedFiles?.has(target) && !row.owned.includes(target)) row.owned.push(target);
        const keep = new Set([...plan.map((action) => action.target), ...Object.entries(readManifest(manifestPath).runtimes).filter(([runtime]) => runtime !== id).flatMap(([, entry]) => entry?.owned ?? [])]);
        for (const orphan of [...row.owned]) {
          if (!includesOwnedFile(adapter, ctx, scope, orphan) || keep.has(orphan) || path.basename(orphan) === "engram.ts") continue;
          assertProjectionPath(orphan, opts.targetDir ?? HOME);
          if (fs.lstatSync(orphan, { throwIfNoEntry: false })) { createBackup([orphan], `retired-${id}`, path.join(state, "backups")); fs.unlinkSync(orphan); }
          row.owned = row.owned.filter((file) => file !== orphan);
          persist();
        }
        persist();
      }
      for (const warning of ctx.warnings) p.log.warn(warning);
      opts.onRuntimeStatus?.(id, opts.dryRun ? "preview" : "ok");
    } catch (error) {
      exitCode = 1;
      opts.onRuntimeStatus?.(id, "failed");
      p.log.error(`${id}: ${phase} incompleta. ${error instanceof SyntaxError ? "Configuración JSON inválida (contenido omitido)." : error instanceof Error && "code" in error ? "Error de filesystem; revisa ruta/permisos sin volcar configuración." : error instanceof Error ? error.message : "Fallo de configuración"} Se conservan los cambios completados; no hay rollback global.`);
    }
  }
  return exitCode;
}
