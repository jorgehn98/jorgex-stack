import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * RED backup contract for Claude under Engram 2.0.0.
 *
 * Real diagnosis (Claude 2.1.267 + Engram 2.0.0):
 * - Registry v2 `plugins/installed_plugins.json` holds
 *   `plugins["engram@engram"][0].installPath=<config>/plugins/cache/
 *   engram/engram/0.1.3`; rollback must cover the `cache/engram` tree.
 * - `plugins/known_marketplaces.json` + `plugins/marketplaces/engram` track
 *   the marketplace source; both must be restorable.
 * - Exact user MCP is `<config>/.claude.json` (nested with CLAUDE_CONFIG_DIR
 *   custom, sibling `~/.claude.json` with the default layout).
 * - Obsolete `<config>/mcp/engram.json` (1.20.0/2.0.0-rc.11) is ignored by the
 *   CLI but may still exist; rollback must cover it without ever treating it
 *   as MCP evidence.
 * - `settings.json` carries `enabledPlugins["engram@engram"]===true`.
 *
 * Current `collectOfficialSetupBackupTargets` only returns settings,
 * installed_plugins, one .claude.json and the marketplace dir, so both
 * assertions below must FAIL now (missing known_marketplaces, cache/engram
 * and obsolete mcp/engram.json).
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

describe("[claude-2.0.0] backup covers 2.0.0 registry/cache/MCP locations", () => {
  it("default configDir backs up settings, registries, marketplace dir, cache tree, exact sibling MCP and obsolete file", async () => {
    const home = tempHome("jx-claude200-backup-default-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const targets = mod.collectOfficialSetupBackupTargets("claude-code", configDir, home) as string[];

    // Pre-existing (must keep passing after GREEN).
    expect(targets).toContain(path.join(configDir, "settings.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "installed_plugins.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "marketplaces", "engram"));
    expect(targets).toContain(path.join(home, ".claude.json"));

    // 2.0.0 additions: registry index, cache tree holding installPath,
    // and the obsolete file (rollback only, never MCP evidence).
    expect(targets).toContain(path.join(configDir, "plugins", "known_marketplaces.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "cache", "engram"));
    expect(targets).toContain(path.join(configDir, "mcp", "engram.json"));
  });

  it("custom configDir backs up nested MCP plus fallback sibling and the same 2.0.0 registry/cache/obsolete set", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-claude200-backup-custom-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const configDir = path.join(home, "custom-claude");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const targets = mod.collectOfficialSetupBackupTargets("claude-code", configDir, home) as string[];

    expect(targets).toContain(path.join(configDir, "settings.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "installed_plugins.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "known_marketplaces.json"));
    expect(targets).toContain(path.join(configDir, "plugins", "marketplaces", "engram"));
    expect(targets).toContain(path.join(configDir, "plugins", "cache", "engram"));
    // Exact nested location the 2.0.0 setup writes with CLAUDE_CONFIG_DIR.
    expect(targets).toContain(path.join(configDir, ".claude.json"));
    // Conservative fallback: a custom run must never leave the default
    // sibling without rollback.
    expect(targets).toContain(path.join(home, ".claude.json"));
    // Obsolete file (rollback only).
    expect(targets).toContain(path.join(configDir, "mcp", "engram.json"));
  });
});
