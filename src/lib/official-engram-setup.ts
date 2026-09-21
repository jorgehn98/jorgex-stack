import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBackup, restoreBackup } from "./backup.js";

/**
 * Coordinador común de `engram setup` oficial.
 *
 * Solo install real ejecuta setup (nunca sync/dry-run/target-dir/uninstall/
 * doctor). Secuencia por runtime independiente: backup → setup → verifier;
 * un fallo restaura los preexistentes, elimina los targets creados por el
 * setup y no transfiere ownership. Subprocess con argv fijo, sin shell, un
 * único intento y stdout/stderr capturados. Nunca toca `~/.engram` ni el
 * binario existente.
 *
 * Los verificadores específicos por runtime se registran vía
 * `registerOfficialSetupVerifier`; sin verificador, el flujo real omite el
 * setup (no finge éxito).
 */

export type OfficialSetupRuntime = "claude-code" | "codex" | "opencode";

export const OFFICIAL_SETUP_RUNTIMES: readonly OfficialSetupRuntime[] = [
  "claude-code",
  "codex",
  "opencode",
] as const;

export function isOfficialSetupRuntime(runtime: string): runtime is OfficialSetupRuntime {
  return (OFFICIAL_SETUP_RUNTIMES as readonly string[]).includes(runtime);
}

/** Argv fijo del setup oficial; sin aliases (`claude` no existe). */
export function resolveOfficialSetupArgv(runtime: string): string[] {
  switch (runtime) {
    case "claude-code":
      return ["setup", "claude-code"];
    case "codex":
      return ["setup", "codex"];
    case "opencode":
      return ["setup", "opencode"];
    default:
      throw new Error(`Runtime setup oficial desconocido: ${runtime}.`);
  }
}

/** Gate install-only: solo install real (sin dry-run ni target-dir). */
export function shouldRunOfficialSetup(opts: {
  command?: unknown;
  dryRun?: unknown;
  targetDir?: unknown;
}): boolean {
  return opts.command === "install" && opts.dryRun === false && opts.targetDir === undefined;
}

export interface OfficialSetupSpawnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface OfficialSetupVerifyResult {
  ok: boolean;
  layers?: string[];
  ownershipTransferred?: boolean;
  reason?: string;
  stderr?: string;
}

export interface OfficialSetupDeps {
  homeDir: string;
  engramBin: string;
  backup: () => Promise<{ id: string }>;
  spawn: (bin: string, argv: string[], options: { shell: false }) => Promise<OfficialSetupSpawnResult>;
  verify: () => Promise<OfficialSetupVerifyResult>;
  restore?: () => Promise<unknown>;
  /** Ficheros que el setup puede crear/modificar. Obligatorio y no vacío. */
  targets: string[];
}

export interface OfficialSetupResult {
  ok: boolean;
  ownershipTransferred: boolean;
  stdout?: string;
  stderr?: string;
  reason?: string;
  layers?: string[];
}

/**
 * Núcleo inyectable: backup → spawn (un intento, shell false) → verify.
 * Verify siempre se ejecuta tras el spawn (aunque el spawn falle) para
 * diagnosticar por capas; cualquier fallo restaura preexistentes, elimina los
 * targets explícitos creados por el setup y no transfiere ownership.
 */
