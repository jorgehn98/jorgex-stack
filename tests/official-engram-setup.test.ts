import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  complementsToScan,
  resolveComplementUpdateCheck,
} from "../src/update.js";
import { createBackup, restoreBackup } from "../src/lib/backup.js";

/**
 * Verifica la integración oficial de Engram con subprocess/filesystem
 * inyectados y HOME temporales; ningún setup real se ejecuta aquí.
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

function fakeSpawnCapture() {
  const calls: Array<{ bin: string; argv: string[]; options: unknown }> = [];
  return {
    calls,
    spawn: async (bin: string, argv: string[], options: unknown) => {
      calls.push({ bin, argv, options });
      return { ok: true as const, stdout: "", stderr: "" };
    },
  };
}

// ---------------------------------------------------------------------------
// Huellas oficiales realistas (rutas y formatos que reconoce el adapter actual)
// ---------------------------------------------------------------------------

/** Contenido oficial simulado de `engram setup opencode` en la MISMA ruta. */
const OFFICIAL_ENGRAM_TS = [
  "// official engram setup opencode (same path, real markers)",
  "const url = CONFIGURED_ENGRAM_URL;",
  "async function ensureLocalReady() { return true; }",
  "const tools = SESSION_ATTRIBUTED_WRITE_TOOLS;",
  "function canonicalEngramToolName() { return 'engram'; }",
  "const id = localInstanceID;",
  "",
].join("\n");

function seedClaudeOfficial(home: string): {
  configDir: string;
  mainFile: string;
  settingsFile: string;
  installPath: string;
  engramBin: string;
} {
  const configDir = path.join(home, ".claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  // Engram 2.0: registry v2 con alcance user e installPath bajo
  // plugins/cache/engram/engram/0.1.3; activación mediante enabledPlugins.
  const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
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
  // Hooks OFICIALES del plugin (única fuente de la capa `hooks`): installPath
  // con hooks/hooks.json + scripts oficiales. Los hooks JorgeX de
  // settings.json NO acreditan esta capa (ver control de preservación).
  const officialHooks = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "session-start.sh" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "session-end.sh" }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: "subagent-stop.sh" }] }],
    },
  };
  fs.mkdirSync(path.join(installPath, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(installPath, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(installPath, "hooks", "hooks.json"), JSON.stringify(officialHooks));
  for (const script of [
    "session-start.sh",
    "post-compaction.sh",
    "user-prompt-submit.sh",
    "subagent-stop.sh",
    "session-end.sh",
  ]) {
    fs.writeFileSync(path.join(installPath, "scripts", script), "#!/bin/sh\n");
  }
  // MCP exacto de Engram 2.0 según el modo (diagnóstico comprobado en Claude 2.1.267):
  // - predeterminado (CLAUDE_CONFIG_DIR ausente): archivo hermano `$HOME/.claude.json`;
  //   el anidado `<config>/.claude.json` está ausente; `claude mcp list`
  //   muestra Connected desde el archivo hermano.
  // - personalizado (CLAUDE_CONFIG_DIR=custom): anidado
  //   `$CLAUDE_CONFIG_DIR/.claude.json`.
  // El obsoleto `mcp/engram.json` nunca es evidencia (solo reversión).
  // Este escenario cubre el modo predeterminado: archivo hermano exacto y
  // archivo anidado ausente.
  const mainFile = path.join(home, ".claude.json");
  fs.writeFileSync(
    mainFile,
    JSON.stringify({
      mcpServers: {
        engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"], env: {} },
        ajeno: { type: "http", url: "https://ajeno.invalid" },
      },
    }),
  );
  expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(false);
  // settings.json: enabledPlugins acredita el plugin + hooks JorgeX que
  // existen y deben preservarse, pero NO acreditan la capa oficial `hooks`.
  const scriptsDir = path.join(configDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "post-pr-review.cjs"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(scriptsDir, "repair-worktree-config.cjs"), "module.exports = 2;\n");
  const settingsFile = path.join(configDir, "settings.json");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      enabledPlugins: { "engram@engram": true },
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash|PowerShell",
            hooks: [{ type: "command", command: `node "${scriptsDir}/post-pr-review.cjs"` }],
          },
        ],
      },
    }),
  );
  return { configDir, mainFile, settingsFile, installPath, engramBin };
}

/** Modo personalizado (CLAUDE_CONFIG_DIR): MCP exacto anidado `configDir/.claude.json`. */
function seedClaudeCustom(home: string): {
  configDir: string;
  mainFile: string;
  settingsFile: string;
  installPath: string;
  engramBin: string;
} {
  const configDir = path.join(home, "custom-claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
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
  const officialHooks = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "session-start.sh" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "session-end.sh" }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: "subagent-stop.sh" }] }],
    },
  };
  fs.mkdirSync(path.join(installPath, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(installPath, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(installPath, "hooks", "hooks.json"), JSON.stringify(officialHooks));
  for (const script of ["session-start.sh", "session-end.sh"]) {
    fs.writeFileSync(path.join(installPath, "scripts", script), "#!/bin/sh\n");
  }
  const mainFile = path.join(configDir, ".claude.json");
  fs.writeFileSync(
    mainFile,
    JSON.stringify({
      mcpServers: {
        engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"], env: {} },
        ajeno: { type: "http", url: "https://ajeno.invalid" },
      },
    }),
  );
  // En modo personalizado el archivo hermano predeterminado no lleva el MCP
  // para mantener aislados ambos modos.
  expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  const settingsFile = path.join(configDir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { "engram@engram": true } }));
  return { configDir, mainFile, settingsFile, installPath, engramBin };
}

