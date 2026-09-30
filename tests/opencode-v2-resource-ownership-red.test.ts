import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupOpenCodeBinaries, opencodeV2Binary } from "./helpers/opencode-binary.js";
import {
  STATIC_RESOURCES,
  authenticateStaticResource,
  staticResourceBlockReason,
} from "../src/lib/opencode-static-resources.js";
import fixture from "./fixtures/opencode-v1-hooks.raw.json" with { type: "json" };

/**
 * T07 delta (byte-proof de propiedad): RED del seam autoritativo
 * pipeline/preflight/uninstall ANTES de escribir, con `hooks.ts` como recurso
 * estático representativo.
 *
 * Contrato (T08 delta + PRD línea 56):
 *  - owned con bytes actuales o legacy v1 exacto conocido → reemplazo con backup.
 *  - owned modificado/desconocido/tipo físico ambiguo (symlink) → se bloquea
 *    antes de prefs/backups/proyección/borrado, preservando bytes y ledger.
 *  - unowned byte-idéntico al actual → no-op sin claim (no entra en owned).
 *  - unowned legacy/otro contenido → bloquea con remedio sin claim ni borrado.
 *
 * Los negativos fallan contra el código actual (no hay autenticación de bytes):
 * `diffPlan` ve un `update`, crea backup y pisa; uninstall borra con backup.
 *
 * Fixture: `tests/fixtures/opencode-v1-hooks.raw.json` son bytes opacos
 * (gzip+base64) del hooks.ts publicado de jorgex-stack@1.9.67, generados desde
 * el commit inmutable 6a54caf512125d53ef8c98e137710a4cf8c2a480 y nunca
 * importados/ejecutados. Aislamiento: HOME/XDG/TMP/configDir/cwd propios en
 * temp, binario OpenCode v2 fake, Engram fake, sin red ni datos personales.
 */

// Constantes literales de provenance cerrada (no recomputadas del mismo source).
const V1_HOOKS_SHA256 = "6d166b17b1fd102b0fbd96fea3c22195c03ac0a28e32e6fec5057ddfd0c27a23";
const V1_HOOKS_SIZE = 21967;

const OPENCODE_V2_BIN = opencodeV2Binary();

afterAll(cleanupOpenCodeBinaries);

const tempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function decodeV1Hooks(): Buffer {
  const compressed = Buffer.from(fixture.data, "base64");
  return zlib.gunzipSync(compressed);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function backupFiles(home: string): string[] {
  const root = path.join(home, ".jorgex-stack", "backups");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const filesDir = path.join(root, entry, "files");
    if (!fs.existsSync(filesDir)) continue;
    for (const name of fs.readdirSync(filesDir)) out.push(path.join(filesDir, name));
  }
  return out;
}

function backupContains(home: string, bytes: Buffer): boolean {
  return backupFiles(home).some((file) => fs.readFileSync(file).equals(bytes));
}

interface Harness {
  root: string;
  home: string;
  configDir: string;
  externalDir: string;
  hooksTarget: string;
  engramBin: string;
  engramInvoked: string;
  install: typeof import("../src/install.js");
  uninstall: typeof import("../src/uninstall.js");
  readManifest: typeof import("../src/lib/manifest.js").readManifest;
  realInstall: () => Promise<number>;
}

/** Fake Engram: registra cualquier invocación; nunca debe ejecutarse en el guard. */
function seedFakeEngram(home: string): { bin: string; invokedMarker: string } {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const invokedMarker = `${bin}.invoked`;
  const quoted = `'${invokedMarker.replaceAll("'", `'\\''`)}'`;
  fs.writeFileSync(
    bin,
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${quoted}`, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit no aplica.
  }
  return { bin, invokedMarker };
}

