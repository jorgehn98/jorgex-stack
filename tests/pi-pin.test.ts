import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_PIN_SCRIPT_PATH = path.join(ROOT, ".github", "scripts", "pi-pin.mjs");
const EXPECTED_PIN = {
  url: `https://registry.npmjs.org/${PI_RUNTIME_CANDIDATE.package.name}/-/${PI_RUNTIME_CANDIDATE.package.name}-${PI_RUNTIME_CANDIDATE.package.version}.tgz`,
  bytes: PI_RUNTIME_CANDIDATE.tarball.bytes,
};
const EXPECTED_OUTPUT = `url=${EXPECTED_PIN.url}\nbytes=${EXPECTED_PIN.bytes}\n`;

type Pin = {
  package: { name: unknown; version: unknown; source: unknown };
  provenance: { commit: unknown };
  tarball: { bytes: unknown; sha256: unknown; sha512: unknown };
};
type PiPinReader = (value: unknown) => { url: string; bytes: number };

function frozenPin(): Pin {
  return {
    package: { ...PI_RUNTIME_CANDIDATE.package },
    provenance: { ...PI_RUNTIME_CANDIDATE.provenance },
    tarball: { ...PI_RUNTIME_CANDIDATE.tarball },
  };
}

async function loadReadPiPin(): Promise<PiPinReader> {
  const module: unknown = await import(/* @vite-ignore */ pathToFileURL(PI_PIN_SCRIPT_PATH).href);
  const reader = (module as { readPiPin?: unknown }).readPiPin;
  expect(reader, "El lector de pin debe exportar readPiPin(value).").toEqual(expect.any(Function));
  return reader as PiPinReader;
}

function withForeignCwd(run: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-pin-"));
  try {
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("JorgeX Pi pin reader", () => {
  it("deriva sólo la URL npm y el tamaño del metadata Pi congelado", async () => {
    const readPiPin = await loadReadPiPin();
    expect(readPiPin(frozenPin())).toEqual(EXPECTED_PIN);
  });

  it("rechaza metadata inválida o no segura antes de llegar al workflow", async () => {
    const readPiPin = await loadReadPiPin();
    const invalidPins: Array<{ label: string; create: () => unknown }> = [
      { label: "valor null", create: () => null },
      { label: "metadata obligatorio ausente", create: () => ({}) },
      { label: "package name con control de shell", create: () => ({ ...frozenPin(), package: { ...frozenPin().package, name: "jorgex-pi; echo injected" } }) },
      { label: "source que no coincide", create: () => ({ ...frozenPin(), package: { ...frozenPin().package, source: `${PI_RUNTIME_CANDIDATE.package.source}\n` } }) },
      { label: "semver con trailing newline", create: () => {
        const pin = frozenPin();
        pin.package.version = `${PI_RUNTIME_CANDIDATE.package.version}\n`;
        pin.package.source = `npm:jorgex-pi@${pin.package.version}`;
        return pin;
      } },
      { label: "semver no plano", create: () => ({ ...frozenPin(), package: { ...frozenPin().package, version: `${PI_RUNTIME_CANDIDATE.package.version}-beta` } }) },
      { label: "commit no lower-hex SHA40", create: () => ({ ...frozenPin(), provenance: { commit: "A".repeat(40) } }) },
      { label: "sha256 con trailing newline", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, sha256: `${PI_RUNTIME_CANDIDATE.tarball.sha256}\n` } }) },
      { label: "sha512 de longitud inválida", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, sha512: "0".repeat(127) } }) },
      { label: "bytes cero", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: 0 } }) },
      { label: "bytes negativo", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: -1 } }) },
      { label: "bytes NaN", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: Number.NaN } }) },
      { label: "bytes no entero", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: 1.5 } }) },
      { label: "bytes fuera del límite", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: 125_829_121 } }) },
      { label: "bytes de tipo string", create: () => ({ ...frozenPin(), tarball: { ...frozenPin().tarball, bytes: String(PI_RUNTIME_CANDIDATE.tarball.bytes) } }) },
    ];

    for (const { label, create } of invalidPins) {
      expect(() => readPiPin(create()), label).toThrow();
    }
  });

  it("se importa sin emitir stdout", () => {
    withForeignCwd((cwd) => {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `import(${JSON.stringify(pathToFileURL(PI_PIN_SCRIPT_PATH).href)})`], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.error !== undefined) throw new Error(`No se pudo importar pi-pin.mjs: ${result.error.message}`);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    });
  });

  it("sin argumentos resuelve el JSON relativo al módulo y emite sólo GITHUB_OUTPUT", () => {
    withForeignCwd((cwd) => {
      const result = spawnSync(process.execPath, [PI_PIN_SCRIPT_PATH], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.error !== undefined) throw new Error(`No se pudo ejecutar pi-pin.mjs: ${result.error.message}`);

      expect(result.status).toBe(0);
      if (result.status !== 0) return;
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(EXPECTED_OUTPUT);
    });
  });
});