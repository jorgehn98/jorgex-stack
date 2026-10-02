/**
 * Doble sintético de las fronteras `prepareBrowserControlRuntime` e
 * `inspectCachedBrowserControlRuntime` (Spec T13) para suites de core OpenCode
 * que prueban modelo/config/ownership/backup, no el publicador de Browser
 * Control.
 *
 * El caller (`install`/`uninstall`) confía en el resultado del coordinador, así
 * que este doble entrega un `ready` sintético —versión ficticia, skill privada
 * en un root de disco y una invocación MCP opaca completa (sus args ya incluyen
 * `mcp`)— para que el pipeline real (adapter, backups, manifest, permisos,
 * Engram) siga corriendo. `inspect` es la lectura cacheada equivalente, para que
 * el uninstall offline autentique la misma proyección sintética. NO adquiere el
 * paquete publicado, NO sondea el relay, NO ejecuta el launcher, NO lee ni
 * fabrica un receipt y NO certifica bytes oficiales: no es evidencia del
 * contrato Browser Control.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type {
  BrowserControlReady,
  BrowserControlRuntimeResult,
  BrowserControlUnavailable,
} from "../../src/lib/browser-control-runtime.js";
import { resolveVerificationDiskBase } from "./pnpm-tooling.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Base de disco verificada para el root privado del doble. Prefiere `/var/tmp`
 * (disco en Linux) y solo usa `os.tmpdir()` en Windows o si `/var/tmp` no
 * existe; `resolveVerificationDiskBase` rechaza tmpfs/ramfs con `statfs`, así que
 * el fixture no queda en RAM donde esa verificación está disponible. El override
 * `JORGEX_VERIFICATION_DISK_ROOT` manda.
 */
function resolvePrivateDiskBase(): string {
  const override = process.env.JORGEX_VERIFICATION_DISK_ROOT?.trim();
  if (override !== undefined && override !== "") {
    return resolveVerificationDiskBase({ repoRoot: REPO_ROOT, env: process.env });
  }
  if (process.platform === "win32") return os.tmpdir();
  if (fs.existsSync("/var/tmp") && fs.statSync("/var/tmp").isDirectory()) {
    return resolveVerificationDiskBase({
      repoRoot: REPO_ROOT,
      env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
    });
  }
  return os.tmpdir();
}

export const SYNTHETIC_BROWSER_CONTROL_VERSION = "0.0.0-synthetic-test-double";

/**
 * Invocación `readyMCP` completa y opaca, con la forma del launcher real (guard
 * `--eval` + launcher + `mcp`), pero de bytes ficticios: no se ejecuta ni se
 * interpreta.
 */
export const SYNTHETIC_BROWSER_CONTROL_INVOCATION = {
  command: "/synthetic/browser-control/node",
  args: [
    "--input-type=module",
    "--eval",
    "/* synthetic browser-control guard (test double, not official bytes) */",
    "/synthetic/browser-control/launcher.mjs",
    "mcp",
  ],
} as const satisfies { command: string; args: readonly string[] };

export const SYNTHETIC_BROWSER_CONTROL_SKILL = [
  "# browser-control (synthetic test double)",
  "",
  "Fixture privada para tests de core; no son los bytes oficiales del proveedor.",
  "",
].join("\n");

export interface BrowserControlReadyDouble {
  /** Sustituto de `prepareBrowserControlRuntime`; siempre resuelve `ready`. */
  readonly prepare: ReturnType<typeof vi.fn<() => Promise<BrowserControlRuntimeResult>>>;
  /**
   * Sustituto síncrono de `inspectCachedBrowserControlRuntime`; siempre resuelve
   * el MISMO `ready` sintético que `prepare` (no un receipt ni bytes oficiales).
   */
  readonly inspect: ReturnType<
    typeof vi.fn<(stateDir: string) => BrowserControlReady | BrowserControlUnavailable>
  >;
  /** Ruta de la skill privada (se materializa en la primera llamada). */
  skillSource(): string;
  /** Elimina el root privado; idempotente. */
  cleanup(): void;
}

/**
 * Crea el doble con un root privado lazy. El owner debe registrar `cleanup` antes
 * de la primera llamada (p.ej. en `afterAll`) para que ninguna fixture quede sin
 * teardown aunque el test falle.
 */
export function createBrowserControlReadyDouble(): BrowserControlReadyDouble {
  let root: string | null = null;
  let skillSource: string | null = null;

  const materialize = (): string => {
    if (skillSource === null) {
      const created = fs.mkdtempSync(path.join(resolvePrivateDiskBase(), "jx-browser-control-ready-"));
      // El root se registra ANTES de escribir la skill: si la escritura falla,
      // el cleanup del owner sigue viendo el root y no filtra la fixture.
      root = created;
      const skill = path.join(created, "SKILL.md");
      fs.writeFileSync(skill, SYNTHETIC_BROWSER_CONTROL_SKILL, "utf8");
      skillSource = skill;
    }
    return skillSource;
  };

  const prepare = vi.fn<() => Promise<BrowserControlRuntimeResult>>(async () => ({
    kind: "ready",
    version: SYNTHETIC_BROWSER_CONTROL_VERSION,
    invocation: SYNTHETIC_BROWSER_CONTROL_INVOCATION,
    skillSource: materialize(),
  }));

  const inspect = vi.fn<(stateDir: string) => BrowserControlReady | BrowserControlUnavailable>(() => ({
    kind: "ready",
    version: SYNTHETIC_BROWSER_CONTROL_VERSION,
    invocation: SYNTHETIC_BROWSER_CONTROL_INVOCATION,
    skillSource: materialize(),
  }));

  return {
    prepare,
    inspect,
    skillSource: () => materialize(),
    cleanup: () => {
      if (root !== null) {
        fs.rmSync(root, { recursive: true, force: true });
        root = null;
        skillSource = null;
      }
    },
  };
}