async function withIsolatedOpenCode(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-delta-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const configDir = path.join(home, ".config", "opencode");
  const externalDir = path.join(root, "external");
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const { bin: engramBin, invokedMarker: engramInvoked } = seedFakeEngram(home);

  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  const restore = (): void => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

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
    opencode.detect = () => ({ id: "opencode", name: "OpenCode", installed: true, binPath: OPENCODE_V2_BIN, configDir });
    codex.detect = () => ({ id: "codex", name: "Codex CLI", installed: false, binPath: null, configDir: path.join(home, ".codex") });
    claude.detect = () => ({ id: "claude-code", name: "Claude Code", installed: false, binPath: null, configDir: path.join(home, ".claude") });

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
      await run({
        root,
        home,
        configDir,
        externalDir,
        hooksTarget: path.join(configDir, "plugins", "hooks.ts"),
        engramBin,
        engramInvoked,
        install,
        uninstall,
        readManifest,
        realInstall,
      });
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

function ownedPaths(h: Harness): string[] {
  return (h.readManifest().runtimes.opencode?.owned ?? []).map((file) => path.resolve(file));
}

describe("[T07-delta] procedencia del fixture v1", () => {
  it("descomprime bytes reales v1 y coincide con SHA-256 y tamaño cerrados", () => {
    const bytes = decodeV1Hooks();
    expect(bytes.length).toBe(V1_HOOKS_SIZE);
    expect(sha256(bytes)).toBe(V1_HOOKS_SHA256);
    expect(fixture.source.commit).toBe("6a54caf512125d53ef8c98e137710a4cf8c2a480");
    expect(fixture.source.sha256).toBe(V1_HOOKS_SHA256);
    expect(fixture.source.size).toBe(V1_HOOKS_SIZE);
  });
});

describe("[T07-delta] install/uninstall no pisan ni borran un owned modificado", () => {
  it("install real bloquea un hooks.ts owned modificado y preserva bytes, ledger y sin backup", async () => {
    await withIsolatedOpenCode(async (h) => {
      const firstExit = await h.realInstall();
      expect(firstExit, "install real sigue saliendo 1 por el prerrequisito Engram").toBe(1);
      expect(ownedPaths(h), "el manifest coherente debe reclamar hooks.ts").toContain(path.resolve(h.hooksTarget));

      const modified = "// modificación del usuario sobre un recurso owned\nexport default {};\n";
      fs.writeFileSync(h.hooksTarget, modified);
      const modifiedBytes = fs.readFileSync(h.hooksTarget);

      const exit = await h.realInstall();
      expect(exit).toBe(1);
      expect(
        fs.readFileSync(h.hooksTarget).equals(modifiedBytes),
        "el archivo owned modificado debe conservarse byte a byte (el digest no autoriza pisarlo)",
      ).toBe(true);
      expect(ownedPaths(h), "el ledger de propiedad debe conservarse").toContain(path.resolve(h.hooksTarget));
      expect(backupFiles(h.home), "un recurso ambiguo se bloquea antes de crear backups").toEqual([]);
      expect(fs.existsSync(h.engramInvoked), "Engram no debe invocarse").toBe(false);
    });
  });

  it("uninstall real bloquea un hooks.ts owned modificado y conserva bytes y propiedad", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall();
      const modified = "// modificación del usuario antes de desinstalar\n";
      fs.writeFileSync(h.hooksTarget, modified);

      const exit = await h.uninstall.runUninstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        removeEngram: false,
        removePlaywright: false,
      });

      expect(exit, "uninstall debe fallar/bloquear, no borrar silenciosamente").toBe(1);
      expect(fs.existsSync(h.hooksTarget), "el archivo owned modificado no debe borrarse").toBe(true);
      expect(fs.readFileSync(h.hooksTarget, "utf8")).toBe(modified);
      expect(ownedPaths(h), "la propiedad debe conservarse").toContain(path.resolve(h.hooksTarget));
      expect(backupFiles(h.home), "no debe respaldarse ni borrarse un recurso ambiguo").toEqual([]);
    });
  });
});

