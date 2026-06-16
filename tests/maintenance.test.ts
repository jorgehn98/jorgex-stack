import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, restoreBackup } from "../src/lib/backup.js";
import { findOrphans, readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { isContainedIn, writeText } from "../src/lib/fsx.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

let tmp: string;

const readStackFile = (relativePath: string) =>
  fs.readFileSync(path.join(stackRoot(), relativePath), "utf8");

const expectFragments = (content: string, fragments: string[]) => {
  for (const fragment of fragments) {
    expect(content).toContain(fragment);
  }
};

const REVIEW_ENTRYPOINT_CASES = [
  {
    relativePath: "commands/xreview.md",
    contractFragments: [
      "4R internally",
      "comment-fixer",
      "test-analyzer",
      "silent-failure-hunter",
      "type-design-analyzer",
      "code-reviewer",
      "code-simplifier",
      "security-auditor",
      "not add a separate 4R section or taxonomy",
    ],
  },
  {
    relativePath: "scripts/post-pr-review.cjs",
    contractFragments: [
      "stays internal",
      "Reliability / Resilience / Readability / Risk",
      "comment-fixer",
      "test-analyzer",
      "silent-failure-hunter",
      "type-design-analyzer",
      "code-reviewer",
      "code-simplifier",
      "security-auditor",
      "extra agents",
    ],
  },
] as const;

const FOUR_R_LENS_CASES = [
  {
    relativePath: "agents/security-auditor.md",
    header: "## 4R Risk Lens",
    fragments: ["auth, authorization, secrets, sensitive data, input validation, webhooks", "input validation", "Webhooks & external callbacks"],
  },
  {
    relativePath: "agents/code-simplifier.md",
    header: "## 4R Readability Lens",
    fragments: ["nested ternary operators", "guard clauses", "readability/maintainability"],
  },
  {
    relativePath: "agents/test-analyzer.md",
    header: "## 4R Reliability Lens",
    fragments: ["external contracts", "negative test cases", "async/concurrency behavior", "behavioral coverage rather than line coverage"],
  },
  {
    relativePath: "agents/silent-failure-hunter.md",
    header: "## 4R Resilience Lens",
    fragments: ["fallback, retry, degradation", "rollback", "fix-forward behavior"],
  },
] as const;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-maint-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("backup: dedup de snapshots idénticos", () => {
  it("reutiliza el backup más reciente si el contenido no ha cambiado", () => {
    const file = path.join(tmp, "config.json");
    writeText(file, '{"a":1}\n');
    const root = path.join(tmp, "backups");

    const first = createBackup([file], "install-test", root)!;
    const second = createBackup([file], "uninstall-test", root)!;
    expect(second.id).toBe(first.id);
    expect(listBackups(root)).toHaveLength(1);
  });

  it("crea un backup nuevo cuando el contenido cambia", () => {
    const file = path.join(tmp, "config.json");
    const root = path.join(tmp, "backups");
    writeText(file, '{"a":1}\n');
    const first = createBackup([file], "t", root)!;
    writeText(file, '{"a":2}\n');
    const second = createBackup([file], "t", root)!;
    expect(second.id).not.toBe(first.id);
    expect(listBackups(root)).toHaveLength(2);
  });
});

describe("permisos por defecto: solo si el usuario no los tiene", () => {
  const makeCtx = (id: "opencode" | "codex") => ({
    stackDir: stackRoot(),
    configDir: tmp,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[id]!,
    warnings: [],
  });
  const mcp = () => loadCanonicalMcp(stackRoot());

  it("opencode: los añade si faltan, respeta los existentes", () => {
    const [action] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const fresh = JSON.parse((action as { content: string }).content);
    expect(fresh.permission.bash["rm *"]).toBe("ask");

    writeText(path.join(tmp, "opencode.json"), JSON.stringify({ permission: { edit: "deny" } }));
    const [action2] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const existing = JSON.parse((action2 as { content: string }).content);
    expect(existing.permission).toEqual({ edit: "deny" });
  });

  it("codex: añade approval_policy/sandbox_mode si faltan, respeta los existentes", () => {
    const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const fresh = (action as { content: string }).content;
    expect(fresh).toContain('approval_policy = "on-request"');
    expect(fresh).toContain('sandbox_mode = "workspace-write"');

    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\n');
    const [action2] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const existing = (action2 as { content: string }).content;
    expect(existing).toContain('approval_policy = "never"');
    expect(existing).not.toContain('approval_policy = "on-request"');
    expect(existing).toContain('sandbox_mode = "workspace-write"'); // esta sí faltaba
  });
});

describe("planPlugins: placeholders resueltos", () => {
  it("engram.ts recibe el protocolo canónico y el binario, sin placeholders", async () => {
    const { planPlugins } = await import("../src/components/plugins.js");
    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: "C:\\bin\\engram.exe",
      models: DEFAULT_MODEL_MAP.opencode!,
      warnings: [],
    };
    const actions = planPlugins(opencodeAdapter, ctx);
    const engram = actions.find((a) => a.target.endsWith("engram.ts"))!;
    expect(engram.kind).toBe("write");
    const content = (engram as { content: string }).content;
    expect(content).toContain("Engram Memory Protocol"); // protocolo canónico inyectado
    expect(content).toContain("engram.exe");
    expect(content).not.toContain("{{ENGRAM_PROTOCOL}}");
    expect(content).not.toContain("{{ENGRAM_BIN}}");
  });
});