export async function runOfficialSetup(
  runtime: string,
  deps: OfficialSetupDeps,
): Promise<OfficialSetupResult> {
  if (typeof deps.engramBin !== "string" || !path.isAbsolute(deps.engramBin)) {
    throw new Error(`runOfficialSetup: engramBin absoluto requerido (runtime ${runtime}).`);
  }
  const argv = resolveOfficialSetupArgv(runtime);
  if (!Array.isArray(deps.targets) || deps.targets.length === 0) {
    throw new Error(`runOfficialSetup: targets explícitos no vacíos requeridos (runtime ${runtime}).`);
  }
  const preciseTargets = [...new Set(deps.targets.map((t) => path.resolve(t)))];

  try {
    await deps.backup();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, ownershipTransferred: false, stderr: detail, reason: detail };
  }

  // Existencia previa capturada tras el backup y antes del spawn.
  const existedBefore = new Set(preciseTargets.filter((t) => fs.existsSync(t)));

  let spawnResult: OfficialSetupSpawnResult;
  try {
    spawnResult = await deps.spawn(deps.engramBin, argv, { shell: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    spawnResult = { ok: false, stdout: "", stderr: detail };
  }

  let verifyResult: OfficialSetupVerifyResult;
  try {
    verifyResult = await deps.verify();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    verifyResult = { ok: false, reason: detail };
  }

  const ok = spawnResult.ok === true && verifyResult.ok === true;
  if (ok) {
    return {
      ok: true,
      ownershipTransferred: verifyResult.ownershipTransferred ?? true,
      stdout: spawnResult.stdout,
      stderr: spawnResult.stderr,
      ...(verifyResult.layers === undefined ? {} : { layers: verifyResult.layers }),
    };
  }

  try {
    await deps.restore?.();
  } catch {
    // El fallo original manda; un restore fallido no lo oculta.
  }
  // Rollback: preexistentes ya recompuestos vía restore; eliminar solo los
  // targets explícitos que no existían antes. Best-effort por objetivo.
  for (const t of preciseTargets) {
    try {
      if (!existedBefore.has(t) && fs.existsSync(t)) fs.rmSync(t, { recursive: true, force: true });
    } catch {
      // best-effort por objetivo
    }
  }
  const detail =
    [spawnResult.stderr, verifyResult.stderr, verifyResult.reason, (verifyResult.layers ?? []).join(", ")]
      .map((part) => (part ?? "").trim())
      .filter((part) => part !== "")
      .join("; ") || "setup oficial falló";
  return {
    ok: false,
    ownershipTransferred: false,
    stdout: spawnResult.stdout,
    stderr: detail,
    reason: detail,
    ...(verifyResult.layers === undefined ? {} : { layers: verifyResult.layers }),
  };
}

export type OfficialSetupVerifyFn = (args: {
  configDir: string;
  engramBin: string;
}) => Promise<OfficialSetupVerifyResult>;

/** Verificadores por runtime; cada adapter los registra al cargarse. */
export const officialSetupVerifiers: Partial<Record<OfficialSetupRuntime, OfficialSetupVerifyFn>> = {};

export function registerOfficialSetupVerifier(runtime: OfficialSetupRuntime, fn: OfficialSetupVerifyFn): void {
  officialSetupVerifiers[runtime] = fn;
}

/**
 * Candidatos de backup pre-setup por runtime (solo los existentes se
 * respaldan; `createBackup` ignora ausentes y devuelve null si no hay nada).
 * No incluye `~/.engram` ni el binario.
 *
 * Claude usa el sibling `~/.claude.json` con el configDir default
 * (`<home>/.claude`); con un configDir custom (CLAUDE_CONFIG_DIR) el setup
 * oficial escribe `configDir/.claude.json`.
 */
export function collectOfficialSetupBackupTargets(
  runtime: OfficialSetupRuntime,
  configDir: string,
  homeDir?: string,
): string[] {
  switch (runtime) {
    case "claude-code": {
      const isDefault = homeDir !== undefined
        ? path.resolve(configDir) === path.resolve(path.join(homeDir, ".claude"))
        : path.basename(path.resolve(configDir)) === ".claude";
      return [
        path.join(configDir, "settings.json"),
        isDefault
          ? path.join(path.dirname(configDir), ".claude.json")
          : path.join(configDir, ".claude.json"),
        path.join(configDir, "plugins", "installed_plugins.json"),
      ];
    }
    case "codex":
      return [
        path.join(configDir, "config.toml"),
        path.join(configDir, "engram-instructions.md"),
        path.join(configDir, "engram-compact-prompt.md"),
        path.join(configDir, "AGENTS.md"),
        path.join(configDir, "hooks.json"),
      ];
    case "opencode":
      return [
        path.join(configDir, "opencode.json"),
        path.join(configDir, "opencode.jsonc"),
        path.join(configDir, "tui.json"),
        path.join(configDir, "tui.jsonc"),
        path.join(configDir, "plugins", "engram.ts"),
      ];
  }
}

/** Spawn real: argv fijo, sin shell, un intento, stdout/stderr capturados. */
export async function spawnOfficialSetupBin(
  bin: string,
  argv: string[],
): Promise<OfficialSetupSpawnResult> {
  try {
    const stdout = execFileSync(bin, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      shell: false,
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (error) {
    const stdout = (error as { stdout?: unknown } | null)?.stdout;
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const toText = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof Buffer) return value.toString("utf8");
      return "";
    };
    const errText = error instanceof Error ? error.message : String(error);
    const captured = toText(stderr).trim();
    return { ok: false, stdout: toText(stdout), stderr: captured !== "" ? captured : errText };
  }
}

export type OfficialSetupIfNeededResult =
  | { ran: false }
  | { ran: true; ok: boolean; ownershipTransferred: boolean; stderr?: string; reason?: string };

/**
 * Wiring real para `runInstall`: gate install-only + binario absoluto +
 * verificador registrado. Sin verificador no se ejecuta nada (ran:false): no
 * finge éxito ni rompe el flujo Stack existente. Con
 * verificador usa backup/restore reales y rollback preciso por targets (sin
 * recorrer HOME).
 */
export async function runOfficialSetupIfNeeded(
  runtime: string,
  opts: {
    command?: unknown;
    dryRun?: unknown;
    targetDir?: unknown;
    engramBin?: string | null;
    configDir: string;
    homeDir: string;
  },
): Promise<OfficialSetupIfNeededResult> {
  if (!shouldRunOfficialSetup({ command: opts.command, dryRun: opts.dryRun, targetDir: opts.targetDir })) {
    return { ran: false };
  }
  if (typeof opts.engramBin !== "string" || !path.isAbsolute(opts.engramBin)) return { ran: false };
  if (!isOfficialSetupRuntime(runtime)) return { ran: false };
  const verify = officialSetupVerifiers[runtime];
  if (!verify) return { ran: false };

  const engramBin = opts.engramBin;
  const configDir = opts.configDir;
  const targets = collectOfficialSetupBackupTargets(runtime, configDir, opts.homeDir);
  let backupId: string | null = null;
  const result = await runOfficialSetup(runtime, {
    homeDir: opts.homeDir,
    engramBin,
    backup: async () => {
      const backup = createBackup(targets, `official-engram-setup-${runtime}`);
      backupId = backup?.id ?? null;
      return { id: backupId ?? "no-backup" };
    },
    spawn: async (bin, argv) => spawnOfficialSetupBin(bin, argv),
    verify: async () => verify({ configDir, engramBin }),
    restore: async () => {
      if (backupId !== null) restoreBackup(backupId);
      return { restored: backupId !== null };
    },
    targets,
  });
  return {
    ran: true,
    ok: result.ok,
    ownershipTransferred: result.ownershipTransferred,
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}
