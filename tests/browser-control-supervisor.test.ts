import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
} from "./helpers/bounded-process.js";
import {
  BROWSER_CONTROL_SERVICE_UNIT_FILENAME,
  preflightBrowserControlServiceUnit,
  type BrowserControlServicePreflightResult,
  type BrowserControlSystemctlRunner,
} from "../src/lib/browser-control-service.js";

/**
 * Spec 13 — preflight de activación inicial del servicio Linux gestionado.
 *
 * Seam autoritativo: la API pública `preflightBrowserControlServiceUnit`, que
 * combina un sondeo HTTP REAL al puerto efectivo con una única consulta `show`
 * al manager. Cada caso reserva un puerto loopback efímero propio, registra su
 * limpieza antes de escuchar, cierra su listener (dejando un `ECONNREFUSED`
 * genuino) y devuelve una salida `Nombre=Valor` estricta desde un runner falso:
 * sin manager real, DBus, sysd, Chrome, assets ni red externa.
 *
 * El preflight solo puede declarar `clear` cuando el puerto está ausente Y el
 * manager acredita que la unidad consultada es exactamente la propia (`Id`
 * exacto) sin recarga pendiente (`NeedDaemonReload=no`). Un `Id` ajeno o un
 * `NeedDaemonReload=yes` contradicen la ausencia y deben resolverse como
 * `pending`, nunca como autorización de mutación.
 */

const REQUIRED_SHOW_PROPERTIES = [
  "Id",
  "LoadState",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
  "ActiveState",
  "SubState",
] as const;

/** Verbos de systemctl que mutan estado; un `show` de lectura nunca lo es. */
const MUTATING_SERVICE_VERBS = new Set([
  "daemon-reload",
  "enable",
  "disable",
  "start",
  "stop",
  "restart",
  "reload",
  "mask",
  "unmask",
  "linger",
]);

/** Primer token argv no-opción: el verbo de systemctl, sin depender del orden. */
function serviceVerb(argv: readonly string[]): string | undefined {
  return argv.find((token) => token !== "systemctl" && !token.startsWith("-"));
}

interface CoherentAbsentOverrides {
  /** Identidad declarada por el manager; por defecto la unidad propia. */
  readonly id?: string;
  /** `NeedDaemonReload` declarado; por defecto `no`. */
  readonly needDaemonReload?: string;
}

/**
 * Salida `Nombre=Valor` estricta y coherente con una unidad ausente, con la
 * única incoherencia que cada caso quiere ejercer. El manager devuelve su
 * propia identidad: un `Id` ajeno no es ausencia de la unidad propia.
 */
function coherentAbsentStdout(overrides: CoherentAbsentOverrides = {}): string {
  const props: Record<(typeof REQUIRED_SHOW_PROPERTIES)[number], string> = {
    Id: overrides.id ?? BROWSER_CONTROL_SERVICE_UNIT_FILENAME,
    LoadState: "not-found",
    FragmentPath: "",
    DropInPaths: "",
    NeedDaemonReload: overrides.needDaemonReload ?? "no",
    ActiveState: "inactive",
    SubState: "dead",
  };
  return `${REQUIRED_SHOW_PROPERTIES.map((name) => `${name}=${props[name]}`).join("\n")}\n`;
}

interface ManagerRunnerSpy {
  readonly calls: string[][];
  readonly run: BrowserControlSystemctlRunner;
}

/** Runner externo falso: registra argv y responde siempre `status 0` + salida dada. */
function createManagerRunnerSpy(stdout: string): ManagerRunnerSpy {
  const calls: string[][] = [];
  const run: BrowserControlSystemctlRunner = async (args) => {
    calls.push([...args]);
    return { status: 0, stdout };
  };
  return { calls, run };
}

function expectPending(
  result: BrowserControlServicePreflightResult,
): asserts result is { kind: "pending"; reason: string } {
  expect(result.kind).toBe("pending");
  if (result.kind !== "pending") {
    throw new Error(`el preflight debía quedar pending por ausencia incoherente; obtuvo ${JSON.stringify(result)}`);
  }
  // Razón accionable sin snapshot exacto de prosa.
  expect(typeof result.reason).toBe("string");
  expect(result.reason.trim().length).toBeGreaterThan(0);
}

/**
 * El sondeo del manager es una única lectura `show` de la unidad propia, con
 * `--user` y sin verbos mutantes ni `--force`/`--global`: un resultado `pending`
 * jamás puede venir de una mutación lateral simulada.
 */
function expectReadOnlyShowCalls(calls: string[][]): void {
  expect(calls).toHaveLength(1);
  const argv = calls[0] ?? [];
  expect(argv).toContain("--user");
  expect(argv).toContain("show");
  expect(argv).toContain(BROWSER_CONTROL_SERVICE_UNIT_FILENAME);
  expect(argv).not.toContain("--force");
  expect(argv).not.toContain("--global");
  const verb = serviceVerb(argv);
  expect(verb).toBe("show");
  expect(MUTATING_SERVICE_VERBS.has(verb ?? "")).toBe(false);
}

/** Prueba directa de que el puerto reservado ya no acepta conexiones. */
async function assertRefused(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`el puerto ${port} seguía aceptando conexiones tras cerrar el listener propio`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

/**
 * Reserva un puerto loopback efímero propio: registra su limpieza ANTES de
 * escuchar, captura el puerto, cierra el listener propio antes de cualquier
 * llamada y retiene la prueba de que el puerto quedó genuinamente rechazado.
 * Nunca usa el puerto por defecto 19989 ni 59999: el preflight debe honrar el
 * puerto inyectado.
 */
async function reserveRefusedLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.on("clientError", () => undefined);
  const unregister = registerOwnedResourceCleanup("browser-control-supervisor-port", () => {
    probe.closeAllConnections?.();
    probe.close();
  });
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  if (port === 19989 || port === 59999) {
    throw new Error(`puerto efímero inesperado y no propio ${port}`);
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  unregister();
  await assertRefused(port);
  return port;
}

async function runPreflight(stdout: string): Promise<{
  readonly result: BrowserControlServicePreflightResult;
  readonly calls: string[][];
}> {
  const port = await reserveRefusedLoopbackPort();
  const runner = createManagerRunnerSpy(stdout);
  const result = await preflightBrowserControlServiceUnit({ runner: runner.run, port });
  return { result, calls: runner.calls };
}

afterEach(() => {
  cleanupOwnedResourcesOrThrow();
});

describe("Spec 13 — preflight de servicio Browser Control", () => {
  it("no autoriza el alta cuando el manager declara un Id ajeno aunque acredite ausencia", async () => {
    const { result, calls } = await runPreflight(coherentAbsentStdout({ id: "foreign.service" }));
    expectPending(result);
    expectReadOnlyShowCalls(calls);
  });

  it("no autoriza el alta cuando el manager exige recargar definiciones aunque acredite ausencia", async () => {
    const { result, calls } = await runPreflight(coherentAbsentStdout({ needDaemonReload: "yes" }));
    expectPending(result);
    expectReadOnlyShowCalls(calls);
  });

  it("autoriza el alta cuando la unidad propia acredita ausencia sin recarga pendiente", async () => {
    const { result, calls } = await runPreflight(coherentAbsentStdout());
    expect(result.kind).toBe("clear");
    expectReadOnlyShowCalls(calls);
  });
});
