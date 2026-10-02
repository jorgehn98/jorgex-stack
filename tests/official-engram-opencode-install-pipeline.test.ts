import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserControlReadyDouble } from "./helpers/browser-control-ready.js";
import { cleanupOpenCodeBinaries, opencodeV2Binary } from "./helpers/opencode-binary.js";

/**
 * T08: contrato público del install real de OpenCode v2 (seam del caller, no
 * del helper). El `runInstall` real —sin `--target-dir`— proyecta/verifica
 * primero la configuración Stack y después bloquea el setup oficial porque la
 * integración v1 (`engram setup opencode`) no es válida para v2. Debe:
 *
 *   1. Conservar el exit 1 existente (`official.ran && !official.ok`), sin
 *      convertirlo en warning ni en éxito.
 *   2. Dejar aplicado y verificable lo ya proyectado por Stack (manifest owned
 *      coherente e idempotente), explicando instalación parcial sin prometer
 *      rollback total.
 *   3. No invocar nunca Engram (marcador fake ausente), ni siquiera `setup`.
 *   4. Mostrar el prerrequisito externo accionable en la salida pública.
 *
 * Aislamiento: HOME/USERPROFILE y el binario fake viven en temp propio; el
 * binario Engram solo escribe su marcador dentro de ese temp. Ningún HOME real,
 * binario, DB ni servicio se toca.
 */

// Binario OpenCode v2 real (el gate ejecuta `--version` con argv directo).
const OPENCODE_V2_BIN = opencodeV2Binary();

afterAll(cleanupOpenCodeBinaries);

const mocks = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => ({
  intro: mocks.intro,
  outro: mocks.outro,
  log: mocks.log,
}));

/**
 * Frontera Browser Control (Spec T13): esta suite prueba el contrato público del
 * install real de OpenCode v2 (proyección Stack, manifest, prerrequisito Engram
 * v2), no el publicador de Browser Control. El coordinador real adquiriría el
 * paquete publicado y sondearía el relay; aquí se sustituye SOLO esa frontera
 * por un `ready` sintético, conservando reales install/adapter/backups/manifest/
 * Engram. El doble NO certifica bytes oficiales. Sin él, el exit 1 lo produciría
 * un Browser Control pendiente y enmascararía el prerrequisito externo real.
 */
const browserControlReady = createBrowserControlReadyDouble();

vi.mock("../src/lib/browser-control-runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/browser-control-runtime.js")>(
      "../src/lib/browser-control-runtime.js",
    );
  return { ...actual, prepareBrowserControlRuntime: browserControlReady.prepare };
});

// Defensa independiente del mock: un puerto inválido nunca contacta el relay del
// usuario (19989 por defecto). Se restaura al terminar el archivo.
const originalBrowserControlPort = process.env.BROWSER_CONTROL_PORT;
process.env.BROWSER_CONTROL_PORT = "not-a-port";

afterAll(() => {
  browserControlReady.cleanup();
  if (originalBrowserControlPort === undefined) delete process.env.BROWSER_CONTROL_PORT;
  else process.env.BROWSER_CONTROL_PORT = originalBrowserControlPort;
});

const tempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR"] as const) {
    const leaked = process.env[key];
    if (typeof leaked === "string" && leaked.includes(os.tmpdir())) delete process.env[key];
  }
});

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    vi.resetModules();
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

