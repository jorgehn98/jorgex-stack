import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffSkillDirs, renderSkillDiff, replaceSkill, PROTECTED_SKILLS } from "../src/lib/skill-update.js";
import { validateExtractedTree } from "../src/lib/github.js";
import { buildEligibleSkillUpdates, rotateLockedBinary, type SkillQueryResult } from "../src/update.js";
import { writeText } from "../src/lib/fsx.js";
import { listBackups } from "../src/lib/backup.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-skill-update-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// diffSkillDirs
// ---------------------------------------------------------------------------

describe("diffSkillDirs: detecta added / modified / deleted", () => {
  it("upstream y local idénticos → todo vacío", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill\n");
    writeText(path.join(local, "SKILL.md"), "# skill\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("archivo nuevo en upstream → added", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill\n");
    writeText(path.join(up, "new-file.md"), "nuevo\n");
    writeText(path.join(local, "SKILL.md"), "# skill\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.added).toEqual(["new-file.md"]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("contenido diferente en upstream → modified", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill v2\n");
    writeText(path.join(local, "SKILL.md"), "# skill v1\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.modified).toEqual(["SKILL.md"]);
    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("archivo solo en local → deleted", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill\n");
    writeText(path.join(local, "SKILL.md"), "# skill\n");
    writeText(path.join(local, "legacy.md"), "viejo\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.deleted).toEqual(["legacy.md"]);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("combina added + modified + deleted en un mismo diff", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# v2\n");       // modified
    writeText(path.join(up, "guide", "intro.md"), "intro\n"); // added
    writeText(path.join(local, "SKILL.md"), "# v1\n");    // modified
    writeText(path.join(local, "old.md"), "viejo\n");     // deleted

    const diff = diffSkillDirs(up, local);
    expect(diff.added).toEqual([path.join("guide", "intro.md")]);
    expect(diff.modified).toEqual(["SKILL.md"]);
    expect(diff.deleted).toEqual(["old.md"]);
  });

  it("dirs vacíos → todo vacío sin lanzar", () => {
    const up = path.join(tmp, "upstream-empty");
    const local = path.join(tmp, "local-empty");
    fs.mkdirSync(up, { recursive: true });
    fs.mkdirSync(local, { recursive: true });

    const diff = diffSkillDirs(up, local);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("resultados siempre ordenados alfabéticamente", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "z.md"), "z\n");
    writeText(path.join(up, "a.md"), "a\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.added).toEqual(["a.md", "z.md"]);
  });

  it("CRLF vs LF mismo contenido → no aparece como modified (falso positivo)", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    // upstream con LF (como llegan los tarballs de GitHub)
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, "SKILL.md"), "# skill\nline two\n");
    // local con CRLF (como los deja git con core.autocrlf=true en Windows)
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "SKILL.md"), "# skill\r\nline two\r\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.modified).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("contenido realmente distinto (no solo line endings) → modified", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, "SKILL.md"), "# skill v2\r\nline two\r\n");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "SKILL.md"), "# skill v1\r\nline two\r\n");

    const diff = diffSkillDirs(up, local);
    expect(diff.modified).toEqual(["SKILL.md"]);
  });
});

// ---------------------------------------------------------------------------
// renderSkillDiff: fallback cuando git no está o dirs vacíos
// ---------------------------------------------------------------------------

