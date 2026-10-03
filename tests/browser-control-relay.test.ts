import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeBrowserControlRelay,
  resolveBrowserControlRelayPort,
} from "../src/lib/browser-control-runtime.js";

/**
 * T12 RED — clasificación del gate de relay de Browser Control (Spec T13).
 *
 * Seam unitario directo: `resolveBrowserControlRelayPort` y
 * `probeBrowserControlRelay` son la frontera que decide ausente/presente/incierto.
 * No se usa el puerto por defecto ni el relay personal: cada caso escucha en un
 * puerto efímero propio o pasa un env explícito. El cuerpo de la respuesta nunca
 * se registra ni se propaga; la función solo devuelve el estado.
 */

const RELAY_VERSION = "0.8.3";
const SERVERS: Server[] = [];
const OPEN_CONNECTIONS = new Set<import("node:net").Socket>();
let budgetTimer: NodeJS.Timeout | undefined;

afterEach(async () => {
  if (budgetTimer !== undefined) {
    clearTimeout(budgetTimer);
    budgetTimer = undefined;
  }
  for (const socket of OPEN_CONNECTIONS) socket.destroy();
  OPEN_CONNECTIONS.clear();
  const servers = SERVERS.splice(0);
  await Promise.all(servers.map(closeServer));
});

function track(server: Server): Server {
  SERVERS.push(server);
  server.on("connection", (socket) => {
    OPEN_CONNECTIONS.add(socket);
    socket.on("close", () => OPEN_CONNECTIONS.delete(socket));
  });
  // A client that destroys mid-response is an expected absence, not a test error.
  server.on("clientError", () => undefined);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

/** Reserves an ephemeral loopback port and closes it, leaving only ECONNREFUSED behind. */
async function reserveClosedPort(): Promise<number> {
  const server = track(createServer());
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/** Bounded wait: a probe that never settles must fail fast instead of hanging the suite. */
async function withBudget<T>(promise: Promise<T>, label: string, ms = 3_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    budgetTimer = setTimeout(() => reject(new Error(`${label} no se resolvió dentro de ${ms} ms`)), ms);
    promise.then(
      (value) => {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        budgetTimer = undefined;
        resolve(value);
      },
      (error: unknown) => {
        if (budgetTimer !== undefined) clearTimeout(budgetTimer);
        budgetTimer = undefined;
        reject(error);
      },
    );
  });
}

function jsonServer(body: string, status = 200): Server {
  return track(
    createServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    }),
  );
}

describe.skipIf(process.platform !== "linux")("[T12-RED] Browser Control relay gate", () => {
  it("resolves only an explicit integer override, defaulting solely on absence", () => {
    expect(resolveBrowserControlRelayPort({})).toBe(19_989);
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: undefined })).toBe(19_989);
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "19989" })).toBe(19_989);
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: " 1234 " })).toBe(1234);

    // Blank is a present-but-untrusted override: an empty value must not be
    // reinterpreted as the default port nor scanned.
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "" })).toBeNull();
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "   " })).toBeNull();
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "not-a-port" })).toBeNull();
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "0" })).toBeNull();
    expect(resolveBrowserControlRelayPort({ BROWSER_CONTROL_PORT: "65536" })).toBeNull();
  });

  it("returns unknown without any HTTP when the port override is invalid", async () => {
    const started = Date.now();
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: "not-a-port" })).resolves.toBe("unknown");
    // No socket is opened for an untrusted override, so it must settle well
    // before the 2s relay deadline.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("classifies a closed own ephemeral port as absent", async () => {
    const port = await reserveClosedPort();
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(port) })).resolves.toBe("absent");
  });

  it("classifies valid version metadata as present", async () => {
    const port = await listen(
      jsonServer(JSON.stringify({ name: "@opencode-ai/browser-control", version: RELAY_VERSION, build: "browser-control", protocol: 1 })),
    );
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(port) })).resolves.toBe("present");
  });

  it("rejects an empty object or a non-string version as unknown", async () => {
    const emptyPort = await listen(jsonServer("{}"));
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(emptyPort) })).resolves.toBe("unknown");

    const wrongTypePort = await listen(jsonServer(JSON.stringify({ version: 42 })));
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(wrongTypePort) })).resolves.toBe("unknown");

    const nullPort = await listen(jsonServer("null"));
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(nullPort) })).resolves.toBe("unknown");
  });

  it("rejects a non-200 metadata response as unknown", async () => {
    const port = await listen(jsonServer(JSON.stringify({ version: RELAY_VERSION }), 404));
    await expect(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(port) })).resolves.toBe("unknown");
  });

  it("bounds an oversized metadata body as unknown", async () => {
    const oversized = JSON.stringify({
      name: "@opencode-ai/browser-control",
      version: RELAY_VERSION,
      padding: "x".repeat(128 * 1024),
    });
    const port = await listen(jsonServer(oversized));
    await expect(
      withBudget(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(port) }), "probe oversize"),
    ).resolves.toBe("unknown");
  });

  it("treats a truncated response as bounded unknown instead of hanging", async () => {
    const server = track(
      createServer((_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
        response.write('{"name":"@opencode-ai/browser-control","version":"0.8.3"');
        // Close without ever ending the response: no 'end', so the probe must
        // still settle on its own deadline rather than clear it on 'close'.
        setTimeout(() => response.destroy(), 20);
      }),
    );
    const port = await listen(server);
    await expect(
      withBudget(probeBrowserControlRelay({ BROWSER_CONTROL_PORT: String(port) }), "probe truncated"),
    ).resolves.toBe("unknown");
  });
});
