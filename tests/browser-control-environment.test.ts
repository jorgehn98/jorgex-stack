import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileBrowserControlEnvironment } from "../src/adapters/opencode.js";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
} from "./helpers/bounded-process.js";
import { SYNTHETIC_BROWSER_CONTROL_INVOCATION } from "./helpers/browser-control-ready.js";
import { removeTemporaryRoots, resolveVerificationDiskBase } from "./helpers/pnpm-tooling.js";

/**
 * T12/T13 — readback del entorno gestionado de Browser Control (Spec T13,
 * autoridad granular del entorno).
 *
 * Contrato bajo prueba: `reconcileBrowserControlEnvironment` debe autenticar la
 * proyección ACTUAL, no solo el hash deseado. Con `BROWSER_CONTROL_AUTOSTART`
 * ya presente, un valor actual distinto del deseado (`true` frente a `false`) o
 * un `BROWSER_CONTROL_PORT` incoherente con el gestionado NO pueden declararse
 * estables: el helper debe bloquear y conservar los bytes sin sobrescribir.
 * Solo la pareja FALSE + puerto esperado (con extras de usuario preservados) es
 * un readback estable (`unchanged`).
 *
 * Seam: el helper público, con la invocación MCP sintética opaca completa del
 * doble de core (forma del launcher real, bytes ficticios). Este seam solo
 * comprueba campos/readback y NO afirma autenticación criptográfica ni bytes
 * oficiales: eso pertenece a los verticales de runtime/servicio.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER_CONTROL_SERVER = "browser-control";
const AUTOSTART_FIELD = "BROWSER_CONTROL_AUTOSTART";
const PORT_FIELD = "BROWSER_CONTROL_PORT";
const MANAGED_PORT = "19989";
const FOREIGN_PORT = "19990";

const INVOCATION = SYNTHETIC_BROWSER_CONTROL_INVOCATION;

const ownedRoots: string[] = [];
let releaseRoots: (() => void) | null = null;

/**
 * Base de disco verificada: `/var/tmp` (BTRFS) en Linux/macOS, con el guard que
 * rechaza tmpfs/ramfs y workspaces; `os.tmpdir()` solo en Windows. El override
 * `JORGEX_VERIFICATION_DISK_ROOT` manda.
 */
function diskBase(): string {
  const override = process.env.JORGEX_VERIFICATION_DISK_ROOT?.trim();
  if (override !== undefined && override !== "") {
    return resolveVerificationDiskBase({ repoRoot: REPO_ROOT, env: process.env });
  }
  if (process.platform === "win32") return os.tmpdir();
  return resolveVerificationDiskBase({
    repoRoot: REPO_ROOT,
    env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
  });
}

/** Arma el teardown ANTES de crear el root, para no filtrar la fixture si falla. */
function armCleanup(): void {
  if (releaseRoots === null) {
    releaseRoots = registerOwnedResourceCleanup("browser-control-environment-roots", () =>
      removeTemporaryRoots(ownedRoots),
    );
  }
}

/** Proyecta el MCP gestionado con el `environment` actual dado y devuelve archivo y bytes. */
function seedManagedEnvironment(
  environment: Readonly<Record<string, string>>,
): { configDir: string; file: string; raw: string } {
  armCleanup();
  const root = fs.mkdtempSync(path.join(diskBase(), "jx-browser-control-environment-"));
  ownedRoots.push(root);
  const configDir = path.join(root, "opencode");
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "opencode.json");
  const document = {
    mcp: {
      servers: {
        [BROWSER_CONTROL_SERVER]: {
          type: "local",
          command: [INVOCATION.command, ...INVOCATION.args],
          environment: { ...environment },
        },
      },
    },
  };
  const raw = `${JSON.stringify(document, null, 2)}\n`;
  fs.writeFileSync(file, raw, "utf8");
  return { configDir, file, raw };
}

afterEach(() => {
  cleanupOwnedResourcesOrThrow();
  if (releaseRoots !== null) {
    releaseRoots();
    releaseRoots = null;
  }
});

describe("Browser Control environment readback [T12-RED]", () => {
  const desired = { [AUTOSTART_FIELD]: "false", [PORT_FIELD]: MANAGED_PORT } as const;

  it("bloquea y conserva bytes cuando el AUTOSTART actual es 'true' frente al 'false' gestionado", () => {
    const { configDir, file, raw } = seedManagedEnvironment({
      [AUTOSTART_FIELD]: "true",
      [PORT_FIELD]: MANAGED_PORT,
    });

    const result = reconcileBrowserControlEnvironment({ configDir, invocation: INVOCATION, environment: desired });

    expect(result.kind, "un AUTOSTART actual 'true' no puede declararse readback estable").toBe("blocked");
    expect(fs.readFileSync(file, "utf8"), "un entorno desviado se conserva sin sobrescribir").toBe(raw);
  });

  it("bloquea y conserva bytes cuando el puerto actual difiere del gestionado", () => {
    const { configDir, file, raw } = seedManagedEnvironment({
      [AUTOSTART_FIELD]: "false",
      [PORT_FIELD]: FOREIGN_PORT,
    });

    const result = reconcileBrowserControlEnvironment({ configDir, invocation: INVOCATION, environment: desired });

    expect(result.kind, "un puerto actual incoherente no puede declararse readback estable").toBe("blocked");
    expect(fs.readFileSync(file, "utf8"), "un entorno desviado se conserva sin sobrescribir").toBe(raw);
  });

  it("control: la pareja FALSE + puerto gestionado con extras de usuario es un readback estable", () => {
    const { configDir, file, raw } = seedManagedEnvironment({
      [AUTOSTART_FIELD]: "false",
      [PORT_FIELD]: MANAGED_PORT,
      USER_NOTE: "preserve-me",
    });

    const result = reconcileBrowserControlEnvironment({ configDir, invocation: INVOCATION, environment: desired });

    expect(result.kind, "la pareja canónica presente es un no-op, no una reescritura").toBe("unchanged");
    expect(fs.readFileSync(file, "utf8"), "un readback estable no toca el archivo").toBe(raw);
  });
});
