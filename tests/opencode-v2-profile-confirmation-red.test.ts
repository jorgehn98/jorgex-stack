import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOpenCodeBinaries, opencodeV2Binary } from "./helpers/opencode-binary.js";
import { backupFiles, seedFakeEngram, snapshotEnv } from "./helpers/opencode-isolation.js";

/**
 * T07 fix (review ff7a54f, spec 08 §validation):
 *  1. `uninstall` debe validar estrictamente manifest/configDir/inventario
 *     frente al perfil activo ANTES de dar autoridad a `prevOwned` (sin exigir
 *     el version-gate de instalación). Un perfil distinto, o un inventario
 *     editado con un owned que el plan canónico no corrobora, bloquea la
 *     limpieza antes de backups/borrados/unmerge/ledger.
 *  2. Tras la confirmación se reconstruye el plan; los unowned-current
 *     (`preservedStaticTargets`) deben recalcularse desde la autenticación
 *     final que usa `writeManifest`. Una creación ajena concurrente durante el
 *     prompt no se reclama desde la lista cacheada anterior al prompt.
 *
 * Este archivo es RED contra el código actual: `runUninstall` lee `prevOwned`
 * sin coherencia y `preservedStaticTargets` se congela antes del prompt, así
 * que hoy (a) un owned del perfil anterior se borra con backup y (b) un hooks.ts
 * creado durante el prompt queda reclamado en el manifest.
 *
 * Aislamiento: HOME/XDG/TMP/HOME de OpenCode propios en temp, binario OpenCode
 * v2 y Engram fake, `@clack/prompts` mockeado; sin red ni datos personales.
 */

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((_value?: unknown) => false),
  confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => prompts);

const OPENCODE_V2_BIN = opencodeV2Binary();

afterAll(cleanupOpenCodeBinaries);

const tempRoots: string[] = [];
let originalTty: PropertyDescriptor | undefined;

beforeEach(() => {
  originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true, writable: true });
  vi.clearAllMocks();
  prompts.confirm.mockReset();
  prompts.confirm.mockResolvedValue(true);
});

afterEach(() => {
  if (originalTty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", originalTty);
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  home: string;
  oldConfigDir: string;
  newConfigDir: string;
  oldHooksTarget: string;
  manifestFile: string;
  readManifest: typeof import("../src/lib/manifest.js").readManifest;
  realInstall: (yes?: boolean) => Promise<number>;
  runUninstall: () => Promise<number>;
  /** Cambia el perfil activo a un configDir distinto dentro del mismo HOME. */
  switchProfileToNewRoot: () => void;
}

function ownedHooks(h: Harness, target: string): boolean {
  const owned = (h.readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file));
  return owned.includes(path.resolve(target));
}

async function withIsolatedOpenCode(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-profile-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const oldConfigDir = path.join(home, ".config", "opencode");
  const newConfigDir = path.join(home, ".config", "opencode-alt");
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(oldConfigDir, { recursive: true });
  fs.mkdirSync(newConfigDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const { bin: engramBin } = seedFakeEngram(home);

  const restore = snapshotEnv([
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "OPENCODE_CONFIG_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ]);

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  process.env.TMPDIR = tmpDir;
  process.env.TEMP = tmpDir;
  process.env.TMP = tmpDir;
  delete process.env.OPENCODE_CONFIG_DIR;
  vi.resetModules();

  try {
    const install = await import("../src/install.js");
    const uninstall = await import("../src/uninstall.js");
    const { readManifest } = await import("../src/lib/manifest.js");
    const opencode = install.ADAPTERS.opencode!;
    const codex = install.ADAPTERS.codex!;
    const claude = install.ADAPTERS["claude-code"]!;
    const original = { opencode: opencode.detect, codex: codex.detect, claude: claude.detect };
    let activeConfigDir = oldConfigDir;
    opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir: activeConfigDir });
    codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(home, ".codex") });
    claude.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(home, ".claude") });

    const harness: Harness = {
      root,
      home,
      oldConfigDir,
      newConfigDir,
      oldHooksTarget: path.join(oldConfigDir, "plugins", "hooks.ts"),
      manifestFile: path.join(home, ".jorgex-stack", "manifest.json"),
      readManifest,
      realInstall: (yes = true) => install.runInstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes,
        mode: { mode: "human", subagentConcurrency: "serial" },
        command: "install",
        engramBin,
        showSummary: false,
      }),
      runUninstall: () => uninstall.runUninstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        removeEngram: false,
        removePlaywright: false,
      }),
      switchProfileToNewRoot: () => {
        activeConfigDir = newConfigDir;
        process.env.OPENCODE_CONFIG_DIR = newConfigDir;
      },
    };

    try {
      await run(harness);
    } finally {
      opencode.detect = original.opencode;
      codex.detect = original.codex;
      claude.detect = original.claude;
    }
  } finally {
    restore();
    vi.resetModules();
  }
}

