import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * RED contract for Claude verifier under Engram 2.0.0 (tasks/13, corrected).
 *
 * Real diagnosis (Claude 2.1.267 + Engram 2.0.0, CLAUDE_CONFIG_DIR semantics):
 * - With CLAUDE_CONFIG_DIR absent, Engram 2.0.0 writes and Claude consumes
 *   the sibling `$HOME/.claude.json`; the nested `$HOME/.claude/.claude.json`
 *   is absent; `claude mcp list` shows Connected from the sibling.
 * - With CLAUDE_CONFIG_DIR set to a custom dir, the provider writes and
 *   Claude consumes the nested `$CLAUDE_CONFIG_DIR/.claude.json`.
 * - 1.20.0 / 2.0.0-rc.11 write obsolete `<config>/mcp/engram.json`; the CLI
 *   ignores it (`claude mcp list` shows none).
 * - Plugin `engram@engram` ships 0 bundled MCP; the installed registry v2
 *   holds `plugins["engram@engram"][0].installPath=<config>/plugins/cache/
 *   engram/engram/0.1.3` with scope user/version/gitCommitSha; enablement is
 *   `settings.json enabledPlugins["engram@engram"]===true`.
 * - Official hooks/scripts live under installPath (`hooks/hooks.json` +
 *   `scripts/`), not the marketplace source tree.
 * - `resolveOfficialSetupEnv`/wiring must NOT force CLAUDE_CONFIG_DIR for the
 *   default `<home>/.claude` (let Claude use the sibling default); a custom
 *   configDir must pass `CLAUDE_CONFIG_DIR=<custom>`.
 * - `detectClaudeCode` must honor `process.env.CLAUDE_CONFIG_DIR` so
 *   runtime/setup/verify share the custom config.
 *
 * The current `verifyOfficialSetup` only trusts the nested
 * `<config>/.claude.json` (nested-only default), always forces
 * CLAUDE_CONFIG_DIR, ignores CLAUDE_CONFIG_DIR in detection, and only
 * rejects a final installPath symlink (not ancestors). The default-sibling
 * positive, the default nested-only negative, the ancestor-symlink, the
 * default-env and the detect-custom cases below must FAIL now. Custom
 * nested/sibling-only, marketplace/disabled/missing/foreign and the
 * obsolete-only control lock the rest of the contract.
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

const OFFICIAL_HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "session-start.sh" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "session-end.sh" }] }],
  },
};

function writeInstallPathTree(installPath: string): void {
  fs.mkdirSync(path.join(installPath, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(installPath, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(installPath, "hooks", "hooks.json"), JSON.stringify(OFFICIAL_HOOKS));
  fs.writeFileSync(path.join(installPath, "scripts", "session-start.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(installPath, "scripts", "session-end.sh"), "#!/bin/sh\n");
}

function writeMarketplaceTree(configDir: string): string {
  const marketplace = path.join(configDir, "plugins", "marketplaces", "engram");
  fs.mkdirSync(path.join(marketplace, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(marketplace, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(marketplace, "hooks", "hooks.json"), JSON.stringify(OFFICIAL_HOOKS));
  fs.writeFileSync(path.join(marketplace, "scripts", "session-start.sh"), "#!/bin/sh\n");
  return marketplace;
}

function writeExactNestedMcp(configDir: string, engramBin: string): string {
  const file = path.join(configDir, ".claude.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ mcpServers: { engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"], env: {} } } }),
  );
  return file;
}

function writeExactSiblingMcp(home: string, engramBin: string): string {
  const file = path.join(home, ".claude.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ mcpServers: { engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"], env: {} } } }),
  );
  return file;
}

function writeRegistryWithInstallPath(configDir: string, installPath: string): void {
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "engram@engram": [{ scope: "user", version: "0.1.3", installPath, gitCommitSha: "abc1234" }],
      },
    }),
  );
}

function writeRegistryWithoutInstallPath(configDir: string): void {
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "engram@engram": [{ version: "1.20.0" }] } }),
  );
}

function writeEnabled(configDir: string, enabled: boolean): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "engram@engram": enabled } }),
  );
}

