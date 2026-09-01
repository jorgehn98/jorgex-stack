import { afterEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn(() => {
    throw new Error("El observer no puede ejecutar comandos.");
  }),
  execFileSync: vi.fn(() => {
    throw new Error("El observer no puede ejecutar comandos.");
  }),
  spawn: vi.fn(() => {
    throw new Error("El observer no puede ejecutar comandos.");
  }),
  spawnSync: vi.fn(() => {
    throw new Error("El observer no puede ejecutar comandos.");
  }),
}));

vi.mock("node:child_process", () => childProcess);
vi.mock("node:child_process/promises", () => ({ execFile: childProcess.execFile }));

type RegistryResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<RegistryResponse>;

type NpmReadbackResult =
  | { status: "public" }
  | {
    status: "pending";
    reason: "unconfirmed";
    attempts: number;
    lastFailure:
      | { category: "registry"; status: number }
      | { category: "network" };
  };

type WaitForNpmAvailability = (options: {
  packageName: string;
  version: string;
  fetch: FetchLike;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  deadlineAt: number;
  retryDelayMs: number;
}) => Promise<NpmReadbackResult>;

type NpmReadbackModule = {
  waitForNpmAvailability: WaitForNpmAvailability;
  reportNpmReadbackResult: (options: {
    packageName: string;
    version: string;
    result: NpmReadbackResult;
    warn: (message: string) => void;
    appendSummary: (message: string) => void;
  }) => void;
};

const npmReadbackModuleUrl = new URL("../.github/scripts/npm-readback.mjs", import.meta.url).href;
const packageName = "jorgex-stack";
const version = "1.9.2";

function registryResponse(status: number, body: unknown): RegistryResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function publicMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: packageName,
    version,
    dist: {
      tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
    },
    ...overrides,
  };
}

async function loadObserver(): Promise<NpmReadbackModule> {
  return await import(npmReadbackModuleUrl) as NpmReadbackModule;
}

