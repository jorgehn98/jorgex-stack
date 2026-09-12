import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertMarkdownSection } from "../src/lib/filemerge.js";
import { applyWritingStyle, prepareWritingStyle } from "../src/lib/writing-style.js";

const logs = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}));

const detectEngram = vi.hoisted(() => vi.fn(() => null));

vi.mock("@clack/prompts", () => ({
  intro: logs.intro,
  outro: logs.outro,
  log: {
    info: logs.info,
    warn: logs.warn,
    error: logs.error,
    message: logs.message,
    success: logs.success,
  },
}));

vi.mock("../src/lib/detect.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/detect.js")>("../src/lib/detect.js");
  return { ...actual, detectEngram };
});

type DoctorOptions = {
  targetDir?: string;
  runtimes?: ("claude-code" | "codex" | "opencode" | "pi")[];
  mode?: { mode: "human" | "programmatic"; subagentConcurrency: "serial" | "parallel" };
};

type DoctorModule = {
  runDoctor(options?: DoctorOptions): Promise<number>;
};

const PRIVATE_STYLE_BODY = "CUERPO PRIVADO SINTÉTICO QUE DOCTOR NO DEBE IMPRIMIR";

function output(): string {
  return [
    ...logs.info.mock.calls,
    ...logs.warn.mock.calls,
    ...logs.error.mock.calls,
    ...logs.message.mock.calls,
    ...logs.success.mock.calls,
    ...logs.outro.mock.calls,
  ].flat().map(String).join("\n");
}

function installCanonicalStyle(targetDir: string, note?: string): ReturnType<typeof prepareWritingStyle> {
  const source = path.join(targetDir, "writing-style.md");
  fs.mkdirSync(targetDir, { recursive: true });
  if (note !== undefined) fs.writeFileSync(source, `${note}\n`);
  const plan = prepareWritingStyle(source, { rootDir: targetDir });
  applyWritingStyle(plan);
  return plan;
}