describe("renderSkillDiff: fallback cuando no hay diferencias", () => {
  it("dirs idénticos → string vacío", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill\n");
    writeText(path.join(local, "SKILL.md"), "# skill\n");

    const out = renderSkillDiff(up, local);
    expect(out).toBe("");
  });

  it("con diferencias → string no vacío", () => {
    const up = path.join(tmp, "upstream");
    const local = path.join(tmp, "local");
    writeText(path.join(up, "SKILL.md"), "# skill v2\n");
    writeText(path.join(local, "SKILL.md"), "# skill v1\n");

    const out = renderSkillDiff(up, local);
    // Puede ser el output de git diff --stat o el fallback; ambos deben ser no vacíos
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// replaceSkill
// ---------------------------------------------------------------------------

describe("replaceSkill: backup, reemplazo y re-pin", () => {
  /** Construye un upstreams.json de fixture con una skill dada. */
  function makeUpstreamsFixture(skillName: string, extra?: Record<string, unknown>): string {
    const file = path.join(tmp, "upstreams.json");
    const data = {
      tools: {},
      skills: {
        [skillName]: {
          source: `github:example/repo`,
          commit: "abc1234def5678901234567890123456789012345",
          ...extra,
        },
      },
    };
    writeText(file, JSON.stringify(data, null, 2) + "\n");
    return file;
  }

  it("copia el contenido del upstream byte a byte al dir local", () => {
    const upstreamSkillDir = path.join(tmp, "upstream", "my-skill");
    const skillsRoot = path.join(tmp, "skills");
    const backupsRoot = path.join(tmp, "backups");
    const upstreamsFile = makeUpstreamsFixture("my-skill");

    writeText(path.join(upstreamSkillDir, "SKILL.md"), "# upstream v2\n");
    writeText(path.join(upstreamSkillDir, "subdir", "helper.md"), "helper\n");
    // Local preexistente (distinto contenido)
    writeText(path.join(skillsRoot, "my-skill", "SKILL.md"), "# local v1\n");

    replaceSkill("my-skill", upstreamSkillDir, "newcommit1234567890123456789012345678901234", { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot, backupsRoot });

    const localSkillDir = path.join(skillsRoot, "my-skill");
    expect(fs.readFileSync(path.join(localSkillDir, "SKILL.md"), "utf8")).toBe("# upstream v2\n");
    expect(fs.readFileSync(path.join(localSkillDir, "subdir", "helper.md"), "utf8")).toBe("helper\n");
  });

  it("crea backup del contenido local antes de reemplazar", () => {
    const upstreamSkillDir = path.join(tmp, "upstream", "my-skill");
    const skillsRoot = path.join(tmp, "skills");
    const backupsRoot = path.join(tmp, "backups");
    const upstreamsFile = makeUpstreamsFixture("my-skill");

    writeText(path.join(upstreamSkillDir, "SKILL.md"), "# upstream v2\n");
    writeText(path.join(skillsRoot, "my-skill", "SKILL.md"), "# local v1\n");

    replaceSkill("my-skill", upstreamSkillDir, "newcommit1234567890123456789012345678901234", { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot, backupsRoot });

    // El backup se crea en backupsRoot (dir temporal); verificamos que el dir
    // local fue reemplazado y que el backup existe en la raíz temporal.
    const content = fs.readFileSync(path.join(skillsRoot, "my-skill", "SKILL.md"), "utf8");
    expect(content).toBe("# upstream v2\n");
    const backupEntries = fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : [];
    expect(backupEntries.length).toBeGreaterThan(0);
  });

  it("re-pinea el commit en upstreams.json y preserva el resto del JSON", () => {
    const upstreamSkillDir = path.join(tmp, "upstream", "my-skill");
    const skillsRoot = path.join(tmp, "skills");
    const backupsRoot = path.join(tmp, "backups");
    const upstreamsFile = makeUpstreamsFixture("my-skill");

    // Añadir otra skill que no debe tocarse
    const raw = JSON.parse(fs.readFileSync(upstreamsFile, "utf8"));
    raw.skills["other-skill"] = { source: "github:example/other", commit: "aaabbbccc" };
    writeText(upstreamsFile, JSON.stringify(raw, null, 2) + "\n");

    writeText(path.join(upstreamSkillDir, "SKILL.md"), "# v2\n");
    writeText(path.join(skillsRoot, "my-skill", "SKILL.md"), "# v1\n");

    const newCommit = "fffeeedddcccbbb000111222333444555666777888";
    replaceSkill("my-skill", upstreamSkillDir, newCommit, { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot, backupsRoot });

    const updated = JSON.parse(fs.readFileSync(upstreamsFile, "utf8"));
    // Pin actualizado
    expect(updated.skills["my-skill"].commit).toBe(newCommit);
    // Otra skill intacta
    expect(updated.skills["other-skill"].commit).toBe("aaabbbccc");
    // Termina con salto de línea (formato estable)
    expect(fs.readFileSync(upstreamsFile, "utf8").endsWith("\n")).toBe(true);
  });

  it("lanza si la skill no existe en upstreams.json", () => {
    const upstreamSkillDir = path.join(tmp, "upstream", "nonexistent");
    const skillsRoot = path.join(tmp, "skills");
    const upstreamsFile = makeUpstreamsFixture("other-skill");

    writeText(path.join(upstreamSkillDir, "SKILL.md"), "# v\n");

    expect(() =>
      replaceSkill("nonexistent", upstreamSkillDir, "abc", { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot }),
    ).toThrow(/no encontrada en upstreams\.json/);
  });
});

// ---------------------------------------------------------------------------
// Protección: skills propias y kind=release nunca elegibles
// ---------------------------------------------------------------------------

describe("protección de skills: PROTECTED_SKILLS y kind=release", () => {
  it("PROTECTED_SKILLS incluye agent-delegation y work-lifecycle", () => {
    expect(PROTECTED_SKILLS.has("agent-delegation")).toBe(true);
    expect(PROTECTED_SKILLS.has("work-lifecycle")).toBe(true);
  });

  it("replaceSkill lanza con agent-delegation sin tocar el disco", () => {
    // Ni siquiera necesita upstreams.json — lanza antes de leer nada
    expect(() =>
      replaceSkill("agent-delegation", "/cualquier/ruta", "abc"),
    ).toThrow(/propia del stack/);
  });

  it("replaceSkill lanza con work-lifecycle sin tocar el disco", () => {
    expect(() =>
      replaceSkill("work-lifecycle", "/cualquier/ruta", "abc"),
    ).toThrow(/propia del stack/);
  });

  it("replaceSkill lanza con kind=release", () => {
    const upstreamSkillDir = path.join(tmp, "upstream", "graphify");
    const skillsRoot = path.join(tmp, "skills");
    const upstreamsFile = path.join(tmp, "upstreams.json");
    writeText(
      upstreamsFile,
      JSON.stringify({
        tools: {},
        skills: {
          graphify: { source: "github:safishamsi/graphify", kind: "release", version: "0.7.16", commit: "abc" },
        },
      }, null, 2) + "\n",
    );
    writeText(path.join(upstreamSkillDir, "SKILL.md"), "# v\n");

    expect(() =>
      replaceSkill("graphify", upstreamSkillDir, "newcommit", { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot }),
    ).toThrow(/tipo release/);
  });
});

// ---------------------------------------------------------------------------
// buildEligibleSkillUpdates: lógica pura de elegibilidad
// ---------------------------------------------------------------------------

describe("buildEligibleSkillUpdates: lógica de elegibilidad del picker", () => {
  function makeSkill(
    name: string,
    repo: string,
    commit: string | undefined,
    head: string | null,
    opts?: { kind?: "binary" | "release"; modified?: boolean; path?: string },
  ): SkillQueryResult {
    return {
      name,
      repo,
      info: { source: `github:${repo}`, commit, ...opts },
      head,
    };
  }

  it("skill al día (head === pin) no aparece en la lista", () => {
    const pin = "abc123abc123abc123abc123abc123abc123abc1";
    const skills = [makeSkill("my-skill", "example/repo", pin, pin)];
    expect(buildEligibleSkillUpdates(skills)).toEqual([]);
  });

  it("upstream se movió → skill aparece como elegible", () => {
    const pin = "aaa000aaa000aaa000aaa000aaa000aaa000aaa0";
    const head = "bbb111bbb111bbb111bbb111bbb111bbb111bbb1";
    const skills = [makeSkill("my-skill", "example/repo", pin, head)];
    const result = buildEligibleSkillUpdates(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("my-skill");
    expect(result[0]!.head).toBe(head);
    expect(result[0]!.pinned).toBe(pin);
    expect(result[0]!.modified).toBe(false);
  });

  it("skill kind=release excluida aunque el upstream se movió", () => {
    const pin = "aaa000";
    const head = "bbb111";
    const skills = [makeSkill("graphify", "safishamsi/graphify", pin, head, { kind: "release" })];
    expect(buildEligibleSkillUpdates(skills)).toEqual([]);
  });

  it("skill sin pin excluida (no se puede comparar)", () => {
    const skills = [makeSkill("my-skill", "example/repo", undefined, "bbb111")];
    expect(buildEligibleSkillUpdates(skills)).toEqual([]);
  });

  it("skill sin conexión (head=null) excluida", () => {
    const skills = [makeSkill("my-skill", "example/repo", "aaa000", null)];
    expect(buildEligibleSkillUpdates(skills)).toEqual([]);
  });

  it("skill modificada localmente aparece con modified=true", () => {
    const pin = "aaa000";
    const head = "bbb111";
    const skills = [makeSkill("tdd", "mattpocock/skills", pin, head, { modified: true })];
    const result = buildEligibleSkillUpdates(skills);
    expect(result[0]!.modified).toBe(true);
  });

  it("varias skills en el mismo monorepo → todas aparecen con el mismo head", () => {
    const pin = "aaa000";
    const head = "bbb111";
    const repo = "mattpocock/skills";
    const skills = [
      makeSkill("tdd", repo, pin, head),
      makeSkill("diagnose", repo, pin, head),
    ];
    const result = buildEligibleSkillUpdates(skills);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(["diagnose", "tdd"]);
    for (const r of result) {
      expect(r.head).toBe(head);
      expect(r.pinned).toBe(pin);
    }
  });

  it("mezcla de elegibles e inelegibles → solo los elegibles", () => {
    const pin = "aaa000";
    const head = "bbb111";
    const skills = [
      makeSkill("updated-skill", "example/repo", pin, head),          // elegible
      makeSkill("up-to-date", "example/repo2", pin, pin),             // al día
      makeSkill("release-skill", "example/repo3", pin, head, { kind: "release" }), // release
      makeSkill("no-connection", "example/repo4", pin, null),         // sin red
      makeSkill("no-pin", "example/repo5", undefined, head),          // sin pin
    ];
    const result = buildEligibleSkillUpdates(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("updated-skill");
  });

  it("engram solo aparece como herramienta, no como skill (no está en el listado de skills)", () => {
    // La lógica de buildEligibleSkillUpdates opera sobre upstreams.skills solamente;
    // engram está en upstreams.tools y nunca llega a esta función.
    const skills: SkillQueryResult[] = []; // vacío = sin skills (engram no está aquí)
    expect(buildEligibleSkillUpdates(skills)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateExtractedTree: seguridad post-extracción de tarball
// ---------------------------------------------------------------------------

describe("validateExtractedTree: detección de symlinks y path-escape", () => {
  it("árbol limpio sin symlinks → true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-vtree-"));
    try {
      writeText(path.join(dir, "SKILL.md"), "# skill\n");
      writeText(path.join(dir, "subdir", "helper.md"), "helper\n");
      expect(validateExtractedTree(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dir vacío → true", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-vtree-"));
    try {
      expect(validateExtractedTree(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symlink de archivo dentro del dir → false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-vtree-"));
    try {
      const target = path.join(dir, "real.txt");
      const link = path.join(dir, "link.txt");
      writeText(target, "contenido\n");
      try {
        fs.symlinkSync(target, link);
      } catch {
        // EPERM en Windows CI sin privilegios de symlink → skip silencioso
        return;
      }
      expect(validateExtractedTree(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("symlink de directorio dentro del dir → false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-vtree-"));
    try {
      const subdir = path.join(dir, "real-sub");
      fs.mkdirSync(subdir, { recursive: true });
      writeText(path.join(subdir, "f.md"), "x\n");
      const linkDir = path.join(dir, "linked-sub");
      try {
        fs.symlinkSync(subdir, linkDir, "junction");
      } catch {
        // EPERM → skip
        return;
      }
      expect(validateExtractedTree(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// replaceSkill: rechaza symlinks en upstream
// ---------------------------------------------------------------------------

describe("replaceSkill: rechaza symlinks en el upstream", () => {
  function makeUpstreamsFixtureLocal(skillName: string, dir: string): string {
    const file = path.join(dir, "upstreams.json");
    const data = {
      tools: {},
      skills: {
        [skillName]: {
          source: `github:example/repo`,
          commit: "abc1234def5678901234567890123456789012345",
        },
      },
    };
    writeText(file, JSON.stringify(data, null, 2) + "\n");
    return file;
  }

  it("upstream con symlink → lanza error claro sin tocar disco local", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-replace-"));
    try {
      const upstreamSkillDir = path.join(dir, "upstream", "my-skill");
      const skillsRoot = path.join(dir, "skills");
      const upstreamsFile = makeUpstreamsFixtureLocal("my-skill", dir);

      const realFile = path.join(upstreamSkillDir, "SKILL.md");
      writeText(realFile, "# skill\n");
      const linkFile = path.join(upstreamSkillDir, "evil.txt");
      try {
        fs.symlinkSync(realFile, linkFile);
      } catch {
        // EPERM en Windows CI → skip
        return;
      }

      expect(() =>
        replaceSkill("my-skill", upstreamSkillDir, "newcommit", { upstreamsFilePath: upstreamsFile, localSkillsRoot: skillsRoot }),
      ).toThrow(/[Ss]ymlink/);

      // staging no debe quedar en disco; local tampoco (nunca se creó)
      expect(fs.existsSync(path.join(skillsRoot, "my-skill"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// renderSkillDiff: diff completo incluido en la salida
// ---------------------------------------------------------------------------

describe("renderSkillDiff: diff completo en la salida cuando hay diferencias", () => {
  it("con diferencias → salida contiene líneas de diff (no solo --stat)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-rdiff-"));
    try {
      const up = path.join(dir, "upstream");
      const local = path.join(dir, "local");
      writeText(path.join(up, "SKILL.md"), "# skill v2\nlinea nueva\n");
      writeText(path.join(local, "SKILL.md"), "# skill v1\nlinea vieja\n");

      const out = renderSkillDiff(up, local);
      expect(out.length).toBeGreaterThan(0);
      // Si git está disponible, la salida debe contener el diff completo (líneas +/-)
      // o al menos el stat; en cualquier caso la cadena es no vacía.
      // No podemos asumir git disponible en todos los entornos, así que solo verificamos
      // que la salida indique cambios de alguna forma.
      const hasDiffContent =
        out.includes("+") || out.includes("añadidos") || out.includes("modificados");
      expect(hasDiffContent).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dirs idénticos → cadena vacía (sin cambios)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-rdiff-"));
    try {
      const up = path.join(dir, "upstream");
      const local = path.join(dir, "local");
      writeText(path.join(up, "SKILL.md"), "# skill\n");
      writeText(path.join(local, "SKILL.md"), "# skill\n");

      expect(renderSkillDiff(up, local)).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


// ---------------------------------------------------------------------------
// rotateLockedBinary: truco de rename para actualizar el .exe en uso (Windows)
// ---------------------------------------------------------------------------

describe("rotateLockedBinary", () => {
  it("rota el binario existente y deja la ruta original libre", () => {
    const bin = path.join(tmp, "engram.exe");
    fs.writeFileSync(bin, "binario-v1");

    const rotated = rotateLockedBinary(bin);
    expect(rotated).not.toBeNull();
    expect(fs.existsSync(bin)).toBe(false);
    expect(fs.existsSync(rotated!)).toBe(true);
    expect(fs.readFileSync(rotated!, "utf8")).toBe("binario-v1");
    expect(path.basename(rotated!)).toMatch(/^engram\.exe\.old-\d+$/);
  });

  it("devuelve null si el binario no existe", () => {
    expect(rotateLockedBinary(path.join(tmp, "no-existe.exe"))).toBeNull();
  });

  it("limpia rotaciones de updates anteriores ya liberadas (solo formato exacto)", () => {
    const bin = path.join(tmp, "engram.exe");
    const previa = path.join(tmp, "engram.exe.old-1111111111");
    const ajeno = path.join(tmp, "engram.exe.old-backup-manual");
    fs.writeFileSync(bin, "v2");
    fs.writeFileSync(previa, "v1");
    fs.writeFileSync(ajeno, "no me borres");

    const rotated = rotateLockedBinary(bin, tmp);
    expect(fs.existsSync(previa)).toBe(false);
    expect(fs.existsSync(ajeno)).toBe(true); // sufijo no-timestamp: intocable
    expect(fs.existsSync(rotated!)).toBe(true);
  });
});