/** Valid 2.0.0 default layout: registry installPath + enabled + SIBLING MCP + hooks at installPath. */
function seedValid200Default(home: string): { configDir: string; engramBin: string; installPath: string } {
  const configDir = path.join(home, ".claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
  writeRegistryWithInstallPath(configDir, installPath);
  writeEnabled(configDir, true);
  // Correct default: sibling present, nested absent.
  fs.mkdirSync(configDir, { recursive: true });
  writeExactSiblingMcp(home, engramBin);
  expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(false);
  writeInstallPathTree(installPath);
  return { configDir, engramBin, installPath };
}

/** Valid 2.0.0 custom layout: registry installPath + enabled + NESTED MCP + hooks at installPath. */
function seedValid200Custom(home: string): { configDir: string; engramBin: string; installPath: string } {
  const configDir = path.join(home, "custom-claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
  writeRegistryWithInstallPath(configDir, installPath);
  writeEnabled(configDir, true);
  // Correct custom: nested present, sibling absent (isolates the mode).
  writeExactNestedMcp(configDir, engramBin);
  expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  writeInstallPathTree(installPath);
  return { configDir, engramBin, installPath };
}

describe("[claude-2.0.0] verifier default mode uses sibling, not nested-only", () => {
  it("default accepts the exact 2.0.0 layout (registry installPath, enabled, sibling MCP, hooks at installPath)", async () => {
    const home = tempHome("jx-claude200-valid-default-");
    const { configDir, engramBin } = seedValid200Default(home);
    // No marketplace source tree and no obsolete file: hooks/MCP come only
    // from installPath and the exact sibling $HOME/.claude.json.
    expect(fs.existsSync(path.join(configDir, "plugins", "marketplaces", "engram"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "mcp", "engram.json"))).toBe(false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["plugin", "mcp", "hooks"]));
  });

  it("default rejects wrong nested-only MCP (nested present, sibling absent)", async () => {
    const home = tempHome("jx-claude200-default-nested-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
    writeRegistryWithInstallPath(configDir, installPath);
    writeEnabled(configDir, true);
    writeInstallPathTree(installPath);
    // Wrong location for default: only the nested file carries the MCP.
    fs.mkdirSync(configDir, { recursive: true });
    writeExactNestedMcp(configDir, engramBin);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/mcp/i);
  });
});

describe("[claude-2.0.0] verifier custom mode uses nested, not sibling-only", () => {
  it("custom accepts the exact 2.0.0 layout (registry installPath, enabled, nested MCP, hooks at installPath)", async () => {
    const home = tempHome("jx-claude200-valid-custom-");
    const { configDir, engramBin } = seedValid200Custom(home);
    expect(fs.existsSync(path.join(configDir, "plugins", "marketplaces", "engram"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "mcp", "engram.json"))).toBe(false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["plugin", "mcp", "hooks"]));
  });

  it("custom rejects sibling-only MCP (sibling present, nested absent)", async () => {
    const home = tempHome("jx-claude200-custom-sibling-");
    const configDir = path.join(home, "custom-claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
    writeRegistryWithInstallPath(configDir, installPath);
    writeEnabled(configDir, true);
    writeInstallPathTree(installPath);
    // Wrong location for custom: only the default sibling carries the MCP.
    fs.mkdirSync(configDir, { recursive: true });
    writeExactSiblingMcp(home, engramBin);
    expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/mcp/i);
  });
});