describe("[T07-delta] unowned no se reclama ni se pisa (digest igual / legacy)", () => {
  it("install real conserva un hooks.ts unowned byte-idéntico al actual sin reclamarlo", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall();
      const projected = fs.readFileSync(h.hooksTarget);
      // Limpia manifest + ledger de preferencias para simular un preexistente
      // realmente unowned, conservando los archivos ya proyectados.
      fs.rmSync(path.join(h.home, ".jorgex-stack"), { recursive: true, force: true });

      const exit = await h.realInstall();
      expect(exit).toBe(1);
      expect(
        fs.readFileSync(h.hooksTarget).equals(projected),
        "un unowned ya idéntico al actual se conserva como no-op",
      ).toBe(true);
      const owned = ownedPaths(h);
      expect(owned.length, "el install debe regenerar el ledger owned").toBeGreaterThan(0);
      expect(
        owned,
        "la coincidencia de digest sin ownership no autoriza claim",
      ).not.toContain(path.resolve(h.hooksTarget));
    });
  });

  it("install real bloquea un hooks.ts unowned con bytes legacy v1 y no lo pisa ni reclama", async () => {
    await withIsolatedOpenCode(async (h) => {
      fs.mkdirSync(path.dirname(h.hooksTarget), { recursive: true });
      const legacy = decodeV1Hooks();
      fs.writeFileSync(h.hooksTarget, legacy);

      const exit = await h.realInstall();
      expect(exit).toBe(1);
      expect(
        fs.readFileSync(h.hooksTarget).equals(legacy),
        "un recurso unowned legacy no se reemplaza",
      ).toBe(true);
      expect(ownedPaths(h), "un unowned legacy no entra en owned").not.toContain(path.resolve(h.hooksTarget));
      expect(backupFiles(h.home), "no se respalda ni reemplaza un unowned").toEqual([]);
    });
  });

  it("uninstall real omite un hooks.ts unowned sin borrarlo ni respaldarlo", async () => {
    await withIsolatedOpenCode(async (h) => {
      fs.mkdirSync(path.dirname(h.hooksTarget), { recursive: true });
      const foreign = decodeV1Hooks();
      fs.writeFileSync(h.hooksTarget, foreign);

      const exit = await h.uninstall.runUninstall({
        runtimes: ["opencode"],
        dryRun: false,
        yes: true,
        removeEngram: false,
        removePlaywright: false,
      });

      expect(exit, "no hay recursos owned: uninstall termina sin error").toBe(0);
      expect(fs.existsSync(h.hooksTarget), "un unowned estático no se borra").toBe(true);
      expect(fs.readFileSync(h.hooksTarget).equals(foreign), "los bytes del unowned no se tocan").toBe(true);
      expect(backupFiles(h.home), "un unowned no se respalda").toEqual([]);
    });
  });
});

describe("[T07-delta] tipo físico ambiguo se bloquea preservando el fixture externo", () => {
  it.skipIf(process.platform === "win32")(
    "install real bloquea un hooks.ts symlink y conserva el enlace y el archivo externo",
    async () => {
      await withIsolatedOpenCode(async (h) => {
        await h.realInstall();
        fs.rmSync(h.hooksTarget, { force: true });
        const sentinel = path.join(h.externalDir, "sentinel.ts");
        const sentinelContent = "export const sentinel = true;\n";
        fs.writeFileSync(sentinel, sentinelContent);
        fs.symlinkSync(sentinel, h.hooksTarget);

        const exit = await h.realInstall();
        expect(exit).toBe(1);
        expect(
          fs.lstatSync(h.hooksTarget).isSymbolicLink(),
          "el symlink owned debe bloquearse sin reemplazarse",
        ).toBe(true);
        expect(fs.readFileSync(sentinel, "utf8"), "el archivo externo no debe tocarse").toBe(sentinelContent);
        expect(ownedPaths(h), "la propiedad se conserva sin reclamar el destino").toContain(path.resolve(h.hooksTarget));
        expect(backupFiles(h.home), "no debe seguirse ni respaldarse el enlace").toEqual([]);
      });
    },
  );
});

describe("[T07-delta] control independiente: owned v1 exacto sí migra con backup", () => {
  it("install real reemplaza un hooks.ts owned v1 exacto y respalda los bytes v1", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall();
      const legacy = decodeV1Hooks();
      fs.writeFileSync(h.hooksTarget, legacy);

      const exit = await h.realInstall();
      expect(exit).toBe(1);
      expect(
        fs.readFileSync(h.hooksTarget).equals(legacy),
        "un owned v1 exacto conocido sí puede migrarse",
      ).toBe(false);
      expect(backupContains(h.home, legacy), "la migración conocida exige backup de los bytes v1").toBe(true);
      expect(ownedPaths(h)).toContain(path.resolve(h.hooksTarget));
    });
  });
});

/**
 * Followup T07 (ramas físicas acotadas, sin repetir la matriz): directorio
 * non-regular, ancestro symlink que escapa del config root físico, y hardlink
 * nlink>1. Cada caso es un gate distinto (stat del leaf, stat de ancestros,
 * alias/inode) y no exige un nombre privado de implementación: solo que el
 * bloqueo sea una guardia OpenCode accionable antes de prefs/backups/writes.
 * El motivo se valida con semántica general (`archivo|regular|enlace|symlink|
 * confina|propiedad`), no con el texto exacto de la guardia.
 */
