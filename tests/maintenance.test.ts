import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listBackups } from "../src/lib/backup.js";
import { findOrphans, readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { writeText } from "../src/lib/fsx.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

let tmp: string;

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
    secrets: {},
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
      secrets: {},
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

  it("findOrphans: solo archivos existentes fuera del plan actual, nunca engram.ts", () => {
    const stale = path.join(tmp, "skills", "old-skill", "SKILL.md");
    const kept = path.join(tmp, "skills", "current", "SKILL.md");
    const engram = path.join(tmp, "plugins", "engram.ts");
    for (const f of [stale, kept, engram]) writeText(f, "x");

    const current = new Set([path.resolve(kept)]);
    const orphans = findOrphans([stale, kept, engram, path.join(tmp, "ya-borrado.md")], current);
    expect(orphans).toEqual([path.resolve(stale)]);
  });
});
