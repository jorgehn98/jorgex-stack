import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups, restoreBackup } from "../src/lib/backup.js";
import { applyWritingStyle, prepareWritingStyle } from "../src/lib/writing-style.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-writing-style-plan-"));
  roots.push(root);
  return root;
}

function writeCanonical(stackDir: string, content: string): string {
  const file = path.join(stackDir, "system-prompt", "writing-style.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("plan y aplicación de la fuente canónica de writing-style", () => {
  it("prepara e instala el canon en una fuente local nueva", () => {
    const root = tempRoot();
    const stackDir = path.join(root, "stack");
    const canonical = "Canon sintético: escribe con claridad y conserva los matices.\n";
    const canonicalPath = writeCanonical(stackDir, canonical);
    const homeDir = path.join(root, "home");
    const sourcePath = path.join(homeDir, ".jorgex-stack", "writing-style.md");

    const plan = prepareWritingStyle(sourcePath, { rootDir: homeDir, stackDir });

    expect(plan).toMatchObject({
      sourcePath,
      canonicalPath,
      content: canonical.trim(),
      originalContent: null,
    });
    expect(plan.installedContent).toContain("<!-- jorgex:writing-style-default -->");
    expect(plan.installedContent).toContain(canonical.trim());
    expect(plan.installedContent).toContain("<!-- /jorgex:writing-style-default -->");
    expect(plan.installedContent).not.toContain("<!-- jorgex:writing-style -->");

    applyWritingStyle(plan);

    expect(fs.readFileSync(sourcePath, "utf8")).toBe(plan.installedContent);
    expect(fs.readFileSync(sourcePath, "utf8")).toContain(canonical.trim());
  });

  it("actualiza solo el bloque gestionado, conserva las notas en orden y respalda el estado anterior", () => {
    const root = tempRoot();
    const stackDir = path.join(root, "stack");
    writeCanonical(stackDir, "Canon nuevo y completo.\n");
    const homeDir = path.join(root, "home");
    const sourcePath = path.join(homeDir, ".jorgex-stack", "writing-style.md");
    const original = [
      "Nota propia antes.",
      "<!-- jorgex:writing-style-default -->",
      "Canon viejo.",
      "<!-- /jorgex:writing-style-default -->",
      "Nota propia después.",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, original);

    const plan = prepareWritingStyle(sourcePath, { rootDir: homeDir, stackDir });
    expect(plan.originalContent).toBe(original);
    expect(plan.content).toContain("Canon nuevo y completo.");
    expect(plan.content).toContain("Nota propia antes.");
    expect(plan.content).toContain("Nota propia después.");
    expect(plan.content.indexOf("Nota propia antes.")).toBeLessThan(plan.content.indexOf("Canon nuevo"));
    expect(plan.content.indexOf("Canon nuevo")).toBeLessThan(plan.content.indexOf("Nota propia después."));
    expect(plan.installedContent).toContain("Canon nuevo y completo.");
    expect(plan.installedContent).not.toContain("Canon viejo.");

    applyWritingStyle(plan);
    const firstApplied = fs.readFileSync(sourcePath, "utf8");
    expect(firstApplied).toBe(plan.installedContent);
    expect(firstApplied.match(/<!-- jorgex:writing-style-default -->/g)).toHaveLength(1);
    expect(firstApplied.match(/<!-- \/jorgex:writing-style-default -->/g)).toHaveLength(1);

    const backupRoot = plan.backupRoot;
    expect(backupRoot).toBeDefined();
    expect(listBackups(backupRoot)).toHaveLength(1);
    expect(listBackups(backupRoot)[0]?.files[0]?.original).toBe(sourcePath);
    const styleBackup = listBackups(backupRoot).find((backup) => backup.label === "writing-style");
    expect(styleBackup).toBeDefined();

    applyWritingStyle(plan);
    expect(listBackups(backupRoot)).toHaveLength(1);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(firstApplied);

    expect(restoreBackup(styleBackup!.id, backupRoot, homeDir)).toBe(1);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);

    const reapplied = prepareWritingStyle(sourcePath, { rootDir: homeDir, stackDir });
    expect(reapplied.originalContent).toBe(original);
    expect(reapplied.content).toContain("Canon nuevo y completo.");
    expect(reapplied.content).toContain("Nota propia antes.");
    expect(reapplied.content).toContain("Nota propia después.");
    applyWritingStyle(reapplied);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(reapplied.installedContent);
    expect(fs.readFileSync(sourcePath, "utf8")).toContain("Canon nuevo y completo.");
    expect(fs.readFileSync(sourcePath, "utf8")).not.toContain("Canon viejo.");
  });

  it("rechaza marcadores desconocidos o pares propios ambiguos antes de aplicar", () => {
    const cases = [
      [
        "<!-- jorgex:writing-style-default -->\nCanon viejo.\n<!-- /jorgex:writing-style-default -->\n<!-- jorgex:reserved -->\n",
        "marcador desconocido",
      ],
      [
        "<!-- jorgex:writing-style-default -->\nUno.\n<!-- /jorgex:writing-style-default -->\n<!-- jorgex:writing-style-default -->\nDos.\n<!-- /jorgex:writing-style-default -->\n",
        "par duplicado",
      ],
    ] as const;

    for (const [original, label] of cases) {
      const root = tempRoot();
      const homeDir = path.join(root, "home");
      const stackDir = path.join(root, "stack");
      writeCanonical(stackDir, "Canon nuevo.\n");
      const sourcePath = path.join(homeDir, ".jorgex-stack", "writing-style.md");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, original);

      expect(() => prepareWritingStyle(sourcePath, { rootDir: homeDir, stackDir }), label).toThrow(/Marcadores de estilo ambiguos|reservados/);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(homeDir, "backups"))).toBe(false);
    }
  });

  it("en dry-run prepara el plan pero no crea la fuente ni backups", () => {
    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const stackDir = path.join(root, "stack");
    writeCanonical(stackDir, "Canon sintético para dry-run.\n");
    const sourcePath = path.join(homeDir, ".jorgex-stack", "writing-style.md");

    const plan = prepareWritingStyle(sourcePath, { rootDir: homeDir, stackDir });
    applyWritingStyle(plan, true);

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(path.join(homeDir, "backups"))).toBe(false);
  });

  it("mantiene los backups de target-dir dentro de su propio destino", () => {
    const root = tempRoot();
    const targetDir = path.join(root, "target");
    const stackDir = path.join(root, "stack");
    writeCanonical(stackDir, "Canon de target-dir.\n");
    const sourcePath = path.join(targetDir, "writing-style.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(sourcePath, "Nota target\n");

    const plan = prepareWritingStyle(sourcePath, { rootDir: targetDir, stackDir });
    expect(plan.backupRoot).toBe(path.join(targetDir, "backups"));

    applyWritingStyle(plan);

    const backups = listBackups(plan.backupRoot);
    expect(backups).toHaveLength(1);
    expect(backups[0]?.files[0]?.stored.startsWith(`${targetDir}${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(root, "home", ".jorgex-stack", "backups"))).toBe(false);
  });

  it("rechaza un directorio de backups de target-dir que escapa mediante symlink", () => {
    if (process.platform === "win32") return;

    const root = tempRoot();
    const targetDir = path.join(root, "target");
    const outsideDir = path.join(root, "outside");
    const stackDir = path.join(root, "stack");
    const sourcePath = path.join(targetDir, "writing-style.md");
    const backupsPath = path.join(targetDir, "backups");
    const original = "Nota privada que debe conservarse.\n";
    writeCanonical(stackDir, "Canon aislado para target-dir.\n");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(sourcePath, original);
    try {
      fs.symlinkSync(outsideDir, backupsPath, "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(() => prepareWritingStyle(sourcePath, { rootDir: targetDir, stackDir }))
      .toThrow(/backup|destino|enlace|symlink|fuera/i);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
    expect(fs.readdirSync(outsideDir)).toEqual([]);

    fs.unlinkSync(backupsPath);
    const plan = prepareWritingStyle(sourcePath, { rootDir: targetDir, stackDir });
    fs.symlinkSync(outsideDir, backupsPath, "dir");

    expect(() => applyWritingStyle(plan)).toThrow(/backup|destino|enlace|symlink|fuera/i);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it("conserva 0600 al actualizar una fuente privada y crea la fuente nueva con 0600", () => {
    if (process.platform === "win32") return;

    const root = tempRoot();
    const homeDir = path.join(root, "home");
    const stackDir = path.join(root, "stack");
    writeCanonical(stackDir, "Canon de permisos.\n");

    const existingSource = path.join(homeDir, ".jorgex-stack", "existing.md");
    fs.mkdirSync(path.dirname(existingSource), { recursive: true });
    fs.writeFileSync(existingSource, "Nota privada existente.\n");
    fs.chmodSync(existingSource, 0o600);
    applyWritingStyle(prepareWritingStyle(existingSource, { rootDir: homeDir, stackDir }));
    expect(fs.statSync(existingSource).mode & 0o777).toBe(0o600);

    const newSource = path.join(homeDir, ".jorgex-stack", "new.md");
    applyWritingStyle(prepareWritingStyle(newSource, { rootDir: homeDir, stackDir }));
    expect(fs.statSync(newSource).mode & 0o777).toBe(0o600);
  });
});