/** Fake Engram: registra cualquier invocación y, si es `setup`, el marcador. */
function seedFakeEngram(home: string): { bin: string; invokedMarker: string; setupMarker: string } {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const invokedMarker = `${bin}.invoked`;
  const setupMarker = `${bin}.setup`;
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shQuote(invokedMarker)}`,
      `if [ "$1" = "setup" ]; then printf 'setup\\n' >> ${shQuote(setupMarker)}; fi`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit no aplica; el flujo de argv directo sigue igual.
  }
  return { bin, invokedMarker, setupMarker };
}

function allLogs(): string {
  return [
    ...mocks.log.info.mock.calls.flat(),
    ...mocks.log.warn.mock.calls.flat(),
    ...mocks.log.step.mock.calls.flat(),
    ...mocks.log.success.mock.calls.flat(),
    ...mocks.log.error.mock.calls.flat(),
    ...mocks.log.message.mock.calls.flat(),
  ].join("\n");
}

describe("[T08-pipeline] install real OpenCode v2 conserva config parcial y no invoca el setup v1", () => {
  it("install real sin target sale 1, conserva Stack + manifest owned idempotente, no invoca Engram y muestra el prerrequisito", async () => {
    const activeRoot = tempDir("jx-t08-opencode-pipeline-");
    const homeDir = path.join(activeRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const { bin: engramBin, invokedMarker, setupMarker } = seedFakeEngram(homeDir);
    const configDir = path.join(homeDir, ".config", "opencode");

    if (process.platform !== "win32") {
      // Guard de fixture: el fake registra de verdad; sin esto, "marcador
      // ausente" sería una aserción vacía ante un script roto.
      execFileSync(engramBin, ["setup", "opencode"], { stdio: "pipe" });
      expect(fs.existsSync(invokedMarker), "el fake debe registrar invocaciones").toBe(true);
      expect(fs.existsSync(setupMarker), "el fake debe marcar `setup`").toBe(true);
      fs.rmSync(invokedMarker, { force: true });
      fs.rmSync(setupMarker, { force: true });
    }

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const { readManifest } = await import("../src/lib/manifest.js");

      const opencode = install.ADAPTERS.opencode!;
      const codex = install.ADAPTERS.codex!;
      const claudeCode = install.ADAPTERS["claude-code"]!;
      const origOpen = opencode.detect;
      const origCodex = codex.detect;
      const origClaude = claudeCode.detect;
      // OpenCode v2 real detectado; los demás runtimes fuera de juego.
      opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir });
      codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(homeDir, ".codex") });
      claudeCode.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(homeDir, ".claude") });

      const realInstall = (): Promise<number> =>
        install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          command: "install",
          engramBin,
          showSummary: false,
        });

      try {
        vi.clearAllMocks();
        const firstExit = await realInstall();
        expect(firstExit, "el install real conserva exit 1 por el prerrequisito").toBe(1);

        // (2) Stack ya proyectado y verificado permanece en disco.
        const agentsFile = path.join(configDir, "AGENTS.md");
        expect(fs.existsSync(agentsFile), "el system prompt Stack proyectado debe permanecer").toBe(true);
        const firstAgents = fs.readFileSync(agentsFile, "utf8");

        // Manifest owned coherente: evidencia de proyección idempotente.
        const firstManifest = readManifest();
        const owned = firstManifest.runtimes.opencode?.owned ?? [];
        expect(owned.length, "el manifest debe registrar archivos owned de Stack").toBeGreaterThan(0);
        expect(firstManifest.runtimes.opencode?.configDir).toBe(configDir);
        for (const file of owned) {
          expect(fs.existsSync(file), `archivo owned ausente en disco: ${file}`).toBe(true);
        }

        // (4) Razón pública accionable y sin falsos claims.
        const firstLogs = allLogs();
        expect(firstLogs).toMatch(/prerrequisit|release|validaci|adopci|pendiente/i);
        expect(firstLogs, "no debe afirmar setup exitoso").not.toMatch(/setup oficial Engram ok/i);
        expect(firstLogs, "no debe afirmar rollback total").not.toMatch(/rollback|se restaur|recuperaci[oó]n completa/i);

        // (3) Engram nunca invocado (ni setup ni ningún subcomando).
        expect(fs.existsSync(invokedMarker), "Engram no debe invocarse en el install real").toBe(false);
        expect(fs.existsSync(setupMarker), "`engram setup opencode` no debe ejecutarse").toBe(false);

        // Idempotencia: segundo install real no rompe ni invoca Engram.
        vi.clearAllMocks();
        const secondExit = await realInstall();
        expect(secondExit, "segundo install real sigue fallando por el prerrequisito").toBe(1);
        expect(fs.readFileSync(agentsFile, "utf8"), "el config Stack no debe cambiar entre pasadas").toBe(firstAgents);
        const secondManifest = readManifest();
        expect(new Set(secondManifest.runtimes.opencode?.owned ?? []), "owned debe ser idempotente").toEqual(new Set(owned));
        expect(allLogs()).toMatch(/prerrequisit|release|validaci|adopci|pendiente/i);
        expect(fs.existsSync(invokedMarker), "Engram sigue sin invocarse en la segunda pasada").toBe(false);
        expect(fs.existsSync(setupMarker), "`engram setup opencode` sigue sin ejecutarse").toBe(false);
      } finally {
        opencode.detect = origOpen;
        codex.detect = origCodex;
        claudeCode.detect = origClaude;
      }
    });
  });
});
