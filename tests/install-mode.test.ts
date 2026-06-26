import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function importInstallModeModule(): Promise<Record<string, unknown>> {
  return await import("../src/lib/install-mode.js");
}

async function withTempPreferenceFile<T>(fn: (file: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-mode-"));
  const file = path.join(dir, "install-mode.json");
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("install-mode preference helper", () => {
  it("carga el default human/serial si no existe el archivo", async () => {
    const mod = await importInstallModeModule();

    await withTempPreferenceFile(async (file) => {
      const loadInstallModePreference = mod.loadInstallModePreference as undefined | ((filePath: string) => unknown);

      expect(typeof loadInstallModePreference).toBe("function");
      expect(await Promise.resolve(loadInstallModePreference!(file))).toEqual({
        mode: "human",
        subagentConcurrency: "serial",
      });
    });
  });

  it("falla en loud si la preferencia existe pero no se puede leer", async () => {
    const mod = await importInstallModeModule();

    await withTempPreferenceFile(async (file) => {
      fs.mkdirSync(file);
      const loadInstallModePreference = mod.loadInstallModePreference as undefined | ((filePath: string) => unknown);

      expect(typeof loadInstallModePreference).toBe("function");
      expect(() => loadInstallModePreference!(file)).toThrow();
    });
  });

  it("rechaza --subagent-concurrency sin --mode programmatic", async () => {
    const mod = await importInstallModeModule();

    const parseInstallModePreferenceFlags = mod.parseInstallModePreferenceFlags as undefined | ((mode?: string, subagentConcurrency?: string) => { preference?: unknown; error?: string });

    expect(typeof parseInstallModePreferenceFlags).toBe("function");

    const result = parseInstallModePreferenceFlags!(undefined, "serial");

    expect(result.error).toBeDefined();
    expect(result.preference).toBeUndefined();
  });

  it("round-tripea programmatic/serial en un fichero temporal", async () => {
    const mod = await importInstallModeModule();

    await withTempPreferenceFile(async (file) => {
      const saveInstallModePreference = mod.saveInstallModePreference as undefined | ((filePath: string, value: unknown) => unknown);
      const loadInstallModePreference = mod.loadInstallModePreference as undefined | ((filePath: string) => unknown);

      expect(typeof saveInstallModePreference).toBe("function");
      expect(typeof loadInstallModePreference).toBe("function");

      await Promise.resolve(saveInstallModePreference!(file, {
        mode: "programmatic",
        subagentConcurrency: "serial",
      }));

      expect(await Promise.resolve(loadInstallModePreference!(file))).toEqual({
        mode: "programmatic",
        subagentConcurrency: "serial",
      });
    });
  });

  it.each([
    ["corrupto", "{ not-json"],
    ["modo/combinación inválidos", JSON.stringify({ mode: "human", subagentConcurrency: "parallel" })],
  ] as const)("falla en loud al leer preferencia guardada %s", async (_label, raw) => {
    const mod = await importInstallModeModule();

    await withTempPreferenceFile(async (file) => {
      fs.writeFileSync(file, raw);
      const loadInstallModePreference = mod.loadInstallModePreference as undefined | ((filePath: string) => unknown);

      expect(typeof loadInstallModePreference).toBe("function");
      expect(() => loadInstallModePreference!(file)).toThrow();
    });
  });
});