afterEach(() => {
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(childProcess.execFileSync).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("waitForNpmAvailability", () => {
  it("declara public solo tras leer la metadata exacta de la versión con un tarball HTTPS", async () => {
    const { waitForNpmAvailability } = await loadObserver();
    const fetch = vi.fn(async () => registryResponse(200, publicMetadata()));
    const sleep = vi.fn(async () => undefined);

    const result = await waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => 0,
      deadlineAt: 1_000,
      retryDelayMs: 100,
    });

    expect(result).toMatchObject({ status: "public" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${packageName}/${version}`,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it("propaga al fetch una señal limitada por el tiempo restante del deadline", async () => {
    const { waitForNpmAvailability } = await loadObserver();
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetch = vi.fn(async () => registryResponse(200, publicMetadata()));

    await waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep: async () => undefined,
      now: () => 900,
      deadlineAt: 1_000,
      retryDelayMs: 100,
    });

    expect(timeout).toHaveBeenCalledWith(100);
    expect(fetch).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${packageName}/${version}`,
      expect.objectContaining({ signal }),
    );
  });

  it.each([
    ["nombre distinto", publicMetadata({ name: "otro-paquete" })],
    ["versión distinta", publicMetadata({ version: "1.9.3" })],
    ["tarball no HTTPS", publicMetadata({ dist: { tarball: "http://registry.npmjs.org/package.tgz" } })],
  ])("trata un 200 con %s como error terminal", async (_label, metadata) => {
    const { waitForNpmAvailability } = await loadObserver();
    const fetch = vi.fn(async () => registryResponse(200, metadata));
    const sleep = vi.fn(async () => undefined);

    await expect(waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => 0,
      deadlineAt: 1_000,
      retryDelayMs: 100,
    })).rejects.toThrow(/metadata|nombre|versi[oó]n|tarball/i);

    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["404", async () => registryResponse(404, {})],
    ["408", async () => registryResponse(408, {})],
    ["429", async () => registryResponse(429, {})],
    ["5xx", async () => registryResponse(503, {})],
    ["timeout", async () => {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    }],
    ["red", async () => {
      throw new TypeError("network unreachable");
    }],
  ])("reintenta %s como una lectura y acaba public cuando la metadata aparece", async (_label, firstRead) => {
    const { waitForNpmAvailability } = await loadObserver();
    let now = 0;
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return await firstRead();
      return registryResponse(200, publicMetadata());
    });
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    const result = await waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => now,
      deadlineAt: 1_000,
      retryDelayMs: 100,
    });

    expect(result).toMatchObject({ status: "public" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it.each([400, 401])("trata HTTP %i como error terminal sin volver a leer", async (status) => {
    const { waitForNpmAvailability } = await loadObserver();
    const fetch = vi.fn(async () => registryResponse(status, {}));
    const sleep = vi.fn(async () => undefined);

    await expect(waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => 0,
      deadlineAt: 1_000,
      retryDelayMs: 100,
    })).rejects.toThrow(new RegExp(`HTTP ${status}`));

    expect(fetch).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aplica un backoff creciente y acotado ante lecturas transitorias", async () => {
    const { waitForNpmAvailability } = await loadObserver();
    let now = 0;
    const fetch = vi.fn(async () => (
      fetch.mock.calls.length <= 3
        ? registryResponse(404, {})
        : registryResponse(200, publicMetadata())
    ));
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    const result = await waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => now,
      deadlineAt: 100_000,
      retryDelayMs: 20_000,
    });

    const delays = sleep.mock.calls.map(([milliseconds]) => milliseconds as number);
    expect(result).toMatchObject({ status: "public" });
    expect(delays.some((delay, index) => index > 0 && delay > delays[0]!)).toBe(true);
    expect(delays.every((delay) => delay <= 30_000)).toBe(true);
  });

  it("devuelve pending/unconfirmed sin dormir más allá del deadline", async () => {
    const { waitForNpmAvailability } = await loadObserver();
    let now = 0;
    const fetch = vi.fn(async () => registryResponse(404, {}));
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });

    const result = await waitForNpmAvailability({
      packageName,
      version,
      fetch,
      sleep,
      now: () => now,
      deadlineAt: 250,
      retryDelayMs: 100,
    });

    expect(result).toMatchObject({
      status: "pending",
      reason: "unconfirmed",
      attempts: 3,
      lastFailure: { category: "registry", status: 404 },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
    expect(now).toBeLessThanOrEqual(250);
  });

  it("distingue un pending por propagación del registry de uno por fallo de red", async () => {
    const { waitForNpmAvailability } = await loadObserver();

    const runUntilPending = async (read: () => Promise<RegistryResponse>) => {
      let now = 0;
      return await waitForNpmAvailability({
        packageName,
        version,
        fetch: vi.fn(read),
        sleep: async (milliseconds: number) => {
          now += milliseconds;
        },
        now: () => now,
        deadlineAt: 250,
        retryDelayMs: 100,
      });
    };

    await expect(runUntilPending(async () => registryResponse(404, {}))).resolves.toMatchObject({
      status: "pending",
      attempts: 3,
      lastFailure: { category: "registry", status: 404 },
    });
    await expect(runUntilPending(async () => {
      throw new TypeError("network unreachable");
    })).resolves.toMatchObject({
      status: "pending",
      attempts: 3,
      lastFailure: { category: "network" },
    });
  });

  it("reporta un pending con causa e intentos sin convertirlo en un fallo", async () => {
    const { reportNpmReadbackResult } = await loadObserver();
    const warn = vi.fn();
    const appendSummary = vi.fn();

    expect(() => reportNpmReadbackResult({
      packageName,
      version,
      result: {
        status: "pending",
        reason: "unconfirmed",
        attempts: 3,
        lastFailure: { category: "registry", status: 404 },
      },
      warn,
      appendSummary,
    })).not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/::warning::.*3.*HTTP 404/is));
    expect(appendSummary).toHaveBeenCalledWith(expect.stringMatching(/3.*HTTP 404/is));
  });
});