describe("[claude-2.0.0] verifier still rejects plugin/foreign problems in both modes", () => {
  it("rejects marketplace-only hooks without a registry installPath (default sibling present)", async () => {
    const home = tempHome("jx-claude200-market-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    writeRegistryWithoutInstallPath(configDir);
    writeEnabled(configDir, true);
    // Both MCP locations carry the exact entry so the failure must be the
    // plugin layer, under either the old nested-only or the corrected
    // dual-mode contract.
    writeExactSiblingMcp(home, engramBin);
    writeExactNestedMcp(configDir, engramBin);
    writeMarketplaceTree(configDir);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
  });

  it("rejects a disabled plugin even with exact MCP in both locations", async () => {
    const home = tempHome("jx-claude200-disabled-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    writeRegistryWithoutInstallPath(configDir);
    writeEnabled(configDir, false);
    writeExactSiblingMcp(home, engramBin);
    writeExactNestedMcp(configDir, engramBin);
    writeMarketplaceTree(configDir);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
  });

  it("rejects a registry entry missing installPath", async () => {
    const home = tempHome("jx-claude200-noinstall-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    // Registry present but without installPath; marketplace hooks must not rescue it.
    writeRegistryWithoutInstallPath(configDir);
    writeEnabled(configDir, true);
    writeExactSiblingMcp(home, engramBin);
    writeExactNestedMcp(configDir, engramBin);
    writeMarketplaceTree(configDir);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/installPath|plugin/i);
  });

  it("rejects a foreign installPath outside the config cache tree", async () => {
    const home = tempHome("jx-claude200-foreign-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-claude200-foreign-root-"));
    tempRoots.push(foreignRoot);
    const foreignInstall = path.join(foreignRoot, "engram", "0.1.3");
    writeInstallPathTree(foreignInstall);
    writeRegistryWithInstallPath(configDir, foreignInstall);
    writeEnabled(configDir, true);
    writeExactSiblingMcp(home, engramBin);
    writeExactNestedMcp(configDir, engramBin);
    // Marketplace hooks present so a marketplace-trusting verifier could
    // report ok; the 2.0.0 contract must still reject the foreign path.
    writeMarketplaceTree(configDir);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
  });

  it("rejects an installPath whose cache ancestor is a symlink to outside (custom nested stays valid otherwise)", async () => {
    const home = tempHome("jx-claude200-ancestor-");
    const configDir = path.join(home, "custom-claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-claude200-ancestor-out-"));
    tempRoots.push(outsideRoot);
    const outsideReal = path.join(outsideRoot, "real-cache");
    fs.mkdirSync(path.join(outsideReal, "engram", "engram", "0.1.3", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(outsideReal, "engram", "engram", "0.1.3", "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(outsideReal, "engram", "engram", "0.1.3", "hooks", "hooks.json"),
      JSON.stringify(OFFICIAL_HOOKS),
    );
    fs.writeFileSync(path.join(outsideReal, "engram", "engram", "0.1.3", "scripts", "session-start.sh"), "#!/bin/sh\n");
    // Ancestor `plugins/cache` is a symlink to outside; the final installPath
    // itself is not a symlink, but every access traverses the alias.
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
    fs.symlinkSync(outsideReal, path.join(configDir, "plugins", "cache"));
    const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
    writeRegistryWithInstallPath(configDir, installPath);
    writeEnabled(configDir, true);
    // Custom MCP location is otherwise exact, so only the ancestor alias
    // may fail the run.
    writeExactNestedMcp(configDir, engramBin);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/symlink|installPath|plugin/i);
  });

  it("control: obsolete mcp/engram.json alone is never MCP evidence", async () => {
    const home = tempHome("jx-claude200-obsolete-");
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    fs.mkdirSync(configDir, { recursive: true });
    // Obsolete location from 1.20.0/2.0.0-rc.11: ignored by Claude 2.1.267.
    fs.mkdirSync(path.join(configDir, "mcp"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "mcp", "engram.json"),
      JSON.stringify({ type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"], env: {} }),
    );
    const mod = await import("../src/adapters/claude-code.js");
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
  });
});

describe("[claude-2.0.0] setup env wiring shares the effective config", () => {
  it("default configDir <home>/.claude must not force CLAUDE_CONFIG_DIR", async () => {
    const home = tempHome("jx-claude200-env-default-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const env = (mod.resolveOfficialSetupEnv as any)("claude-code", configDir, home);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("custom configDir must pass CLAUDE_CONFIG_DIR=<custom>", async () => {
    const home = tempHome("jx-claude200-env-custom-");
    const configDir = path.join(home, "custom-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = await import("../src/lib/official-engram-setup.js");
    const env = (mod.resolveOfficialSetupEnv as any)("claude-code", configDir, home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
  });
});

describe("[claude-2.0.0] detection honors CLAUDE_CONFIG_DIR", () => {
  it("custom CLAUDE_CONFIG_DIR is shared by runtime/setup/verify", async () => {
    const home = tempHome("jx-claude200-detect-");
    const custom = path.join(home, "custom-claude");
    fs.mkdirSync(custom, { recursive: true });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = custom;
    try {
      const { detectClaudeCode } = await import("../src/lib/detect.js");
      expect(detectClaudeCode().configDir).toBe(custom);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    // The same custom dir is the one setup env passes and verify accepts
    // with nested MCP (covered above); detection must not diverge from it.
    const setup = await import("../src/lib/official-engram-setup.js");
    const env = (setup.resolveOfficialSetupEnv as any)("claude-code", custom, home);
    expect(env.CLAUDE_CONFIG_DIR).toBe(custom);
  });
});
