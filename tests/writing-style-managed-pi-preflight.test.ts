import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runPackage: vi.fn().mockResolvedValue({ kind: "installed" }),
  runProjection: vi.fn().mockReturnValue({ kind: "installed" }),
  prepareProjectionUninstall: vi.fn(),
  completeProjectionUninstall: vi.fn(),
}));

vi.mock("../src/lib/pi-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/pi-runtime.js")>("../src/lib/pi-runtime.js");
  return { ...actual, runPiRuntimeSystem: mocks.runPackage };
});

vi.mock("../src/lib/pi-projection-lifecycle.js", () => ({
  runPiProjectionLifecycleSystem: mocks.runProjection,
  preparePiProjectionUninstallSystem: mocks.prepareProjectionUninstall,
  completePiProjectionUninstallSystem: mocks.completeProjectionUninstall,
}));

vi.mock("../src/lib/tool-preferences.js", () => ({
  devtoolsMcpPreferenceFile: vi.fn(() => "/isolated/state/devtools.json"),
  loadDevtoolsMcpPreference: vi.fn(() => false),
  loadPlaywrightCliPreference: vi.fn(() => false),
  saveDevtoolsMcpPreference: vi.fn(),
}));

vi.mock("../src/lib/external-tools.js", () => ({
  resolvePnpmBin: vi.fn(() => null),
}));

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-pi-"));
  roots.push(root);
  return root;
}

async function managedPi(): Promise<typeof import("../src/lib/pi-managed-runtime.js")> {
  vi.resetModules();
  return import("../src/lib/pi-managed-runtime.js");
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.runPackage.mockResolvedValue({ kind: "installed" });
  mocks.runProjection.mockReturnValue({ kind: "installed" });
  mocks.prepareProjectionUninstall.mockReset();
  mocks.completeProjectionUninstall.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("preflight de estilo en el coordinador de Pi", () => {
  it("no ejecuta el paquete ni la proyección si la fuente target-dir es inválida", async () => {
    const targetDir = tempRoot();
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), Buffer.from([0xc3, 0x28]));
    const mod = await managedPi();

    await expect(mod.runManagedPiSystem({
      operation: "install",
      targetDir,
      detected: { executable: "/isolated/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    })).rejects.toThrow(/UTF.?8|codific/i);

    expect(mocks.runPackage).not.toHaveBeenCalled();
    expect(mocks.runProjection).not.toHaveBeenCalled();
  });

  it("pasa una instantánea explícita a la proyección y filtra solo su contenido en programmatic", async () => {
    const targetDir = tempRoot();
    const style = { sourcePath: path.join(targetDir, "writing-style.md"), content: "Estilo sintético." };
    const mod = await managedPi();

    await expect(mod.runManagedPiSystem({
      operation: "install",
      targetDir,
      writingStyle: style,
      writingStyleMode: "programmatic",
      detected: { executable: "/isolated/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    })).resolves.toEqual({ kind: "installed" });

    expect(mocks.runPackage).toHaveBeenCalledWith(expect.objectContaining({ operation: "install" }));
    expect(mocks.runPackage.mock.calls[0]?.[0]).not.toHaveProperty("writingStyle");
    expect(mocks.runProjection).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: { sourcePath: style.sourcePath, content: null },
    }));
  });

  it("la llamada directa sin snapshot instala la fuente local antes de proyectar", async () => {
    const targetDir = tempRoot();
    const mod = await managedPi();

    await expect(mod.runManagedPiSystem({
      operation: "install",
      targetDir,
      detected: { executable: "/isolated/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    })).resolves.toEqual({ kind: "installed" });

    const source = path.join(targetDir, "writing-style.md");
    const installed = fs.readFileSync(source, "utf8");
    expect(installed).toContain("<!-- jorgex:writing-style-default -->");
    expect(installed).toContain("# Humanizer Jorge");
    expect(mocks.runProjection).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: expect.objectContaining({
        sourcePath: source,
        content: expect.stringContaining("# Humanizer Jorge"),
      }),
    }));
  });

  it("en programmatic crea la fuente local pero entrega una proyección sin prosa", async () => {
    const targetDir = tempRoot();
    const mod = await managedPi();

    await expect(mod.runManagedPiSystem({
      operation: "install",
      targetDir,
      writingStyleMode: "programmatic",
      detected: { executable: "/isolated/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    })).resolves.toEqual({ kind: "installed" });

    expect(fs.readFileSync(path.join(targetDir, "writing-style.md"), "utf8")).toContain("# Humanizer Jorge");
    expect(mocks.runProjection).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: expect.objectContaining({ sourcePath: path.join(targetDir, "writing-style.md"), content: null }),
    }));
  });

  it("desinstala sin leer ni modificar una fuente local ilegible", async () => {
    const targetDir = tempRoot();
    const source = path.join(targetDir, "writing-style.md");
    const invalidBytes = Buffer.from([0xc3, 0x28]);
    fs.writeFileSync(source, invalidBytes);
    mocks.prepareProjectionUninstall.mockResolvedValue({ kind: "prepared", token: "uninstall-token" });
    mocks.completeProjectionUninstall.mockResolvedValue({ kind: "uninstalled" });
    const mod = await managedPi();

    await expect(mod.runManagedPiSystem({
      operation: "uninstall",
      targetDir,
      detected: { executable: "/isolated/bin/pi", version: "0.84.2" },
      engramBin: "/isolated/bin/engram",
    })).resolves.toEqual({ kind: "uninstalled" });

    expect(fs.readFileSync(source)).toEqual(invalidBytes);
    expect(mocks.prepareProjectionUninstall).toHaveBeenCalledWith(expect.objectContaining({
      writingStyle: undefined,
    }));
  });
});
