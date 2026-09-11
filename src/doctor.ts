import path from "node:path";
import fs from "node:fs";
import * as p from "@clack/prompts";
import type { InstallModePreference, RuntimeId, SelectableRuntimeId } from "./adapters/types.js";
import { ADAPTERS, buildPlan, collectAllCurrentTargets, diffPlan, makeContext } from "./install.js";
import { detectEngram, runDetectedBin } from "./lib/detect.js";
import { readTextIfExists } from "./lib/fsx.js";
import { DEFAULT_INSTALL_MODE_PREFERENCE, loadInstallModePreference } from "./lib/install-mode.js";
import { findOrphans, readManifest } from "./lib/manifest.js";
import { modelMapFile } from "./lib/model-map.js";
import { piAdapter } from "./adapters/pi.js";
import { hasHealthyManagedMarkdownMarkers, upsertMarkdownSection } from "./lib/filemerge.js";
import { readWritingStyle, renderWritingStyle, resolveWritingStyleFile, type WritingStyleSnapshot } from "./lib/writing-style.js";
import { HOME } from "./lib/paths.js";
import {
  detectPlaywrightCli,
  isPlaywrightBrowserReady,
  type PlaywrightBrowserCacheState,
  type PlaywrightCliStatus,
} from "./lib/external-tools.js";
import { browserPreferenceErrors, loadPlaywrightCliPreference, primaryModelOwnershipError } from "./lib/tool-preferences.js";

export function engramVersion(bin: string): string | null {
  const out = runDetectedBin(bin, ["--version"], 5_000);
  if (out === null) return null;
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? out.trim().split("\n")[0] ?? null;
}

export interface PlaywrightDoctorState {
  enabled: boolean | undefined;
  cli: { status: PlaywrightCliStatus };
  browserReady: boolean;
  browserCache?: PlaywrightBrowserCacheState;
}

export interface ResolvedPlaywrightDoctorState {
  status: "disabled" | "healthy" | "missing" | "broken" | "outdated" | "unreadable" | "not-in-path";
  missing?: "package" | "browser";
  path?: string;
  errorCode?: string;
}

/** Clasifica el requisito opcional sin I/O para conservar los estados accionables. */
export function resolvePlaywrightDoctorState(input: PlaywrightDoctorState): ResolvedPlaywrightDoctorState {
  if (input.enabled !== true) return { status: "disabled" };
  if (input.cli.status === "not-in-path") return { status: "not-in-path" };
  if (input.cli.status === "absent") return { status: "missing", missing: "package" };
  if (input.cli.status === "broken") return { status: "broken" };
  if (input.cli.status === "outdated") return { status: "outdated" };
  if (input.browserCache?.status === "unreadable") {
    return { status: "unreadable", path: input.browserCache.path, errorCode: input.browserCache.errorCode };
  }
  if (!input.browserReady) return { status: "missing", missing: "browser" };
  return { status: "healthy" };
}

