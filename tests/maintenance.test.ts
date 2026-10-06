import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackup, listBackups, restoreBackup } from "../src/lib/backup.js";
import { readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { isContainedIn, writeText } from "../src/lib/fsx.js";
import { readTomlSection } from "../src/lib/filemerge.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { TEST_MODEL_MAP as DEFAULT_MODEL_MAP } from "./fixtures/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-maint-"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("permisos por defecto: lectura externa sin write-anywhere", () => {
  const makeCtx = (id: "opencode" | "codex") => ({
    stackDir: stackRoot(),
    configDir: tmp,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[id]!,
    warnings: [],
  });
  const mcp = () => loadCanonicalMcp(stackRoot());

  it("opencode: una config no vacía sin permissions no recibe el bloque ni se auto-migra", () => {
    writeText(path.join(tmp, "opencode.json"), JSON.stringify({ other: true }));

    const ctx = makeCtx("opencode");
    const [action] = opencodeAdapter.planMainConfig(mcp(), ctx);
    const config = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(config.other).toBe(true);
    expect(config).not.toHaveProperty("permissions");
    expect(config).not.toHaveProperty("permission");
    expect(ctx.warnings.join("\n")).toContain("manually after creating a backup");
  });

  it("opencode: la config fresca avisa sobre stores de secretos más amplios", () => {
    const ctx = makeCtx("opencode");
    opencodeAdapter.planMainConfig(mcp(), ctx);
    expect(ctx.warnings.join("\n")).toMatch(/ordinary|sensitive/i);
  });

  it("codex: la config fresca no pregunta y deniega solo directorios de credenciales", () => {
    const ctx = makeCtx("codex");
    const [action] = codexAdapter.planMainConfig(mcp(), ctx);
    const fresh = (action as { content: string }).content;
    expect(fresh).toContain('approval_policy = "never"');
    expect(fresh).toContain('default_permissions = "jorgex-yolo"');
    expect(fresh).not.toContain("sandbox_mode");
    expect(readTomlSection(fresh, "permissions.jorgex-yolo")?.trimEnd()).toBe('extends = ":workspace"');
    expect(readTomlSection(fresh, "permissions.jorgex-yolo.network")?.trimEnd()).toBe("enabled = true");
    // Codex 0.158 + bubblewrap: dos o más ARCHIVOS denegados existentes rompen
    // todo el sandbox; solo se deniegan directorios. `:root = write` tampoco arranca.
    expect(readTomlSection(fresh, "permissions.jorgex-yolo.filesystem")?.trimEnd()).toBe(
      '":root" = "read"\n"~" = "write"\n"~/.ssh" = "deny"\n"~/.aws" = "deny"',
    );
    expect(readTomlSection(fresh, "permissions.jorgex-yolo.filesystem.:workspace_roots")?.trimEnd()).toBe('"." = "write"');
    expect(fresh).not.toMatch(/\.env|\.pem|\.key|\.npmrc|credentials"/);
    expect(ctx.warnings.join("\n")).toMatch(/\.env/);
  });

  it("codex: una config no vacía sin default_permissions ni [permissions.*] no recibe el perfil", () => {
    writeText(path.join(tmp, "config.toml"), 'other = "value"\n');

    const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const content = (action as { content: string }).content;

    expect(content).toContain('other = "value"');
    expect(content).not.toContain('default_permissions = "jorgex-yolo"');
    expect(readTomlSection(content, "permissions.jorgex-yolo")).toBeNull();
  });

  it("codex: la config custom conserva default_permissions y no auto-migra el perfil", () => {
    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\ndefault_permissions = "custom"\nsandbox_mode = "workspace-write"\n');
    const [action2] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const existing = (action2 as { content: string }).content;
    expect(existing).toContain('approval_policy = "never"');
    expect(existing).toContain('default_permissions = "custom"');
    expect(existing).toContain('sandbox_mode = "workspace-write"');
    expect(existing).not.toContain('[permissions.jorgex-yolo]');
  });

  it.each(["read-only", "danger-full-access"] as const)(
    "codex: sandbox_mode %s sin permisos no deja un default_permissions colgando",
    (sandboxMode) => {
      writeText(path.join(tmp, "config.toml"), `approval_policy = "never"\nsandbox_mode = "${sandboxMode}"\n`);

      const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
      const content = (action as { content: string }).content;

      expect(content).toContain(`sandbox_mode = "${sandboxMode}"`);
      expect(content).not.toContain('default_permissions = "jorgex-yolo"');
      expect(content).not.toContain('[permissions.jorgex-yolo]');
    },
  );

  it("codex: sandbox_mode con comentario inline se respeta como sandbox custom y no activa el perfil jorgex", () => {
    writeText(
      path.join(tmp, "config.toml"),
      'approval_policy = "never"\nsandbox_mode = "read-only" # custom\n',
    );

    const custom = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(custom).toContain('sandbox_mode = "read-only" # custom');
    expect(custom).not.toContain('default_permissions = "jorgex-yolo"');
    expect(custom).not.toContain('[permissions.jorgex-yolo]');
  });

  it("codex: la config con [permissions.custom] no recibe default_permissions ni el perfil jorgex", () => {
    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\n[permissions.custom]\nallow = ["Read"]\n');
    const custom = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(custom).toContain('approval_policy = "never"');
    expect(custom).toContain('[permissions.custom]');
    expect(custom).not.toContain('default_permissions = "jorgex-yolo"');
    expect(custom).not.toContain('[permissions.jorgex-yolo]');

    writeText(path.join(tmp, "config.toml"), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');

    const [legacy] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const preserved = (legacy as { content: string }).content;
    expect(preserved).toContain('approval_policy = "on-request"');
    expect(preserved).toContain('sandbox_mode = "workspace-write"');
    expect(preserved).not.toContain('default_permissions = "jorgex-yolo"');
    expect(preserved).not.toContain("[permissions.jorgex-yolo]");
  });

  it("codex: el legacy workspace-write con comentario inline se preserva sin perfil jorgex", () => {
    writeText(
      path.join(tmp, "config.toml"),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write" # old default\n',
    );

    const preserved = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(preserved).toContain('approval_policy = "on-request"');
    expect(preserved).toContain('sandbox_mode = "workspace-write" # old default');
    expect(preserved).not.toContain('default_permissions = "jorgex-yolo"');
    expect(preserved).not.toContain("[permissions.jorgex-yolo]");
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

  it("manifest ausente devuelve vacío y corrupto bloquea mutaciones", () => {
    expect(readManifest(path.join(tmp, "nope.json")).runtimes).toEqual({});
    const corrupt = path.join(tmp, "bad.json");
    writeText(corrupt, "{nope");
    expect(() => readManifest(corrupt)).toThrow(/Manifest inválido/);
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
