import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertMarkdownSection } from "../src/lib/filemerge.js";

const logs = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}));

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

type DoctorOptions = {
  targetDir?: string;
  runtimes?: ("claude-code" | "codex" | "opencode" | "pi")[];
  mode?: { mode: "human" | "programmatic"; subagentConcurrency: "serial" | "parallel" };
};

type DoctorModule = {
  runDoctor(options?: DoctorOptions): Promise<number>;
};

const PRIVATE_STYLE_BODY = "CUERPO PRIVADO SINTÉTICO QUE DOCTOR NO DEBE IMPRIMIR";

function renderedWritingStyle(content: string): string {
  return [
    "## Estilo de escritura",
    "",
    "Estas preferencias se aplican solo a la prosa dirigida al usuario. Respeta el encargo, los formatos obligatorios y las instrucciones técnicas y superiores; no cambies permisos, verificaciones ni autorizaciones.",
    "",
    content,
  ].join("\n");
}

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

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("doctor de estilo global", () => {
  it("informa configuración, tamaño, proyección y override Codex sin imprimir el cuerpo ni tocar HOME", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-doctor-"));
    const home = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const source = path.join(targetDir, "writing-style.md");
    const prompt = path.join(targetDir, "AGENTS.md");
    const override = path.join(targetDir, "AGENTS.override.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(source, `Preferencias sintéticas.\n\n${PRIVATE_STYLE_BODY}\n`);
    fs.writeFileSync(prompt, upsertMarkdownSection("# Instrucción ajena\n", "writing-style", `## Estilo\n\n${PRIVATE_STYLE_BODY}`));
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
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), `${content}\n`);
    fs.writeFileSync(
      path.join(targetDir, "AGENTS.md"),
      upsertMarkdownSection("# Instrucción ajena\n", "writing-style", renderedWritingStyle(content)),
    );
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
    fs.mkdirSync(path.join(home, ".jorgex-stack"), { recursive: true });
    fs.writeFileSync(path.join(home, ".jorgex-stack", "writing-style.md"), `${privateBody}\n`);
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
    fs.writeFileSync(path.join(targetDir, "writing-style.md"), "Estilo target sintético.\n");
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