function seedCodexOfficial(home: string): {
  configDir: string;
  configFile: string;
  instructionsFile: string;
  compactFile: string;
  engramBin: string;
} {
  const configDir = path.join(home, ".codex");
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(configDir, { recursive: true });
  // Plugin oficial desde `main` (huella que hasActiveEngramPlugin reconoce:
  // header [plugins."engram@main"] sin enabled=false).
  // MCP Engram exacto + bloque ajeno que debe preservarse.
  // model_instructions_file + experimental_compact_prompt_file referencian
  // los archivos reales de instrucciones/compact prompt.
  const configFile = path.join(configDir, "config.toml");
  fs.writeFileSync(
    configFile,
    [
      'model = "user/model"',
      "model_context_window = 100",
      'model_instructions_file = "engram-instructions.md"',
      'experimental_compact_prompt_file = "engram-compact-prompt.md"',
      "",
      '[plugins."engram@main"]',
      'source = "github:Gentleman-Programming/engram#main"',
      "",
      "[mcp_servers.engram]",
      `command = ${JSON.stringify(engramBin)}`,
      'args = ["mcp", "--tools=agent"]',
      "",
      "[mcp_servers.ajeno]",
      'command = "x"',
      "",
    ].join("\n"),
  );
  // Instruction/compact files que `engram setup codex` escribe y que
  // hasEngramProtocol detecta por existencia o referencia en config.toml.
  const instructionsFile = path.join(configDir, "engram-instructions.md");
  fs.writeFileSync(instructionsFile, "# Engram instructions (official setup)\n\nUsa Engram.\n");
  const compactFile = path.join(configDir, "engram-compact-prompt.md");
  fs.writeFileSync(compactFile, "FIRST ACTION REQUIRED after compaction.\n");
  fs.writeFileSync(path.join(configDir, "AGENTS.md"), "# Codex user text\n");
  return { configDir, configFile, instructionsFile, compactFile, engramBin };
}

/** Legacy Stack en la MISMA ruta que el setup oficial sobrescribe. */
function seedOpencodeLegacy(home: string): {
  configDir: string;
  configFile: string;
  pluginsDir: string;
  pluginFile: string;
  engramBin: string;
  legacyStackContent: string;
} {
  const configDir = path.join(home, ".config", "opencode");
  const pluginsDir = path.join(configDir, "plugins");
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(pluginsDir, { recursive: true });
  // Contenido legacy identificable por marcadores Stack, no solo por el nombre.
  // El setup oficial sobrescribe esta misma ruta con contenido oficial.
  const legacyStackContent = [
    "// jorgex-stack legacy engram plugin (retirado en T14; `engram setup opencode` lo reemplaza)",
    'declare const Bun: { which?: (bin: string) => string | null };',
    'const ENGRAM_BIN = "{{ENGRAM_BIN}}";',
    "export function resolveEngramBin(installerBin = ENGRAM_BIN): string { return installerBin; }",
    "function stripPrivateTags(str: string): string { return str; }",
    "",
  ].join("\n");
  const pluginFile = path.join(pluginsDir, "engram.ts");
  fs.writeFileSync(pluginFile, legacyStackContent);
  fs.writeFileSync(path.join(pluginsDir, "hooks.ts"), "// stack-owned hooks\n");
  fs.writeFileSync(path.join(pluginsDir, "worktree.ts"), "// stack-owned worktree\n");
  const configFile = path.join(configDir, "opencode.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mcp: { ajeno: { type: "remote", url: "https://ajeno.invalid" } } }),
  );
  return { configDir, configFile, pluginsDir, pluginFile, engramBin, legacyStackContent };
}

