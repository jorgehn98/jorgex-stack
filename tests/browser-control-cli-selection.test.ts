import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
  runBoundedProcess,
  type BoundedProcessResult,
  type CliResult,
} from "./helpers/bounded-process.js";
import { prepareRepoBuildRun, removeTemporaryRoots } from "./helpers/pnpm-tooling.js";

/**
 * T10 RED — selector Playwright en OpenCode v2.
 *
 * Contrato (Spec T10): OpenCode v2 usa Browser Control (CLI/skill/MCP) y NO
 * ofrece el selector/flags de Playwright CLI. Una selección explícita
 * `--playwright --playwright-runtimes opencode` debe rechazarse con un
 * diagnóstico accionable antes de cualquier mutación o adquisición. Claude
 * Code y Codex conservan su selección explícita.
 *
 * Seam black-box: se compila el CLI real una vez y se ejecuta con el bounded
 * runner sobre HOME/XDG/target privados. Limitación registrada: el camino
 * interactivo TTY (donde el filtro de runtimes elegibles se aplicará por
 * `eligible.length`) no se ejerce aquí; este tracer fija el oráculo de flags
 * explícitos. Pi se excluye: su seam de setup no se ejecuta sin adquisición en
 * este tracer.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const CLI_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 60_000;
const PNPM_VERSION_CHECK_TIMEOUT_MS = 10_000;

const temporaryRoots: string[] = [];
let releaseBuildRootsCleanup: (() => void) | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildDist(): Promise<void> {
  // Owned-resource owner armed before the first root is created.
  releaseBuildRootsCleanup = registerOwnedResourceCleanup("browser-control-cli-temp-roots", () =>
    removeTemporaryRoots(temporaryRoots),
  );
  const prepared = await prepareRepoBuildRun({
    repoRoot: REPO_ROOT,
    env: process.env,
    runProcess: runBoundedProcess,
    versionCheckTimeoutMs: PNPM_VERSION_CHECK_TIMEOUT_MS,
    registerTempRoot: (root) => temporaryRoots.push(root),
  });
  let result: BoundedProcessResult;
  try {
    result = await runBoundedProcess(prepared.invocation, {
      cwd: REPO_ROOT,
      env: prepared.env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`pnpm build failed to start: ${errorMessage(error)}`);
  }

  if (result.error === undefined && !result.timedOut && result.status === 0) return;

  const details = [
    result.timedOut ? `timeout after ${BUILD_TIMEOUT_MS}ms` : undefined,
    result.error?.message,
    result.status === null ? undefined : `exit status: ${result.status}`,
    result.signal === null ? undefined : `signal: ${result.signal}`,
    result.stdout,
    result.stderr,
  ].filter((value): value is string => value !== undefined && value !== "");
  throw new Error(`pnpm build failed${details.length === 0 ? "" : `:\n${details.join("\n")}`}`);
}

type Layout = {
  root: string;
  cwd: string;
  home: string;
  opencodeConfigDir: string;
  xdgConfigHome: string;
  temp: string;
  targetDir: string;
};

function createLayout(): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-browser-cli-"));
  temporaryRoots.push(root);
  const layout: Layout = {
    root,
    cwd: path.join(root, "cwd"),
    home: path.join(root, "home"),
    opencodeConfigDir: path.join(root, "opencode-config"),
    xdgConfigHome: path.join(root, "xdg-config"),
    temp: path.join(root, "tmp"),
    targetDir: path.join(root, "target"),
  };
  for (const directory of [
    layout.cwd,
    layout.home,
    layout.opencodeConfigDir,
    layout.xdgConfigHome,
    layout.temp,
    layout.targetDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return layout;
}

function isolatedEnvironment(layout: Layout): Record<string, string> {
  return {
    HOME: layout.home,
    USERPROFILE: layout.home,
    OPENCODE_CONFIG_DIR: layout.opencodeConfigDir,
    XDG_CONFIG_HOME: layout.xdgConfigHome,
    TMPDIR: layout.temp,
    TMP: layout.temp,
    TEMP: layout.temp,
    // Evidencia de sandbox obligatoria para el gate OpenCode v2 con --target-dir.
    JORGEX_OPENCODE_TARGET_MAJOR: "2",
  };
}

function installArgs(layout: Layout, runtime: string): string[] {
  return [
    "install",
    "--agents", runtime,
    "--playwright",
    "--playwright-runtimes", runtime,
    "--yes",
    "--dry-run",
    "--target-dir", layout.targetDir,
  ];
}

async function runCli(layout: Layout, args: string[]): Promise<CliResult> {
  const result = await runBoundedProcess(
    { command: process.execPath, args: [CLI_PATH, ...args] },
    { cwd: layout.cwd, env: isolatedEnvironment(layout), timeoutMs: CLI_TIMEOUT_MS },
  );
  if (result.error !== undefined) {
    const details = [result.error.message, result.stdout, result.stderr]
      .filter((value) => value !== "")
      .join("\n");
    throw new Error(`CLI failed to start${details === "" ? "" : `:\n${details}`}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  // Same owner boundary as signals/exit: groups first, roots only if verified.
  cleanupOwnedResourcesOrThrow();
});

afterAll(() => {
  cleanupOwnedResourcesOrThrow();
  releaseBuildRootsCleanup?.();
  releaseBuildRootsCleanup = undefined;
});

describe("selector Playwright v2: OpenCode usa Browser Control [T10-RED]", () => {
  beforeAll(async () => {
    await buildDist();
  }, 120_000);

  it("rechaza --playwright-runtimes opencode con diagnóstico Browser Control y sin mutar", async () => {
    const layout = createLayout();
    const result = await runCli(layout, installArgs(layout, "opencode"));
    const diagnostic = `${result.stdout}\n${result.stderr}`;

    // RED: hoy el CLI acepta la selección de Playwright para OpenCode (exit 0)
    // y solo emite el aviso genérico de Browser Control pendiente; falta el
    // rechazo explícito del selector Playwright, así que esta assertion flota.
    expect(diagnostic, "diagnóstico de rechazo del selector Playwright ausente").toMatch(/playwright/i);
    expect(diagnostic).toMatch(/browser.?control/i);
    expect(diagnostic).toMatch(/opencode/i);
    expect(result.status, `esperado rechazo; salida:\n${diagnostic}`).not.toBe(0);
    expect(result.signal).toBeNull();

    // Antes de mutaciones ni adquisición: dry-run no escribe en el target ni
    // crea estado gestionado de navegador.
    expect(fs.readdirSync(layout.targetDir)).toEqual([]);
    expect(fs.existsSync(path.join(layout.home, ".jorgex-stack", ".browser-managed"))).toBe(false);
  });

  it.each(["claude-code", "codex"] as const)(
    "control: %s conserva la selección explícita de Playwright (mismo comportamiento)",
    async (runtime) => {
      const layout = createLayout();
      const result = await runCli(layout, installArgs(layout, runtime));
      const diagnostic = `${result.stdout}\n${result.stderr}`;
      expect(result.status, `salida inesperada para ${runtime}:\n${diagnostic}`).toBe(0);
      expect(result.signal).toBeNull();
      expect(diagnostic).not.toMatch(/browser.?control/i);
    },
  );
});