const GUARD_REASON = /archivo|regular|enlace|symlink|confina|propiedad/i;

/** Captura stdout/stderr (clack) durante una corrida; restaura siempre. */
function startOutputCapture(chunks: string[]): () => void {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const capture = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  };
  process.stdout.write = capture as unknown as typeof process.stdout.write;
  process.stderr.write = capture as unknown as typeof process.stderr.write;
  return () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  };
}

async function installWithOutput(
  h: Harness,
): Promise<{ outcome: number | "rejected"; rejection: unknown; output: string }> {
  const chunks: string[] = [];
  const stop = startOutputCapture(chunks);
  let outcome: number | "rejected" = "rejected";
  let rejection: unknown;
  try {
    outcome = await h.realInstall();
  } catch (error) {
    rejection = error;
  } finally {
    stop();
  }
  return { outcome, rejection, output: chunks.join("") };
}

describe("[T07-delta] rama física: owned target directory (non-regular)", () => {
  it("install real bloquea un hooks.ts directorio con guardia accionable antes de writes y preserva sentinel/ledger", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall();
      expect(ownedPaths(h)).toContain(path.resolve(h.hooksTarget));

      fs.rmSync(h.hooksTarget, { recursive: true, force: true });
      fs.mkdirSync(h.hooksTarget, { recursive: true });
      const sentinel = path.join(h.hooksTarget, "user-sentinel.txt");
      fs.writeFileSync(sentinel, "sentinel\n");

      const { outcome, rejection, output } = await installWithOutput(h);
      expect(
        outcome,
        `el preflight debe bloquear con salida controlada (no EISDIR crudo); rejection=${String(rejection)}`,
      ).toBe(1);
      expect(
        output,
        "el motivo debe ser una guardia OpenCode accionable (archivo/regular/enlace/symlink/confina/propiedad)",
      ).toMatch(GUARD_REASON);
      expect(fs.statSync(h.hooksTarget).isDirectory(), "el directorio owned no se reemplaza").toBe(true);
      expect(fs.readFileSync(sentinel, "utf8"), "el sentinel interno no se toca").toBe("sentinel\n");
      expect(ownedPaths(h), "el ledger se conserva").toContain(path.resolve(h.hooksTarget));
      expect(backupFiles(h.home), "se bloquea antes de crear backups").toEqual([]);
    });
  });
});

describe("[T07-delta] rama física: ancestro symlink (pluginsDir) escapa del config root", () => {
  it.skipIf(process.platform === "win32")(
    "install real bloquea el escape por ancestro symlink y conserva byte-idéntico el regular externo",
    async () => {
      await withIsolatedOpenCode(async (h) => {
        await h.realInstall();
        const lexicalTarget = path.join(h.configDir, "plugins", "hooks.ts");
        expect(ownedPaths(h), "el owned se registra en la ruta léxica").toContain(path.resolve(lexicalTarget));

        const pluginsLexical = path.join(h.configDir, "plugins");
        const pluginsMoved = path.join(h.externalDir, "plugins");
        fs.renameSync(pluginsLexical, pluginsMoved);
        fs.symlinkSync(pluginsMoved, pluginsLexical);
        const externalHooks = path.join(pluginsMoved, "hooks.ts");
        const legacy = decodeV1Hooks();
        fs.writeFileSync(externalHooks, legacy);
        expect(fs.lstatSync(externalHooks).isSymbolicLink(), "el archivo externo es regular").toBe(false);

        const { outcome, rejection, output } = await installWithOutput(h);
        expect(
          fs.readFileSync(externalHooks).equals(legacy),
          "el regular externo alcanzado por ancestro symlink debe quedar byte-idéntico",
        ).toBe(true);
        expect(backupFiles(h.home), "no se respalda ni se escribe a través del ancestro enlace").toEqual([]);
        expect(ownedPaths(h), "el ledger léxico se conserva").toContain(path.resolve(lexicalTarget));
        expect(
          outcome,
          `debe bloquear con salida controlada (rejection=${String(rejection)})`,
        ).toBe(1);
        expect(output, "el motivo debe ser una guardia OpenCode accionable").toMatch(GUARD_REASON);
      });
    },
  );
});

