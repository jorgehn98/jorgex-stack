import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listBackups } from "../src/lib/backup.js";
import { findOrphans, readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { writeText } from "../src/lib/fsx.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";

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