/** Simula `engram setup opencode`: reemplaza la MISMA ruta + MCP/statusline. */
function simulateOpencodeSetup(seed: {
  pluginFile: string;
  configFile: string;
  engramBin: string;
}): void {
  fs.writeFileSync(seed.pluginFile, OFFICIAL_ENGRAM_TS);
  const config = JSON.parse(fs.readFileSync(seed.configFile, "utf8")) as Record<string, any>;
  config.mcp = {
    ...(config.mcp ?? {}),
    engram: { type: "local", command: [seed.engramBin, "mcp", "--tools=agent"] },
  };
  config.statusline = { command: "engram statusline" };
  fs.writeFileSync(seed.configFile, JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Estrategias exact y provider-managed.
// ---------------------------------------------------------------------------

describe("[T11] complements strategy exact vs provider-managed", () => {
  it("provider-managed sin versión no avisa 'sin pin' (rolling aceptado)", () => {
    const info = {
      source: "npm:pi-mcp-adapter",
      version: null,
      strategy: "provider-managed",
    } as any;
    const report = resolveComplementUpdateCheck("pi-mcp-adapter", info, "0.2.0");

    expect(report.message).not.toMatch(/sin pin/);
    expect(report.level).not.toBe("warn");
  });

  it("rolling 'main' de Codex aceptado sin warning 'sin pin'", () => {
    const home = tempHome("jx-t10-t11-");
    expect(fs.existsSync(home)).toBe(true);
    const info = {
      source: "github:Gentleman-Programming/engram#plugin/codex",
      version: null,
      strategy: "provider-managed",
      note: "codex main rolling aprobado",
    } as any;
    const report = resolveComplementUpdateCheck("engram-codex-plugin", info, "main");

    expect(report.message).not.toMatch(/sin pin/);
    expect(report.level).not.toBe("warn");
  });

  it("exact sin versión sí falla (no basta warn genérico)", () => {
    const info = {
      source: "npm:gentle-engram",
      strategy: "exact",
    } as any;
    const report = resolveComplementUpdateCheck("gentle-engram", info, "0.1.12") as any;

    // La ausencia de pin en una integración exact debe producir un fallo visible.
    expect(["error", "fail", "fatal"]).toContain(report.level);
  });

  it("control existente: exact con versión conserva semántica (pin igual → success)", () => {
    const report = resolveComplementUpdateCheck(
      "gentle-engram",
      { source: "npm:gentle-engram", version: "0.1.12" },
      "0.1.12",
    );
    expect(report).toMatchObject({ level: "success" });
    expect(report.message).toContain("0.1.12");
  });

  it("control existente: complementsToScan filtra $comment", () => {
    expect(complementsToScan({ tools: {}, skills: {} } as any)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ejecución segura del setup oficial.
// ---------------------------------------------------------------------------

describe("[T12] coordinador install-only con argv exacto", () => {
  it("expone comandos exactos setup claude-code/codex/opencode, sin aliases", async () => {
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const resolveArgv = mod.resolveOfficialSetupArgv;
    expect(typeof resolveArgv, "falta coordinador setup oficial (T12)").toBe("function");

    expect(resolveArgv("claude-code")).toEqual(["setup", "claude-code"]);
    expect(resolveArgv("codex")).toEqual(["setup", "codex"]);
    expect(resolveArgv("opencode")).toEqual(["setup", "opencode"]);
    expect(() => resolveArgv("claude")).toThrow();
  });

  it("solo install real ejecuta setup; nunca sync/dry-run/target-dir/uninstall/doctor", async () => {
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const shouldRun = mod.shouldRunOfficialSetup;
    expect(typeof shouldRun, "falta gate install-only (T12)").toBe("function");

    expect(shouldRun({ command: "install", dryRun: false, targetDir: undefined })).toBe(true);
    expect(shouldRun({ command: "sync", dryRun: false, targetDir: undefined })).toBe(false);
    expect(shouldRun({ command: "install", dryRun: true, targetDir: undefined })).toBe(false);
    expect(shouldRun({ command: "install", dryRun: false, targetDir: "/tmp/x" })).toBe(false);
    expect(shouldRun({ command: "uninstall", dryRun: false, targetDir: undefined })).toBe(false);
    expect(shouldRun({ command: "doctor", dryRun: false, targetDir: undefined })).toBe(false);
  });

  it("backup → spawn → verify en orden; ok/ownership solo tras verify", async () => {
    const home = tempHome("jx-t10-t12-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const declaredTarget = path.join(configDir, "config.toml");
    fs.writeFileSync(declaredTarget, 'model = "user/model"\n');
    const order: string[] = [];
    const spawn = fakeSpawnCapture();
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const runSetup = mod.runOfficialSetup;
    expect(typeof runSetup, "falta ejecución segura con backup (T12)").toBe("function");

    const result = await runSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [declaredTarget],
      backup: async () => {
        order.push("backup");
        return { id: "fake-backup" };
      },
      spawn: async (bin: string, argv: string[], options: Record<string, unknown>) => {
        order.push("spawn");
        return spawn.spawn(bin, argv, options);
      },
      verify: async () => {
        order.push("verify");
        return { ok: true, layers: ["plugin", "mcp", "hooks"] };
      },
    });

    expect(order).toEqual(["backup", "spawn", "verify"]);
    expect(result.ok).toBe(true);
    expect(result.ownershipTransferred).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.argv).toEqual(["setup", "codex"]);
    expect(spawn.calls[0]!.options).toMatchObject({ shell: false });
    expect(String(JSON.stringify(spawn.calls[0]!.options))).not.toMatch(/shell:\s*true/);
  });

  it("rollback real con targets explícitos: target ausente creado por spawn se elimina y preexistentes se restauran", async () => {
    const home = tempHome("jx-t10-t12-rollback-real-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const preexisting = path.join(configDir, "config.toml");
    const original = 'model = "user/model"\n';
    fs.writeFileSync(preexisting, original);
    const newTarget = path.join(configDir, "new-from-setup.txt");
    expect(fs.existsSync(newTarget)).toBe(false);
    // Backup/restore REALES sobre raíces temporales (sin HOME real). Los
    // targets se declaran explícitamente: el core nunca debe escanear HOME
    // para adivinar qué creó el setup.
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const runSetup = mod.runOfficialSetup;
    expect(typeof runSetup, "falta rollback real con backup (T12)").toBe("function");

    const order: string[] = [];
    const result = await runSetup("codex", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [newTarget, preexisting],
      backup: async () => {
        order.push("backup");
        const backup = createBackup([preexisting], "t10-rollback-real", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        order.push("spawn");
        fs.writeFileSync(newTarget, "creado por setup parcial\n");
        fs.writeFileSync(preexisting, "modificado por setup parcial\n");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => {
        order.push("verify");
        return { ok: false, layers: ["mcp:missing"], reason: "verify falló" };
      },
      restore: async () => {
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });

    expect(order).toEqual(["backup", "spawn", "verify"]);
    expect(result.ok).toBe(false);
    expect(result.ownershipTransferred ?? false).toBe(false);
    expect(fs.readFileSync(preexisting, "utf8")).toBe(original);
    expect(fs.existsSync(newTarget)).toBe(false);
  });

  it("sin targets explícitos falla temprano y no ejecuta spawn (nunca escanea HOME)", async () => {
    const home = tempHome("jx-t10-t12-no-targets-");
    const spawn = fakeSpawnCapture();
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const runSetup = mod.runOfficialSetup;
    expect(typeof runSetup, "falta gate de targets explícitos (T12)").toBe("function");

    let threw: unknown = null;
    let result: any = null;
    try {
      result = await runSetup("codex", {
        homeDir: home,
        engramBin: path.join(home, ".local", "bin", "engram"),
        backup: async () => ({ id: "no-targets-backup" }),
        spawn: async (bin: string, argv: string[], options: Record<string, unknown>) => {
          return spawn.spawn(bin, argv, options);
        },
        verify: async () => ({ ok: true, layers: ["plugin", "mcp", "hooks"] }),
        // Sin `targets`: el core debe fallar temprano o no ejecutar spawn,
        // en vez de recorrer/eliminar ficheros bajo HOME.
      });
    } catch (error) {
      threw = error;
    }
    if (threw !== null) {
      expect(String(threw)).toMatch(/targets/i);
    } else {
      expect(spawn.calls).toHaveLength(0);
      expect(result.ok).toBe(false);
    }
  });

  it("runOfficialSetupIfNeeded no toca HOME real: gate cerrado sin verificador ni efectos", async () => {
    const home = tempHome("jx-t10-t12-ifneeded-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const runIfNeeded = mod.runOfficialSetupIfNeeded;
    expect(typeof runIfNeeded, "falta wiring testeable sin HOME real (T12)").toBe("function");

    // Sin verificador registrado para un HOME temporal: no ejecuta nada.
    const skipped = await runIfNeeded("codex", {
      command: "sync",
      dryRun: false,
      targetDir: undefined,
      engramBin: path.join(home, ".local", "bin", "engram"),
      configDir,
      homeDir: home,
    });
    expect(skipped).toMatchObject({ ran: false });
    expect(fs.existsSync(path.join(home, ".jorgex-stack"))).toBe(false);
  });
});

describe("[T12] backup targets esperados por runtime (sin DB ni binario)", () => {
  it("Codex incluye config + instructions + compact prompt", async () => {
    const home = tempHome("jx-t10-t12-targets-codex-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets Codex (T12)").toBe("function");

    const targets = collect("codex", configDir) as string[];
    expect(targets).toEqual(expect.arrayContaining([
      path.join(configDir, "config.toml"),
      path.join(configDir, "engram-instructions.md"),
      path.join(configDir, "engram-compact-prompt.md"),
    ]));
  });

  it("OpenCode incluye opencode.json/jsonc + tui.json/jsonc + plugin", async () => {
    const home = tempHome("jx-t10-t12-targets-opencode-");
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets OpenCode (T12)").toBe("function");

    const targets = collect("opencode", configDir) as string[];
    expect(targets).toEqual(expect.arrayContaining([
      path.join(configDir, "opencode.json"),
      path.join(configDir, "opencode.jsonc"),
      path.join(configDir, "tui.json"),
      path.join(configDir, "tui.jsonc"),
      path.join(configDir, "plugins", "engram.ts"),
    ]));
  });

  it("Claude default respalda el sibling .claude.json", async () => {
    const home = tempHome("jx-t10-t12-targets-claude-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets Claude (T12)").toBe("function");

    const targets = collect("claude-code", configDir) as string[];
    expect(targets).toContain(path.join(home, ".claude.json"));
  });

  it("Claude custom (CLAUDE_CONFIG_DIR) respalda configDir/.claude.json según setup oficial", async () => {
    const root = tempHome("jx-t10-t12-targets-claude-custom-");
    const configDir = path.join(root, "custom-claude");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets Claude custom (T12)").toBe("function");

    const targets = collect("claude-code", configDir) as string[];
    expect(targets).toContain(path.join(configDir, ".claude.json"));
  });

  it("control: ningún target respalda DB ni binario", async () => {
    const home = tempHome("jx-t10-t12-targets-nodb-");
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets (T12)").toBe("function");

    for (const runtime of ["claude-code", "codex", "opencode"] as const) {
      const configDir = path.join(home, `.cfg-${runtime}`);
      const targets = (collect(runtime, configDir) as string[]).join("\n");
      expect(targets).not.toMatch(/\.engram\/engram\.db|engram\.db/);
      expect(targets).not.toMatch(/\.local\/bin\/engram/);
    }
  });
});

// ---------------------------------------------------------------------------
// Verificación de Claude Code y Codex.
// ---------------------------------------------------------------------------

describe("[T13] Claude verifica huellas oficiales en filesystem", () => {
  it("control: la huella Claude predeterminada usa el archivo hermano $HOME/.claude.json (anidado ausente)", async () => {
    const home = tempHome("jx-t10-t13-claude-control-");
    const { configDir, mainFile, installPath, engramBin } = seedClaudeOfficial(home);
    const { claudeCodeAdapter } = (await import("../src/adapters/claude-code.js")) as any;

    // Provider-only: Stack ya no expone interfaz de inyección; el setup
    // oficial + provider es el único owner del protocolo.
    expect(claudeCodeAdapter.injectEngramProtocol).toBeUndefined();
    // Diagnóstico comprobado: CLAUDE_CONFIG_DIR ausente → archivo hermano;
    // anidado ausente.
    expect(mainFile).toBe(path.join(home, ".claude.json"));
    expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(false);
    const main = JSON.parse(fs.readFileSync(mainFile, "utf8")) as any;
    expect(main.mcpServers.engram).toMatchObject({
      type: "stdio",
      command: engramBin,
      args: ["mcp", "--tools=agent"],
    });
    expect(main.mcpServers.ajeno).toBeDefined();
    expect(installPath).toBe(path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3"));
    expect(fs.existsSync(path.join(installPath, "hooks", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(installPath, "scripts", "session-start.sh"))).toBe(true);
  });

  it("control: la huella Claude custom usa el anidado $CLAUDE_CONFIG_DIR/.claude.json", async () => {
    const home = tempHome("jx-t10-t13-claude-custom-ctrl-");
    const { configDir, mainFile, installPath, engramBin } = seedClaudeCustom(home);
    expect(mainFile).toBe(path.join(configDir, ".claude.json"));
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    const main = JSON.parse(fs.readFileSync(mainFile, "utf8")) as any;
    expect(main.mcpServers.engram).toMatchObject({
      type: "stdio",
      command: engramBin,
      args: ["mcp", "--tools=agent"],
    });
    expect(installPath).toBe(path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3"));
    expect(fs.existsSync(path.join(installPath, "hooks", "hooks.json"))).toBe(true);
  });

  it("control: hooks JorgeX se preservan por separado y no acreditan capa oficial", async () => {
    const home = tempHome("jx-t10-t13-claude-jorgex-");
    const { settingsFile } = seedClaudeOfficial(home);
    const before = fs.readFileSync(settingsFile, "utf8");
    expect(before).toContain("post-pr-review.cjs");
    // La capa oficial `hooks` vive en el installPath del plugin, no aquí.
    expect(before).not.toContain("session-start.sh");
  });

  it("Claude predeterminado verifica archivo hermano + plugin + hooks (homeDir explícito), sin duplicar", async () => {
    const home = tempHome("jx-t10-t13-claude-");
    const { configDir, engramBin } = seedClaudeOfficial(home);
    const mod = (await import("../src/adapters/claude-code.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Claude por capas (T13)").toBe("function");

    // Sin booleanos declarativos: el verificador debe leer plugin/MCP/hooks
    // oficiales desde el filesystem (installPath + archivo hermano exacto en el
    // modo predeterminado).
    const report = await (verify as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["plugin", "mcp", "hooks"]));
    expect(report.duplicates).toBe(false);
    // La config ajena sigue intacta tras verificar.
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toContain("ajeno");
  });

  it("Claude custom verifica anidado + plugin + hooks (homeDir explícito)", async () => {
    const home = tempHome("jx-t10-t13-claude-custom-");
    const { configDir, engramBin } = seedClaudeCustom(home);
    const mod = (await import("../src/adapters/claude-code.js")) as any;
    const report = await (mod.verifyOfficialSetup as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["plugin", "mcp", "hooks"]));
  });

  it("Claude negativo: hooks oficiales ausentes no pasa aunque queden hooks JorgeX", async () => {
    const home = tempHome("jx-t10-t13-claude-neg-");
    const { configDir, installPath, settingsFile, engramBin } = seedClaudeOfficial(home);
    // Rompe solo la capa oficial: el registro del plugin, el MCP del archivo hermano y los
    // hooks JorgeX siguen presentes.
    fs.rmSync(path.join(installPath, "hooks", "hooks.json"), { force: true });
    expect(fs.readFileSync(settingsFile, "utf8")).toContain("post-pr-review.cjs");
    const mod = (await import("../src/adapters/claude-code.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Claude por capas (T13)").toBe("function");

    const report = await (verify as any)({ configDir, engramBin, homeDir: home });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/hook/i);
  });
});

describe("[T13] Codex verifica MCP + instructions + plugin main en filesystem", () => {
  it("control: la huella Codex es reconocida por el adapter actual", async () => {
    const home = tempHome("jx-t10-t13-codex-control-");
    const { configDir, configFile, instructionsFile, compactFile } = seedCodexOfficial(home);
    const { codexAdapter } = (await import("../src/adapters/codex.js")) as any;

    // Provider-only: Stack ya no expone interfaz de inyección; el setup
    // oficial + provider es el único owner del protocolo.
    expect(codexAdapter.injectEngramProtocol).toBeUndefined();
    expect(fs.readFileSync(configFile, "utf8")).toContain('[plugins."engram@main"]');
    expect(fs.readFileSync(configFile, "utf8")).toContain("[mcp_servers.engram]");
    expect(fs.readFileSync(configFile, "utf8")).toContain("[mcp_servers.ajeno]");
    expect(fs.readFileSync(configFile, "utf8")).toContain("experimental_compact_prompt_file");
    expect(fs.existsSync(instructionsFile)).toBe(true);
    expect(fs.existsSync(compactFile)).toBe(true);
  });

  it("Codex acepta ref rolling main y conserva config ajena inspeccionando filesystem", async () => {
    const home = tempHome("jx-t10-t13-codex-");
    const { configDir, configFile, engramBin } = seedCodexOfficial(home);
    const mod = (await import("../src/adapters/codex.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Codex con main aceptado (T13)").toBe("function");

    // Sin setupRef declarativo: el verificador deriva `main` de config.toml.
    const report = await verify({ configDir, engramBin });
    expect(report.ok).toBe(true);
    expect(String(report.acceptedRef ?? report.ref ?? report.setupRef ?? "")).toContain("main");
    expect(fs.readFileSync(configFile, "utf8")).toContain("[mcp_servers.ajeno]");
  });

  it("Codex negativo: MCP Engram conflictivo/ajeno no pasa y preserva lo ajeno", async () => {
    const home = tempHome("jx-t10-t13-codex-neg-");
    const { configDir, configFile, engramBin } = seedCodexOfficial(home);
    // Conflicto: el MCP engram apunta a un binario ajeno, no al oficial.
    const conflicted = fs
      .readFileSync(configFile, "utf8")
      .replace(JSON.stringify(engramBin), JSON.stringify("foreign-server"));
    fs.writeFileSync(configFile, conflicted);
    const mod = (await import("../src/adapters/codex.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Codex con main aceptado (T13)").toBe("function");

    const report = await verify({ configDir, engramBin });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/mcp|engram|conflict/i);
    expect(fs.readFileSync(configFile, "utf8")).toContain("[mcp_servers.ajeno]");
  });
});

// ---------------------------------------------------------------------------
// Transferencia de ownership de OpenCode.
// ---------------------------------------------------------------------------

describe("[T14] OpenCode retira legacy solo tras setup verificado en filesystem", () => {
  it("ambiguity/foreign bloquea cleanup y conserva custom en la misma ruta", async () => {
    const home = tempHome("jx-t10-t14-ambiguity-");
    const { configDir, pluginFile } = seedOpencodeLegacy(home);
    // Legacy custom (no coincide con el canon): no es Stack-owned por contenido.
    fs.writeFileSync(pluginFile, "// custom ajeno\n");
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({ mcp: { engram: { type: "custom", url: "https://ajeno.invalid" } } }),
    );
    const mod = (await import("../src/adapters/opencode.js")) as any;
    const shouldRetire = mod.shouldRetireLegacyEngram;
    expect(typeof shouldRetire, "falta transferencia ownership OpenCode (T14)").toBe("function");

    // Sin booleanos: decide inspeccionando opencode.json + contenido legacy.
    const decision = await shouldRetire({ configDir });
    expect(decision.retire).toBe(false);
    expect(decision.reason).toMatch(/ambigu|foreign|custom/i);
    expect(fs.readFileSync(pluginFile, "utf8")).toContain("custom ajeno");
  });

  it("setup reemplaza la misma ruta: transferencia deja el oficial intacto y retira solo ownership/manifest Stack", async () => {
    const home = tempHome("jx-t10-t14-transfer-");
    const seed = seedOpencodeLegacy(home);
    expect(fs.readFileSync(seed.pluginFile, "utf8")).toBe(seed.legacyStackContent);
    // El setup oficial sobrescribe plugins/engram.ts (misma ruta) + MCP/statusline.
    simulateOpencodeSetup(seed);
    expect(fs.readFileSync(seed.pluginFile, "utf8")).toBe(OFFICIAL_ENGRAM_TS);
    const mod = (await import("../src/adapters/opencode.js")) as any;
    const transfer = mod.transferEngramOwnership;
    expect(typeof transfer, "falta retirada segura legacy OpenCode (T14)").toBe("function");

    // Sin callbacks que borren el destino: verifica en filesystem y no toca
    // el archivo oficial.
    const result = await transfer({ configDir: seed.configDir });

    expect(fs.readFileSync(seed.pluginFile, "utf8")).toBe(OFFICIAL_ENGRAM_TS);
    expect(result.ownershipRetired ?? result.retired).toBeDefined();
    expect(result.kept ?? []).toEqual(expect.arrayContaining(["hooks.ts", "worktree.ts"]));
    expect(result.recreateOnSync).toBe(false);
    expect(result.preserveOfficialOnUninstall).toBe(true);
    expect(fs.existsSync(path.join(seed.pluginsDir, "hooks.ts"))).toBe(true);
    expect(fs.existsSync(path.join(seed.pluginsDir, "worktree.ts"))).toBe(true);
    expect(fs.readFileSync(seed.configFile, "utf8")).toContain("engram");
  });
});

// ---------------------------------------------------------------------------
// Doctor — bin/setup/exposure sin claim OpenCode2
// ---------------------------------------------------------------------------

describe("[doctor] distingue bin/setup/exposure sin prometer OpenCode2", () => {
  it("resuelve binario, setup y exposición inspeccionando filesystem y no menciona OpenCode2", async () => {
    const home = tempHome("jx-t10-doctor-");
    seedClaudeOfficial(home);
    seedCodexOfficial(home);
    seedOpencodeLegacy(home);
    const mod = (await import("../src/doctor.js")) as any;
    const resolveState = mod.resolveEngramOfficialState;
    expect(typeof resolveState, "falta doctor oficial por capas (T14/doctor)").toBe("function");

    // Sin capas declarativas: el doctor inspecciona homeDir/configs reales.
    const state = await resolveState({ homeDir: home });
    expect(Object.keys(state)).toEqual(expect.arrayContaining(["bin", "setup", "exposure"]));
    expect(JSON.stringify(state)).not.toMatch(/opencode\s*2|opencode2/i);
  });
});

// ---------------------------------------------------------------------------
// T41-RED: coordinador oficial `engram setup pi` (install-only gestionado).
// Contrato: install real resuelve/instala el binario Engram primero, respalda
// cada path que `engram setup pi` puede mutar, ejecuta el oficial
// `engram setup pi` antes del package install y verifica singleton exacto
// (un gentle-engram + un pi-mcp-adapter + mcpServers.engram válido, versiones
// provider-managed sin pin). Sync/dry-run/target-dir nunca ejecutan setup ni
// red global. Fallo parcial restaura backup y no activa Pi. Temporales
// aislados; cero HOME real/red.
// ---------------------------------------------------------------------------

describe("[T41-RED] coordinador install-only `engram setup pi`", () => {
  it("expone argv exacto setup pi, sin aliases", async () => {
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof mod.resolveOfficialSetupArgv, "falta coordinador setup oficial Pi (T41)").toBe("function");

    expect(mod.resolveOfficialSetupArgv("pi")).toEqual(["setup", "pi"]);
  });

  it("registra pi como runtime oficial gestionado", async () => {
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;

    expect(mod.isOfficialSetupRuntime("pi")).toBe(true);
    expect(mod.OFFICIAL_SETUP_RUNTIMES).toContain("pi");
  });

  it("declara backup targets Pi que cubren todo lo mutable por setup, sin DB ni binario", async () => {
    const home = tempHome("jx-t41-pi-targets-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const collect = mod.collectOfficialSetupBackupTargets;
    expect(typeof collect, "faltan backup targets Pi (T41)").toBe("function");

    const targets = collect("pi", configDir, home) as string[];
    expect(Array.isArray(targets) && targets.length > 0, "Pi debe declarar targets explícitos no vacíos").toBe(true);
    const joined = targets.join("\n");
    // El setup Pi muta su settings global; el backup debe cubrirlo.
    expect(joined).toMatch(/settings\.json/);
    // Nunca DB ni binario (intocables).
    expect(joined).not.toMatch(/\.engram\/engram\.db|engram\.db/);
    expect(joined).not.toMatch(/\.local\/bin\/engram/);
  });

  it("install real Pi ejecuta backup → spawn setup pi (shell false) → verify en orden", async () => {
    const home = tempHome("jx-t41-pi-order-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const declaredTarget = path.join(configDir, "settings.json");
    fs.writeFileSync(declaredTarget, JSON.stringify({ packages: [] }));
    const order: string[] = [];
    const spawn = fakeSpawnCapture();
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof mod.runOfficialSetup, "falta ejecución segura Pi con backup (T41)").toBe("function");

    const result = await mod.runOfficialSetup("pi", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [declaredTarget],
      backup: async () => {
        order.push("backup");
        return { id: "t41-pi-backup" };
      },
      spawn: async (bin: string, argv: string[], options: Record<string, unknown>) => {
        order.push("spawn");
        return spawn.spawn(bin, argv, options);
      },
      verify: async () => {
        order.push("verify");
        return { ok: true, layers: ["packages", "mcp"] };
      },
    });

    expect(order).toEqual(["backup", "spawn", "verify"]);
    expect(result.ok).toBe(true);
    expect(result.ownershipTransferred).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]!.argv).toEqual(["setup", "pi"]);
    expect(spawn.calls[0]!.options).toMatchObject({ shell: false });
  });

  it("install real Pi falla cerrado con restore y sin ownership cuando verify queda parcial", async () => {
    const home = tempHome("jx-t41-pi-rollback-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const preexisting = path.join(configDir, "settings.json");
    const original = JSON.stringify({ packages: [] });
    fs.writeFileSync(preexisting, original);
    // Canonical mutable por `engram setup pi`: settings.json + mcp.json.
    const newTarget = path.join(configDir, "mcp.json");
    expect(fs.existsSync(newTarget)).toBe(false);
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const order: string[] = [];

    const result = await mod.runOfficialSetup("pi", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets: [newTarget, preexisting],
      backup: async () => {
        order.push("backup");
        const backup = createBackup([preexisting], "t41-pi-rollback", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        order.push("spawn");
        fs.writeFileSync(newTarget, JSON.stringify({ mcpServers: {} }));
        fs.writeFileSync(preexisting, JSON.stringify({ packages: [{ name: "parcial" }] }));
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => {
        order.push("verify");
        return { ok: false, layers: ["packages:partial"], reason: "singleton incompleto" };
      },
      restore: async () => {
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });

    expect(order).toEqual(["backup", "spawn", "verify"]);
    expect(result.ok).toBe(false);
    expect(result.ownershipTransferred ?? false).toBe(false);
    expect(fs.readFileSync(preexisting, "utf8")).toBe(original);
    expect(fs.existsSync(newTarget)).toBe(false);
  });

  it("runOfficialSetupIfNeeded Pi solo corre en install real; sync/dry-run/target-dir omiten sin spawn", async () => {
    const home = tempHome("jx-t41-pi-ifneeded-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const runIfNeeded = mod.runOfficialSetupIfNeeded;
    expect(typeof runIfNeeded, "falta wiring Pi install-only testeable (T41)").toBe("function");

    for (const gated of [
      { command: "sync", dryRun: false, targetDir: undefined },
      { command: "install", dryRun: true, targetDir: undefined },
      { command: "install", dryRun: false, targetDir: path.join(home, "target") },
      { command: "uninstall", dryRun: false, targetDir: undefined },
      { command: "doctor", dryRun: false, targetDir: undefined },
    ] as const) {
      const skipped = await runIfNeeded("pi", {
        ...gated,
        engramBin: path.join(home, ".local", "bin", "engram"),
        configDir,
        homeDir: home,
      });
      expect(skipped, `Pi debe omitir setup en ${gated.command}/dryRun=${gated.dryRun}`).toMatchObject({ ran: false });
    }
    expect(fs.existsSync(path.join(home, ".jorgex-stack"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T42-RED: backup Pi cubre todo PI_CODING_AGENT_DIR/npm además de
// settings.json+mcp.json. Contrato: `engram setup pi` muta descendientes bajo
// npm (provider-owned); el backup debe incluir el directorio completo para que
// un fallo parcial restaure bytes preexistentes, elimine descendientes creados
// y preserve archivos ajenos, con recovery reportado con precisión. El éxito
// puede dejar estado npm del provider. Temporales aislados; cero HOME real.
// ---------------------------------------------------------------------------

function t42ExpandBackupTargets(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    try {
      if (fs.statSync(file).isDirectory()) {
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(full);
          }
        };
        walk(file);
        continue;
      }
    } catch {
      // Ausente: se conserva el path para el gate de targets.
    }
    out.push(file);
  }
  return out;
}

describe("[T42-RED] backup Pi cubre npm + rollback parcial con descendientes", () => {
  it("declara el directorio npm además de settings+mcp, sin DB ni binario", async () => {
    const home = tempHome("jx-t42-pi-targets-");
    const configDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(configDir, { recursive: true });
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof mod.collectOfficialSetupBackupTargets, "faltan backup targets Pi (T42)").toBe("function");

    const targets = mod.collectOfficialSetupBackupTargets("pi", configDir, home) as string[];
    const joined = targets.join("\n");
    expect(joined).toMatch(/settings\.json/);
    expect(joined).toMatch(/mcp\.json/);
    expect(targets).toContain(path.join(configDir, "npm"));
    expect(joined).not.toMatch(/\.engram\/engram\.db|engram\.db/);
    expect(joined).not.toMatch(/\.local\/bin\/engram/);
  });

  it("fallo parcial con npm: restaura preexistentes, elimina creados, preserva ajenos y reporta complete", async () => {
    const home = tempHome("jx-t42-pi-npm-rollback-");
    const configDir = path.join(home, ".pi", "agent");
    const npmDir = path.join(configDir, "npm");
    fs.mkdirSync(path.join(npmDir, "unrelated"), { recursive: true });
    const settingsFile = path.join(configDir, "settings.json");
    const mcpFile = path.join(configDir, "mcp.json");
    const npmExisting = path.join(npmDir, "existing.txt");
    const npmKeep = path.join(npmDir, "unrelated", "keep.json");
    const originalSettings = JSON.stringify({ packages: [] });
    const originalMcp = JSON.stringify({ mcpServers: {} });
    const originalExisting = "preexisting-npm\n";
    const originalKeep = JSON.stringify({ keep: true });
    fs.writeFileSync(settingsFile, originalSettings);
    fs.writeFileSync(mcpFile, originalMcp);
    fs.writeFileSync(npmExisting, originalExisting);
    fs.writeFileSync(npmKeep, originalKeep);
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    expect(typeof mod.runOfficialSetup, "falta ejecución segura Pi con npm (T42)").toBe("function");
    expect(typeof mod.collectOfficialSetupBackupTargets, "faltan backup targets Pi (T42)").toBe("function");

    // Targets canónicos derivados del colector: tras el fix incluyen npm.
    const targets = mod.collectOfficialSetupBackupTargets("pi", configDir, home) as string[];
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;
    const order: string[] = [];

    const result = await mod.runOfficialSetup("pi", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets,
      backup: async () => {
        order.push("backup");
        const backup = createBackup(t42ExpandBackupTargets(targets), "t42-pi-npm-rollback", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        order.push("spawn");
        fs.writeFileSync(settingsFile, JSON.stringify({ packages: [{ name: "parcial" }] }));
        fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { engram: { command: "parcial" } } }));
        fs.writeFileSync(npmExisting, "mutated\n");
        fs.writeFileSync(path.join(npmDir, "new-partial.txt"), "partial\n");
        const newDir = path.join(npmDir, "new-dir");
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(newDir, "nested.txt"), "nested\n");
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => {
        order.push("verify");
        return { ok: false, layers: ["packages:partial"], reason: "singleton incompleto" };
      },
      restore: async () => {
        if (backupId !== null) restoreBackup(backupId, backupRoot, home);
        return { restored: backupId !== null };
      },
    });

    expect(order).toEqual(["backup", "spawn", "verify"]);
    expect(result.ok).toBe(false);
    expect(result.ownershipTransferred ?? false).toBe(false);
    expect(backupId !== null).toBe(true);
    expect(result.backupId).toBe(backupId);
    expect(result.recovery).toBe("complete");
    expect(result.incompleteRecovery ?? false).toBe(false);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(originalSettings);
    expect(fs.readFileSync(mcpFile, "utf8")).toBe(originalMcp);
    expect(fs.readFileSync(npmExisting, "utf8")).toBe(originalExisting);
    expect(fs.readFileSync(npmKeep, "utf8")).toBe(originalKeep);
    expect(fs.existsSync(path.join(npmDir, "new-partial.txt"))).toBe(false);
    expect(fs.existsSync(path.join(npmDir, "new-dir"))).toBe(false);
    expect(fs.existsSync(npmDir)).toBe(true);
  });

  it("control: el éxito puede dejar estado npm del provider sin limpiar", async () => {
    const home = tempHome("jx-t42-pi-npm-success-");
    const configDir = path.join(home, ".pi", "agent");
    const npmDir = path.join(configDir, "npm");
    fs.mkdirSync(configDir, { recursive: true });
    const settingsFile = path.join(configDir, "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: [] }));
    const mod = (await import("../src/lib/official-engram-setup.js")) as any;
    const targets = mod.collectOfficialSetupBackupTargets("pi", configDir, home) as string[];
    const backupRoot = path.join(home, ".jorgex-stack", "backups");
    let backupId: string | null = null;

    const result = await mod.runOfficialSetup("pi", {
      homeDir: home,
      engramBin: path.join(home, ".local", "bin", "engram"),
      targets,
      backup: async () => {
        const backup = createBackup(t42ExpandBackupTargets(targets), "t42-pi-npm-success", backupRoot);
        backupId = backup?.id ?? null;
        return { id: backupId ?? "no-backup" };
      },
      spawn: async () => {
        fs.mkdirSync(npmDir, { recursive: true });
        fs.writeFileSync(path.join(npmDir, "provider-state.json"), JSON.stringify({ provider: true }));
        return { ok: true, stdout: "", stderr: "" };
      },
      verify: async () => ({ ok: true, layers: ["packages", "mcp"] }),
    });

    expect(result.ok).toBe(true);
    expect(result.ownershipTransferred).toBe(true);
    expect(result.recovery).toBe("none");
    expect(fs.readFileSync(path.join(npmDir, "provider-state.json"), "utf8")).toContain("provider");
  });
});

// ---------------------------------------------------------------------------
// T43-RED: provider-only universal. Stack no duplica prompt/tools/capture/
// hooks Engram: sin fuente, sin placeholder y sin interfaz de inyección.
// El setup oficial + provider es el único owner. Temporales aislados.
// ---------------------------------------------------------------------------

describe("[T43-RED] provider-only sin duplicado Stack", () => {
  it("Stack no distribuye fuente ni placeholder de protocolo", async () => {
    const { stackRoot } = await import("../src/lib/paths.js");
    const root = stackRoot();
    expect(fs.existsSync(path.join(root, "system-prompt", "engram-protocol.md"))).toBe(false);
    const plugins = fs.readFileSync(path.join(root, "..", "src", "components", "plugins.ts"), "utf8");
    expect(plugins).not.toContain("{{ENGRAM_PROTOCOL}}");
    expect(plugins).not.toContain("engram-protocol.md");
    const prompt = fs.readFileSync(path.join(root, "..", "src", "components", "system-prompt.ts"), "utf8");
    expect(prompt).not.toContain("engram-protocol");
    expect(prompt).not.toContain("injectEngramProtocol");
  });

  it("ningún adapter declara interfaz de inyección Stack", async () => {
    const { stackRoot } = await import("../src/lib/paths.js");
    const root = stackRoot();
    const types = fs.readFileSync(path.join(root, "..", "src", "adapters", "types.ts"), "utf8");
    expect(types).not.toContain("injectEngramProtocol");
    for (const file of ["claude-code.ts", "codex.ts", "opencode.ts", "pi.ts"]) {
      const content = fs.readFileSync(path.join(root, "..", "src", "adapters", file), "utf8");
      expect(content).not.toContain("injectEngramProtocol");
    }
  });
});