/** Dónde mirar la key de context7 en la config de cada runtime. */
function context7KeyConfigured(id: RuntimeId, configDir: string): boolean | null {
  const file =
    id === "codex"
      ? path.join(configDir, "config.toml")
      : id === "claude-code"
        ? path.join(path.dirname(configDir), `${path.basename(configDir)}.json`)
        : path.join(configDir, "opencode.json");
  const content = readTextIfExists(file);
  if (content === null) return null;
  const match = /CONTEXT7_API_KEY"?\s*[:=]\s*"([^"]*)"/.exec(content);
  if (!match) return null;
  return match[1] !== "";
}

export interface DoctorOptions {
  mode?: InstallModePreference;
  targetDir?: string;
  runtimes?: SelectableRuntimeId[];
}

function reportWritingStyle(options: DoctorOptions, style: WritingStyleSnapshot, mode: InstallModePreference): number {
  let problems = 0;
  p.log.info(`Estilo: ${style.content === null ? "desactivado" : "activo configurado"}; fuente ${style.sourcePath}; tamaño ${Buffer.byteLength(style.content ?? "", "utf8")} bytes de texto normalizado. La carga nativa no está verificada.`);
  const expected = style.content !== null && mode.mode !== "programmatic"
    ? upsertMarkdownSection(null, "writing-style", renderWritingStyle(style.content)).trim()
    : null;
  const runtimes = options.runtimes ?? Object.values(ADAPTERS).filter((adapter) => options.targetDir !== undefined || adapter.detect().installed).map((adapter) => adapter.id);
  for (const id of runtimes) {
    const adapter = id === "pi" ? piAdapter : ADAPTERS[id];
    if (adapter === undefined) continue;
    const configDir = id === "pi"
      ? options.targetDir === undefined
        ? process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent")
        : path.join(options.targetDir, "pi-agent")
      : options.targetDir ?? ADAPTERS[id as RuntimeId]!.detect().configDir;
    const file = adapter.paths(configDir).systemPromptFile;
    try {
      const content = readTextIfExists(file) ?? "";
      const open = "<!-- jorgex:writing-style -->";
      const close = "<!-- /jorgex:writing-style -->";
      const healthy = hasHealthyManagedMarkdownMarkers(content, "writing-style");
      const block = healthy ? content.slice(content.indexOf(open), content.indexOf(close) + close.length) : null;
      const matches = expected === null
        ? !content.includes(open) && !content.includes(close)
        : healthy && block === expected;
      if (matches) p.log.success(`${id}: proyección de estilo coincide (${file})${mode.mode === "programmatic" ? "; omitida en modo programmatic" : ""}.`);
      else {
        p.log.warn(`${id}: proyección de estilo desactualizada o ausente (${file}); ejecuta sync.`);
        problems++;
      }
      if (id === "codex") {
        const override = path.join(configDir, "AGENTS.override.md");
        if ((readTextIfExists(override) ?? "").trim() !== "") {
          p.log.warn(`Codex: ${override} no vacío puede ocultar el AGENTS.md gestionado; revísalo sin modificarlo automáticamente.`);
          problems++;
        }
      }
    } catch {
      p.log.error(`${id}: no se puede leer la proyección de estilo o su override en ${configDir}; revisa archivos y permisos.`);
      problems++;
    }
  }
  return problems;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  p.intro("jorgex-stack doctor");
  let writingStyle: WritingStyleSnapshot;
  let modePreference: InstallModePreference;
  try {
    writingStyle = readWritingStyle(resolveWritingStyleFile({ targetDir: options.targetDir }), { rootDir: options.targetDir });
    modePreference = options.mode ?? (options.targetDir === undefined ? loadInstallModePreference() : DEFAULT_INSTALL_MODE_PREFERENCE);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro("No se puede diagnosticar el estilo; corrige la fuente o la preferencia indicada.");
    return 1;
  }
  let problems = reportWritingStyle(options, writingStyle, modePreference);
  if (options.targetDir !== undefined || options.runtimes?.every((id) => id === "pi")) {
    p.outro("Diagnóstico limitado al estilo; no se han ejecutado las comprobaciones globales del sistema.");
    return problems > 0 ? 1 : 0;
  }

  // Engram (D7): se informa, jamás se toca.
  const engramBin = detectEngram();
  if (engramBin === null) {
    p.log.warn("Engram: NO detectado. El protocolo de memoria no funcionará — instálalo: github.com/Gentleman-Programming/engram");
    problems++;
  } else {
    const version = engramVersion(engramBin);
    if (version === null) {
      p.log.error(`Engram: binario en ${engramBin} pero no responde a --version.`);
      problems++;
    } else {
      p.log.success(`Engram: ${version} (${engramBin})`);
    }
  }
  const engramDataDir = process.env.ENGRAM_DATA_DIR ?? path.join(HOME, ".engram");
  const engramDb = path.join(engramDataDir, "engram.db");
  if (fs.existsSync(engramDb)) {
    const sizeMb = (fs.statSync(engramDb).size / 1024 / 1024).toFixed(1);
    p.log.info(`Engram DB: ${engramDb} (${sizeMb} MB de memorias — el stack no la toca JAMÁS).`);
  }

  if (!fs.existsSync(modelMapFile())) p.log.info("model-map: aún no creado (se crea en el primer install o con 'models').");

  const preferenceErrors = browserPreferenceErrors();
  const primaryOwnershipError = primaryModelOwnershipError();
  if (primaryOwnershipError !== null) {
    p.log.error(primaryOwnershipError);
    problems++;
  }
  if (preferenceErrors.length > 0) {
    for (const error of preferenceErrors) p.log.error(error);
    problems += preferenceErrors.length;
  } else {
    const browserCache = isPlaywrightBrowserReady();
    const playwright = resolvePlaywrightDoctorState({
      enabled: loadPlaywrightCliPreference(),
      cli: detectPlaywrightCli(),
      browserReady: browserCache.status === "ready",
      browserCache,
    });
    if (playwright.status === "disabled") {
      p.log.info("Playwright CLI: deshabilitado (opcional). Usa 'install --playwright' para instalarlo de forma explícita.");
    } else if (playwright.status === "healthy") {
      p.log.success("Playwright CLI: paquete y caché de Chromium detectados (doctor no prueba el arranque).");
    } else if (playwright.status === "not-in-path") {
      p.log.warn("Playwright CLI: instalado en el directorio de pnpm, pero fuera del PATH de esta terminal. Abre una terminal nueva tras pnpm setup; no hace falta reinstalarlo.");
      problems++;
    } else if (playwright.status === "missing") {
      const target = playwright.missing === "package" ? "el paquete global" : "el navegador de Playwright";
      p.log.warn(`Playwright CLI: habilitado, pero falta ${target} → ejecuta 'jorgex-stack install --playwright'.`);
      problems++;
    } else if (playwright.status === "broken") {
      p.log.error("Playwright CLI: el binario detectado no responde correctamente → ejecuta 'jorgex-stack install --playwright'.");
      problems++;
    } else if (playwright.status === "unreadable") {
      p.log.error(`Playwright CLI: no se puede leer la caché de navegadores en ${playwright.path} (${playwright.errorCode}) → revisa permisos o ejecuta 'jorgex-stack install --playwright'.`);
      problems++;
    } else {
      p.log.warn("Playwright CLI: versión distinta del pin aprobado → ejecuta 'jorgex-stack update' o 'install --playwright'.");
      problems++;
    }
  }

  const manifest = readManifest();
  const current = collectAllCurrentTargets(modePreference);

  if (!current.complete || current.warnings.length > 0) {
    p.log.warn("Limpieza de huérfanos deshabilitada: no se pudo construir el plan completo de todos los runtimes.");
    for (const warning of current.warnings) p.log.warn(warning);
    problems++;
  }

  for (const adapter of Object.values(ADAPTERS)) {
    if (options.runtimes !== undefined && !options.runtimes.includes(adapter.id)) continue;
    const detection = adapter.detect();
    if (!detection.installed) {
      p.log.warn(`${adapter.name}: no instalado en esta máquina.`);
      continue;
    }
    const capabilityReport = adapter.reportCapabilities(detection.configDir);
    const capabilitySummary = capabilityReport.capabilities
      .map((capability) => `${capability.id}=${capability.state}`)
      .join(", ");
    p.log.info(`${adapter.name}: capabilities diagnostic (${capabilitySummary}); no certifica enforcement local.`);

    const ctx = makeContext(adapter, detection.configDir, modePreference);
    if (!ctx) continue;
    ctx.writingStyle = writingStyle;

    let pending: number;
    try {
      pending = diffPlan(buildPlan(adapter, ctx)).filter((d) => d.status !== "unchanged").length;
    } catch (err) {
      p.log.error(
        `${adapter.name}: config ilegible en ${detection.configDir} — ${err instanceof Error ? err.message : err}`,
      );
      problems++;
      continue;
    }
    if (pending > 0) {
      p.log.warn(`${adapter.name}: ${pending} archivos gestionados desactualizados o ausentes → ejecuta 'sync'.`);
      problems++;
    } else {
      p.log.success(`${adapter.name}: config del stack al día (${detection.configDir}).`);
    }

    const prev = manifest.runtimes[adapter.id];
    const orphans = prev && current.complete ? findOrphans(prev.owned, current.targets) : [];
    if (orphans.length > 0) {
      p.log.warn(`${adapter.name}: ${orphans.length} archivos huérfanos de versiones previas → ejecuta 'sync'.`);
      problems++;
    }

    if (adapter.id === "codex" && fs.existsSync(path.join(detection.configDir, "hooks.json"))) {
      p.log.info("Codex: recuerda que los hooks requieren aprobación manual — verifica con /hooks dentro de codex.");
    }

    const key = context7KeyConfigured(adapter.id, detection.configDir);
    if (key === false) p.log.info(`${adapter.name}: context7 sin key (opcional — conéctala cuando quieras).`);
  }

  p.outro(problems === 0 ? "Todo sano." : `${problems} avisos — revisa arriba.`);
  return problems > 0 ? 1 : 0;
}