function writeProjection(targetDir: string, content: string): void {
  fs.writeFileSync(
    path.join(targetDir, "AGENTS.md"),
    upsertMarkdownSection("# Instrucción ajena\n", "writing-style", content),
  );
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("doctor de estilo global", () => {
  it("informa el canon incluido y marca la fuente local ausente como pendiente", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-pending-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    fs.mkdirSync(targetDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/canónico|incluido/i);
      expect(outputText).toMatch(/pendiente/i);
      expect(outputText).not.toMatch(/estilo: desactivado/i);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marca como actual una fuente canónica instalada y su proyección, sin imprimir notas locales", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-current-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const privateNote = "NOTA PRIVADA DEL USUARIO QUE DOCTOR NO DEBE IMPRIMIR";
    const plan = installCanonicalStyle(targetDir, privateNote);
    writeProjection(targetDir, plan.content);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(0);
      expect(outputText).toMatch(/canónico|incluido/i);
      expect(outputText).toMatch(/coincide|actual/i);
      expect(outputText).not.toContain(privateNote);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marca como desactualizada una proyección que no coincide con el canon local", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-outdated-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const privateNote = "NOTA PRIVADA DE PROYECCIÓN QUE NO DEBE SALIR";
    const plan = installCanonicalStyle(targetDir, privateNote);
    writeProjection(targetDir, `Estilo viejo.\n${privateNote}`);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/desactualizada|pendiente/i);
      expect(outputText).not.toContain(privateNote);
      expect(plan.content).toContain(privateNote);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marca como pendiente una fuente local cuyo bloque gestionado fue editado", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-local-drift-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const privateNote = "NOTA LOCAL PRIVADA QUE DOCTOR NO DEBE IMPRIMIR";
    const plan = installCanonicalStyle(targetDir, privateNote);
    const source = path.join(targetDir, "writing-style.md");
    fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace("# Writing style", "Texto local modificado."));
    writeProjection(targetDir, plan.content);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/local|pendiente|desactualizada/i);
      expect(outputText).not.toContain(privateNote);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("informa configuración, tamaño, proyección y override Codex sin imprimir el cuerpo ni tocar HOME", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const prompt = path.join(targetDir, "AGENTS.md");
    const override = path.join(targetDir, "AGENTS.override.md");
    fs.mkdirSync(targetDir, { recursive: true });
    const plan = installCanonicalStyle(targetDir, PRIVATE_STYLE_BODY);
    fs.writeFileSync(prompt, upsertMarkdownSection("# Instrucción ajena\n", "writing-style", plan.content));
    fs.writeFileSync(override, "Override global sintético\n");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });

      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/estilo|writing-style/i);
      expect(outputText).toMatch(/activo|configur|proyect|coincid|tamaño|size/i);
      expect(outputText).toContain("AGENTS.override.md");
      expect(outputText).not.toContain(PRIVATE_STYLE_BODY);
      expect(fs.existsSync(path.join(home, ".jorgex-stack"))).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no marca drift falso cuando el bloque proyectado coincide y un override vacío no advierte", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-match-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const content = "Estilo exacto sintético.";
    fs.mkdirSync(targetDir, { recursive: true });
    const plan = installCanonicalStyle(targetDir, content);
    writeProjection(targetDir, plan.content);
    fs.writeFileSync(path.join(targetDir, "AGENTS.override.md"), " \n\t\n");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(0);
      expect(outputText).toContain("codex: proyección de estilo coincide");
      expect(outputText).not.toContain("proyección de estilo desactualizada");
      expect(outputText).not.toContain("AGENTS.override.md");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("devuelve un error accionable para una fuente inválida sin divulgar su cuerpo", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-invalid-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const privateBody = "CUERPO INVALIDO QUE NO DEBE SALIR";
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), `<!-- jorgex:reserved -->\n${privateBody}\n`);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/no se puede diagnosticar|corrige|marcadores jorgex/i);
      expect(outputText).not.toContain(privateBody);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("en modo programmatic considera correcta la ausencia esperada de la sección", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-programmatic-"));
    const home = path.join(root, "home");
    const codexDir = path.join(home, ".codex");
    const privateBody = "ESTILO PROGRAMMATIC SINTÉTICO";
    fs.mkdirSync(codexDir, { recursive: true });
    installCanonicalStyle(path.join(home, ".jorgex-stack"), privateBody);
    fs.writeFileSync(path.join(home, ".jorgex-stack", "install-mode.json"), JSON.stringify({
      mode: "programmatic",
      subagentConcurrency: "serial",
    }) + "\n");
    fs.writeFileSync(path.join(codexDir, "AGENTS.md"), "# Configuración sintética sin estilo\n");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CODEX_HOME;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ runtimes: ["codex"] });
      const outputText = output();

      expect(outputText).toContain("omitida en modo programmatic");
      expect(outputText).toContain("codex: proyección de estilo coincide");
      expect(outputText).not.toContain("proyección de estilo desactualizada");
      expect(outputText).not.toContain(privateBody);
      expect(typeof exitCode).toBe("number");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("respeta el modo programmatic explícito de un doctor target-dir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-target-programmatic-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    fs.mkdirSync(targetDir, { recursive: true });
    installCanonicalStyle(targetDir, "Estilo target sintético.");
    fs.writeFileSync(path.join(targetDir, "AGENTS.md"), "# Destino programmatic sin estilo\n");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({
        targetDir,
        runtimes: ["codex"],
        mode: { mode: "programmatic", subagentConcurrency: "serial" },
      });
      const outputText = output();

      expect(exitCode).toBe(0);
      expect(outputText).toContain("omitida en modo programmatic");
      expect(outputText).toContain("codex: proyección de estilo coincide");
      expect(outputText).not.toContain("proyección de estilo desactualizada");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("con runtimes vacíos sigue ejecutando las comprobaciones generales del doctor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-empty-runtimes-"));
    const home = path.join(root, "home");
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalEngramDataDir = process.env.ENGRAM_DATA_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ENGRAM_DATA_DIR = path.join(home, ".engram");
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ runtimes: [] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(detectEngram).toHaveBeenCalled();
      expect(outputText).toMatch(/Engram: NO detectado/i);
      expect(outputText).not.toContain("Diagnóstico limitado al estilo");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalEngramDataDir === undefined) delete process.env.ENGRAM_DATA_DIR;
      else process.env.ENGRAM_DATA_DIR = originalEngramDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falla cerrado si la proyección de Codex no se puede leer, aunque el estilo esté desactivado", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-unreadable-prompt-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const prompt = path.join(targetDir, "AGENTS.md");
    const privateBody = "CUERPO DE PROYECCIÓN ILEGIBLE QUE NO DEBE SALIR";
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), " \n\t\n");
    fs.writeFileSync(prompt, privateBody);
    fs.chmodSync(prompt, 0o000);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/no se puede leer|ilegible|permiso|AGENTS\.md|revisa/i);
      expect(outputText).not.toContain(privateBody);
    } finally {
      fs.chmodSync(prompt, 0o600);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falla cerrado si el override global de Codex no se puede leer y no imprime su contenido", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-unreadable-override-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const override = path.join(targetDir, "AGENTS.override.md");
    const privateBody = "CUERPO DE OVERRIDE ILEGIBLE QUE NO DEBE SALIR";
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), " \n\t\n");
    fs.writeFileSync(path.join(targetDir, "AGENTS.md"), "# Configuración sintética\n");
    fs.writeFileSync(override, privateBody);
    fs.chmodSync(override, 0o000);

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.resetModules();
      const doctor = await import("../src/doctor.js") as unknown as DoctorModule;
      const exitCode = await doctor.runDoctor({ targetDir, runtimes: ["codex"] });
      const outputText = output();

      expect(exitCode).toBe(1);
      expect(outputText).toMatch(/no se puede leer|ilegible|permiso|AGENTS\.override\.md|revisa/i);
      expect(outputText).not.toContain(privateBody);
    } finally {
      fs.chmodSync(override, 0o600);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