describe("[T07-delta] rama física: hardlink nlink>1 con alias propio", () => {
  it("install real bloquea un hooks.ts v1 exacto con nlink>1 antes de backup/reemplazo y conserva inodo/enlaces", async () => {
    await withIsolatedOpenCode(async (h) => {
      await h.realInstall();
      const legacy = decodeV1Hooks();
      const alias = path.join(h.externalDir, "alias.ts");
      fs.writeFileSync(alias, legacy);
      fs.rmSync(h.hooksTarget, { recursive: true, force: true });
      fs.linkSync(alias, h.hooksTarget);

      const before = fs.statSync(h.hooksTarget);
      expect(before.nlink, "el fixture debe tener nlink>1").toBe(2);
      const aliasIno = fs.statSync(alias).ino;

      const { outcome, rejection, output } = await installWithOutput(h);
      const after = fs.statSync(h.hooksTarget);
      expect(after.nlink, "un alias múltiple se bloquea sin desenlazarlo").toBe(2);
      expect(after.ino, "el inodo owned/alizas se conserva").toBe(aliasIno);
      expect(fs.readFileSync(h.hooksTarget).equals(legacy), "los bytes v1 no se reemplazan").toBe(true);
      expect(fs.readFileSync(alias).equals(legacy), "el alias no se modifica").toBe(true);
      expect(backupFiles(h.home), "se bloquea antes de crear backups").toEqual([]);
      expect(
        outcome,
        `debe bloquear con salida controlada (rejection=${String(rejection)})`,
      ).toBe(1);
      expect(output, "el motivo debe ser una guardia OpenCode accionable").toMatch(GUARD_REASON);
    });
  });
});

/**
 * Followup T07 (riesgos deterministas de la guardia T08): ausencia evaluada
 * ANTES del ancestro físico, incertidumbre de FS no fail-closed, y TOCTOU de
 * enlace posterior al stat. Son gates distintos (ancestro+ENOENT, realpath
 * irresoluble, no-follow), no repetición de la matriz previa.
 */
function hooksRow(): (typeof STATIC_RESOURCES)[number] {
  const row = STATIC_RESOURCES.find((candidate) => candidate.target === "plugins/hooks.ts");
  if (row === undefined) throw new Error("falta la fila hooks.ts en el índice congelado");
  return row;
}

describe("[T07-delta] rama física: leaf ausente con ancestro symlink que escapa", () => {
  it.skipIf(process.platform === "win32")(
    "install real bloquea pluginsDir symlink a un directorio externo antes de crear el leaf y deja el externo vacío",
    async () => {
      await withIsolatedOpenCode(async (h) => {
        const outsidePlugins = path.join(h.externalDir, "plugins-out");
        fs.mkdirSync(outsidePlugins, { recursive: true });
        fs.symlinkSync(outsidePlugins, path.join(h.configDir, "plugins"));

        const { outcome, rejection, output } = await installWithOutput(h);

        expect(
          fs.readdirSync(outsidePlugins),
          "no debe crearse ningún leaf a través del ancestro symlink externo",
        ).toEqual([]);
        expect(backupFiles(h.home), "se bloquea antes de crear backups").toEqual([]);
        expect(fs.lstatSync(path.join(h.configDir, "plugins")).isSymbolicLink(), "el ancestro se conserva").toBe(true);
        expect(
          outcome,
          `debe bloquear con salida controlada (rejection=${String(rejection)})`,
        ).toBe(1);
        expect(output, "el motivo debe ser una guardia OpenCode accionable").toMatch(GUARD_REASON);
      });
    },
  );
});

describe("[T07-delta] helper: incertidumbre de FS no es fail-open", () => {
  it("realpathSync irresoluble no autentica el recurso ni lee el target", async () => {
    await withIsolatedOpenCode(async (h) => {
      fs.mkdirSync(path.dirname(h.hooksTarget), { recursive: true });
      fs.writeFileSync(h.hooksTarget, decodeV1Hooks());
      const row = hooksRow();

      const readSpy = vi.spyOn(fs, "readFileSync");
      const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }) as never);
      readSpy.mockClear();
      let auth: ReturnType<typeof authenticateStaticResource>;
      try {
        auth = authenticateStaticResource(h.hooksTarget, row, null, true, h.configDir);
      } finally {
        realpathSpy.mockRestore();
      }
      const blockReason = staticResourceBlockReason(auth);
      const readTarget = readSpy.mock.calls.some(([file]) => String(file) === h.hooksTarget);
      readSpy.mockRestore();

      expect(blockReason, "una raíz física no resoluble debe fail-closed, no autenticar legacy").not.toBeNull();
      expect(["legacy", "current"]).not.toContain(auth.verdict);
      expect(readTarget, "no debe leerse el target tras una raíz física irresoluble").toBe(false);
    });
  });
});