describe("renderCommand de OpenCode", () => {
  it("traduce {{input}} a $ARGUMENTS (placeholder oficial de OpenCode)", () => {
    const out = opencodeAdapter.renderCommand("xreview.md", "Review.\n\nInput: {{input}}\n");
    expect(out.content).toContain("$ARGUMENTS");
    expect(out.content).not.toContain("{{input}}");
  });
});

describe("manifest de instalación", () => {
  it("write → read → remove por runtime sin tocar a los demás", () => {
    const file = path.join(tmp, "manifest.json");
    writeRuntimeManifest("codex", { configDir: "/x/.codex", owned: ["/x/a.toml"], updatedAt: "t" }, file);
    writeRuntimeManifest("opencode", { configDir: "/x/oc", owned: ["/x/b.json"], updatedAt: "t" }, file);

    removeRuntimeManifest("codex", file);
    const manifest = readManifest(file);
    expect(manifest.runtimes.codex).toBeUndefined();
    expect(manifest.runtimes.opencode?.owned).toEqual(["/x/b.json"]);
  });

  it("manifest ausente o corrupto devuelve vacío sin lanzar", () => {
    expect(readManifest(path.join(tmp, "nope.json")).runtimes).toEqual({});
    const corrupt = path.join(tmp, "bad.json");
    writeText(corrupt, "{nope");
    expect(readManifest(corrupt).runtimes).toEqual({});
  });

  it("findOrphans: solo archivos existentes fuera del plan actual, nunca engram.ts ni fuera del root", () => {
    const root = path.join(tmp, "home");
    const stale = path.join(root, "skills", "old-skill", "SKILL.md");
    const kept = path.join(root, "skills", "current", "SKILL.md");
    const engram = path.join(root, "plugins", "engram.ts");
    const foreign = path.join(tmp, "fuera-del-root.md"); // existe, pero un manifest manipulado no puede borrarlo
    for (const f of [stale, kept, engram, foreign]) writeText(f, "x");

    const current = new Set([path.resolve(kept)]);
    const orphans = findOrphans([stale, kept, engram, foreign, path.join(root, "ya-borrado.md")], current, root);
    expect(orphans).toEqual([path.resolve(stale)]);
  });
});

describe("contención de rutas (manifest/backup manipulados)", () => {
  it("isContainedIn: dentro sí; el propio root, hermanos y traversal no", () => {
    const root = path.join(tmp, "home");
    expect(isContainedIn(path.join(root, "a", "b.txt"), root)).toBe(true);
    expect(isContainedIn(root, root)).toBe(false);
    expect(isContainedIn(path.join(tmp, "otro", "c.txt"), root)).toBe(false);
    expect(isContainedIn(path.join(root, "..", "evil.txt"), root)).toBe(false);
  });

  it("restoreBackup no escribe fuera de la frontera", () => {
    const boundary = path.join(tmp, "home");
    const inside = path.join(boundary, "config.json");
    const outside = path.join(tmp, "fuera", "config.json");
    writeText(inside, "a");
    writeText(outside, "b");

    const root = path.join(tmp, "backups");
    const info = createBackup([inside, outside], "t", root)!;
    fs.rmSync(inside);
    fs.rmSync(outside);

    expect(restoreBackup(info.id, root, boundary)).toBe(1);
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe("contrato 4R", () => {
  it("stack/agents no introduce agentes review-* duplicados", () => {
    const agentsDir = path.join(stackRoot(), "agents");
    const duplicateAgents = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^review-.*\.md$/.test(entry.name))
      .map((entry) => entry.name);

    expect(duplicateAgents).toEqual([]);
  });

  it.each(REVIEW_ENTRYPOINT_CASES)("$relativePath fija 4R interno y routing canónico", ({ relativePath, contractFragments }) => {
    const content = readStackFile(relativePath);
    expectFragments(content, [...contractFragments]);
    expect(content).not.toContain("review-risk");
    expect(content).not.toContain("review-readability");
    expect(content).not.toContain("review-reliability");
    expect(content).not.toContain("review-resilience");
  });

  it.each(FOUR_R_LENS_CASES)("$relativePath conserva las señales de su lente 4R", ({ relativePath, header, fragments }) => {
    expectFragments(readStackFile(relativePath), [header, ...fragments]);
  });
});
