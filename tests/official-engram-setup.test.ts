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
// Huellas oficiales realistas (paths/formats que el adapter actual reconoce)
// ---------------------------------------------------------------------------

/** Contenido oficial simulado de `engram setup opencode` en la MISMA ruta. */
const OFFICIAL_ENGRAM_TS = [
  "// engram official plugin (engram setup opencode reemplaza legacy en la misma ruta)",
  "export const Engram = {};",
  "",
].join("\n");

function seedClaudeOfficial(home: string): {
  configDir: string;
  mainFile: string;
  settingsFile: string;
  pluginDir: string;
  engramBin: string;
} {
  const configDir = path.join(home, ".claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  // Registry marketplace enabled (sin enabled=false): huella que
  // hasEngramPlugin reconoce por clave exacta "engram@engram".
  const pluginDir = path.join(configDir, "plugins", "marketplaces", "engram");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "engram@engram": [{ version: "1.20.0" }] } }),
  );
  // Hooks OFICIALES del plugin (única fuente de la capa `hooks`): installPath
  // temporal con hooks/hooks.json + scripts oficiales. Los hooks JorgeX de
  // settings.json NO acreditan esta capa (ver control de preservación).
  const officialHooks = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "session-start.sh" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "session-end.sh" }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: "subagent-stop.sh" }] }],
    },
  };
  fs.mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "hooks", "hooks.json"), JSON.stringify(officialHooks));
  for (const script of [
    "session-start.sh",
    "post-compaction.sh",
    "user-prompt-submit.sh",
    "subagent-stop.sh",
    "session-end.sh",
  ]) {
    fs.writeFileSync(path.join(pluginDir, "scripts", script), "#!/bin/sh\n");
  }
  // MCP de scope user exacto: ~/.claude.json hermano del configDir, formato
  // stdio que planMainConfig entiende (type/command/args).
  const mainFile = path.join(home, ".claude.json");
  fs.writeFileSync(
    mainFile,
    JSON.stringify({
      mcpServers: {
        engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"] },
        ajeno: { type: "http", url: "https://ajeno.invalid" },
      },
    }),
  );
  // Hooks JorgeX en settings.json: existen y deben preservarse, pero NO
  // acreditan la capa oficial `hooks`.
  const scriptsDir = path.join(configDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "post-pr-review.cjs"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(scriptsDir, "repair-worktree-config.cjs"), "module.exports = 2;\n");
  const settingsFile = path.join(configDir, "settings.json");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
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
  return { configDir, mainFile, settingsFile, pluginDir, engramBin };
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
  it("control: la huella Claude es reconocida por el adapter actual", async () => {
    const home = tempHome("jx-t10-t13-claude-control-");
    const { configDir, mainFile, pluginDir, engramBin } = seedClaudeOfficial(home);
    const { claudeCodeAdapter } = (await import("../src/adapters/claude-code.js")) as any;

    expect(claudeCodeAdapter.injectEngramProtocol({ configDir } as any)).toBe(false);
    const main = JSON.parse(fs.readFileSync(mainFile, "utf8")) as any;
    expect(main.mcpServers.engram).toMatchObject({
      type: "stdio",
      command: engramBin,
      args: ["mcp", "--tools=agent"],
    });
    expect(main.mcpServers.ajeno).toBeDefined();
    expect(fs.existsSync(path.join(pluginDir, "hooks", "hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "scripts", "session-start.sh"))).toBe(true);
  });

  it("control: hooks JorgeX se preservan por separado y no acreditan capa oficial", async () => {
    const home = tempHome("jx-t10-t13-claude-jorgex-");
    const { settingsFile } = seedClaudeOfficial(home);
    const before = fs.readFileSync(settingsFile, "utf8");
    expect(before).toContain("post-pr-review.cjs");
    // La capa oficial `hooks` vive en el installPath del plugin, no aquí.
    expect(before).not.toContain("session-start.sh");
  });

  it("Claude verifica plugin + MCP exacto + hooks oficiales inspeccionando filesystem, sin duplicar", async () => {
    const home = tempHome("jx-t10-t13-claude-");
    const { configDir, engramBin } = seedClaudeOfficial(home);
    const mod = (await import("../src/adapters/claude-code.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Claude por capas (T13)").toBe("function");

    // Sin booleanos declarativos: el verificador debe leer plugin/MCP/hooks
    // oficiales desde el filesystem (installPath temporal + sibling MCP).
    const report = await verify({ configDir, engramBin });
    expect(report.ok).toBe(true);
    expect(report.layers).toEqual(expect.arrayContaining(["plugin", "mcp", "hooks"]));
    expect(report.duplicates).toBe(false);
    // La config ajena sigue intacta tras verificar.
    expect(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).toContain("ajeno");
  });

  it("Claude negativo: hooks oficiales ausentes no pasa aunque queden hooks JorgeX", async () => {
    const home = tempHome("jx-t10-t13-claude-neg-");
    const { configDir, pluginDir, settingsFile, engramBin } = seedClaudeOfficial(home);
    // Rompe solo la capa oficial: el plugin registry, el MCP y los hooks
    // JorgeX siguen presentes.
    fs.rmSync(path.join(pluginDir, "hooks", "hooks.json"), { force: true });
    expect(fs.readFileSync(settingsFile, "utf8")).toContain("post-pr-review.cjs");
    const mod = (await import("../src/adapters/claude-code.js")) as any;
    const verify = mod.verifyOfficialSetup;
    expect(typeof verify, "falta verificador Claude por capas (T13)").toBe("function");

    const report = await verify({ configDir, engramBin });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).toMatch(/hook/i);
  });
});

describe("[T13] Codex verifica MCP + instructions + plugin main en filesystem", () => {
  it("control: la huella Codex es reconocida por el adapter actual", async () => {
    const home = tempHome("jx-t10-t13-codex-control-");
    const { configDir, configFile, instructionsFile, compactFile } = seedCodexOfficial(home);
    const { codexAdapter } = (await import("../src/adapters/codex.js")) as any;

    expect(codexAdapter.injectEngramProtocol({ configDir } as any)).toBe(false);
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