describe("[T07-delta] helper: enlace posterior al stat (TOCTOU no-follow)", () => {
  it.skipIf(process.platform === "win32")(
    "regular real autentica legacy; un swap a symlink interno tras el lstat no se autentica ni se sigue",
    async () => {
      await withIsolatedOpenCode(async (h) => {
        const legacy = decodeV1Hooks();
        fs.mkdirSync(path.dirname(h.hooksTarget), { recursive: true });
        fs.writeFileSync(h.hooksTarget, legacy);
        const row = hooksRow();

        // Control positivo: el seam descriptor autentica un regular real legacy.
        const positive = authenticateStaticResource(h.hooksTarget, row, null, true, h.configDir);
        expect(positive.verdict, "un regular real legacy debe autenticarse antes del no-op").toBe("legacy");

        // TOCTOU: snapshot regular y luego swap a symlink INTERNO con bytes conocidos.
        const snapshot = fs.lstatSync(h.hooksTarget);
        const known = path.join(h.configDir, "inside-known.ts");
        fs.writeFileSync(known, legacy);
        fs.rmSync(h.hooksTarget);
        fs.symlinkSync(known, h.hooksTarget);

        const originalLstat = fs.lstatSync.bind(fs);
        const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
          String(file) === h.hooksTarget ? snapshot : originalLstat(file, ...(rest as []))) as never);
        let auth: ReturnType<typeof authenticateStaticResource>;
        try {
          auth = authenticateStaticResource(h.hooksTarget, row, null, true, h.configDir);
        } finally {
          lstatSpy.mockRestore();
        }

        expect(
          staticResourceBlockReason(auth),
          "un enlace aparecido tras el stat no debe seguirse ni autenticarse",
        ).not.toBeNull();
        expect(["legacy", "current"]).not.toContain(auth.verdict);
      });
    },
  );
});

describe("[T07-delta] helper: ancestro no determinable no cae en ausencia fail-open", () => {
  it("root ENOENT + leaf ENOENT + lstat de ancestro EACCES → bloquea sin leer el target", async () => {
    await withIsolatedOpenCode(async (h) => {
      // Root controlado NO creado y leaf ausente: realpathSync(root) es ENOENT
      // real. El ancestro candidato (plugins) existe como ruta léxica pero su
      // lstat lanza EACCES: la física del ancestro queda indeterminada.
      const missingRoot = path.join(h.externalDir, "missing-root");
      const target = path.join(missingRoot, "plugins", "hooks.ts");
      const ancestorCandidate = path.dirname(target);
      const row = hooksRow();

      const originalLstat = fs.lstatSync.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        if (String(file) === ancestorCandidate) {
          const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalLstat(file, ...(rest as []));
      }) as never);
      const readSpy = vi.spyOn(fs, "readFileSync");
      const openSpy = vi.spyOn(fs, "openSync");
      readSpy.mockClear();
      openSpy.mockClear();

      let auth: ReturnType<typeof authenticateStaticResource>;
      try {
        auth = authenticateStaticResource(target, row, null, true, missingRoot);
      } finally {
        lstatSpy.mockRestore();
      }
      const blockReason = staticResourceBlockReason(auth);
      const readTarget = readSpy.mock.calls.some(([file]) => String(file) === target);
      const openTarget = openSpy.mock.calls.some(([file]) => String(file) === target);
      readSpy.mockRestore();
      openSpy.mockRestore();

      expect(
        blockReason,
        "un ancestro indeterminable debe fail-closed, no declarar ausencia",
      ).not.toBeNull();
      expect(["unreadable", "escaping"], "el veredicto debe ser un bloqueo, no absent").toContain(auth.verdict);
      expect(readTarget, "no debe leer el target").toBe(false);
      expect(openTarget, "no debe abrir el target").toBe(false);
    });
  });
});