describe("[T07-fix] uninstall valida el perfil del manifest antes de dar autoridad a prevOwned", () => {
  it("bloquea el borrado de un hooks.ts owned del perfil anterior cuando cambia OPENCODE_CONFIG_DIR, sin backup ni ledger", async () => {
    await withIsolatedOpenCode(async (h) => {
      const firstExit = await h.realInstall(true);
      expect(firstExit, "install real sigue saliendo 1 por el prerrequisito Engram").toBe(1);
      expect(ownedHooks(h, h.oldHooksTarget), "el manifest coherente reclama hooks.ts del perfil anterior").toBe(true);
      // Aísla el perfil del registro MCP gestionado (otra guardia distinta) para
      // no enmascarar la ruta manifest→prevOwned: sin ownership MCP marcado,
      // `ownedMcpServers` no corta antes.
      fs.rmSync(path.join(h.home, ".jorgex-stack", "devtools-mcp.json"), { force: true });

      const modified = "// modificación del usuario tras cambiar de perfil\nexport default {};\n";
      fs.writeFileSync(h.oldHooksTarget, modified);

      h.switchProfileToNewRoot();
      prompts.log.error.mockClear();
      prompts.log.success.mockClear();

      const exit = await h.runUninstall();

      expect(exit, "un perfil distinto debe bloquear la limpieza, no autorizarla").toBe(1);
      expect(
        fs.existsSync(h.oldHooksTarget),
        "el owned del perfil anterior no debe borrarse cuando el configDir activo es otro",
      ).toBe(true);
      expect(fs.readFileSync(h.oldHooksTarget, "utf8"), "los bytes del owned anterior se conservan").toBe(modified);
      expect(backupFiles(h.home), "un perfil ambiguo se bloquea antes de crear backups").toEqual([]);
      expect(ownedHooks(h, h.oldHooksTarget), "el ledger de propiedad prevOwned se conserva").toBe(true);

      const errors = prompts.log.error.mock.calls.map((call) => String(call[0] ?? ""));
      expect(
        errors.length,
        `debe verse una única razón de mismatch visible; errores=${JSON.stringify(errors)}`,
      ).toBe(1);
      expect(errors[0], "la razón debe describir el perfil/configDir incoherente").toMatch(/manifest|configDir|perfil|no coincide|ownership|inventario/i);
      expect(prompts.log.success, "no debe reportarse una retirada exitosa").not.toHaveBeenCalled();
    });
  });

  it("bloquea un inventario editado con un owned que el plan canónico no corrobora y no borra el asset bajo HOME", async () => {
    await withIsolatedOpenCode(async (h) => {
      const firstExit = await h.realInstall(true);
      expect(firstExit).toBe(1);

      const rogue = path.join(h.oldConfigDir, "rogue-asset.ts");
      const rogueBytes = "export const rogue = true;\n";
      fs.writeFileSync(rogue, rogueBytes);
      const manifest = JSON.parse(fs.readFileSync(h.manifestFile, "utf8")) as {
        runtimes: { opencode: { owned: string[]; pendingOrphans?: string[] } };
      };
      manifest.runtimes.opencode.owned.push(rogue);
      manifest.runtimes.opencode.pendingOrphans = [rogue];
      fs.writeFileSync(h.manifestFile, JSON.stringify(manifest, null, 2) + "\n");

      prompts.log.error.mockClear();
      prompts.log.success.mockClear();

      const exit = await h.runUninstall();

      expect(exit, "un inventario no corroborado debe bloquear la limpieza").toBe(1);
      expect(fs.existsSync(rogue), "el asset no corroborado bajo HOME no debe borrarse").toBe(true);
      expect(fs.readFileSync(rogue, "utf8")).toBe(rogueBytes);
      expect(backupFiles(h.home), "se bloquea antes de crear backups").toEqual([]);
      expect(ownedHooks(h, rogue), "el manifest no se limpia").toBe(true);

      const errors = prompts.log.error.mock.calls.map((call) => String(call[0] ?? ""));
      expect(
        errors.length,
        `debe verse una única razón de incoherencia visible; errores=${JSON.stringify(errors)}`,
      ).toBe(1);
      expect(errors[0], "la razón debe describir el inventario/owned no corroborado").toMatch(/manifest|owned|inventario|corrobora|coheren|huérfan|no coincide/i);
      expect(prompts.log.success, "no debe reportarse una retirada exitosa").not.toHaveBeenCalled();
    });
  });
});

describe("[T07-fix] la autenticación final (no la cacheada pre-prompt) decide el claim", () => {
  it("no reclama un hooks.ts unowned creado por terceros durante el prompt de confirmación", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall(true);
      const projected = fs.readFileSync(h.oldHooksTarget);
      expect(projected.length, "la proyección real de hooks.ts debe tener bytes").toBeGreaterThan(0);

      // Estado fresh: sin manifest y sin el leaf, para que el preflight lo vea ausente.
      fs.rmSync(path.join(h.home, ".jorgex-stack"), { recursive: true, force: true });
      fs.rmSync(h.oldHooksTarget, { force: true });
      expect(fs.existsSync(h.oldHooksTarget), "el leaf debe estar ausente antes del prompt").toBe(false);

      prompts.confirm.mockImplementation(async (options) => {
        const message = String((options as { message?: unknown } | undefined)?.message ?? "");
        if (message.includes("OpenCode")) {
          fs.mkdirSync(path.dirname(h.oldHooksTarget), { recursive: true });
          fs.writeFileSync(h.oldHooksTarget, projected);
        }
        return true;
      });

      const exit = await h.realInstall(false);

      expect(exit, "install sigue saliendo 1 por el prerrequisito Engram (irrelevante aquí)").toBe(1);
      expect(prompts.confirm, "debe haberse abierto la confirmación interactiva").toHaveBeenCalled();
      expect(
        prompts.confirm.mock.calls.some((call) => String((call[0] as { message?: unknown } | undefined)?.message ?? "").includes("OpenCode")),
        "la confirmación debe corresponder al runtime OpenCode",
      ).toBe(true);
      expect(
        fs.readFileSync(h.oldHooksTarget).equals(projected),
        "el archivo creado por terceros con bytes actuales no se pisa",
      ).toBe(true);
      expect(
        ownedHooks(h, h.oldHooksTarget),
        "un recurso ausente en el preflight y creado durante el prompt no se reclama por la lista cacheada anterior",
      ).toBe(false);
    });
  });
});
