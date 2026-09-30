import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  BoundedProcessOptions,
  BoundedProcessResult,
  BoundedProcessRunner,
  ProcessInvocation,
} from "./bounded-process.js";

export type {
  BoundedProcessOptions,
  BoundedProcessResult,
  BoundedProcessRunner,
  ProcessInvocation,
};

/**
 * Test-side selection of the exact prepared pnpm.
 *
 * Verification tooling must never let an old, unverified pnpm switch versions
 * and acquire packages on its own. This helper resolves an absolute prepared
 * entrypoint, trusts only its package metadata (`name`, version and declared
 * `bin.pnpm`), confirms the real version through the caller's bounded runner,
 * and refuses to continue on missing/incorrect tools without any Corepack or
 * PATH fallback. It also sets the pnpm 11 fail-closed guards on the returned
 * env so pnpm fails instead of acquiring; callers must preserve them on every
 * child (preflight and build).
 */

export const PREPARED_PNPM_ENTRY_ENV = "JORGEX_PNPM_ENTRYPOINT";

/**
 * pnpm 11 fail-closed guards, verified in the prepared 11.1.1 bundle:
 * - `verify-deps-before-run` defaults to `"install"`, which recreates
 *   `node_modules` implicitly before any script. `pnpm_config_verify_deps_before_run`
 *   overrides that setting (pnpm's own config reader), so `"error"` fails closed.
 * - `pm-on-fail` defaults to `"download"` for the `packageManager` version check.
 *   `pnpm_config_pm_on_fail` maps to `pmOnFail`, so `"error"` refuses instead of
 *   acquiring a different pnpm. `npm_config_manage_package_manager_versions` is a
 *   pnpm 9/10-era key and does not gate version switching in pnpm 11.
 */
export const PNPM_PM_ON_FAIL_ENV = "pnpm_config_pm_on_fail";
export const PNPM_VERIFY_DEPS_ENV = "pnpm_config_verify_deps_before_run";

/** Values that make both pnpm 11 guards fail closed instead of acquiring. */
export const PNPM_FAIL_CLOSED = "error";

export type PnpmPackageMetadata = {
  version: string;
  binPath: string;
};

export type PnpmBuildInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type ResolvePnpmBuildInvocationOptions = {
  /** Repository root whose `packageManager` field defines the required version. */
  repoRoot: string;
  /** Environment that provides the prepared entrypoint and is preserved for children. */
  env: NodeJS.ProcessEnv;
  /** Existing bounded runner; never a second execution mechanism. */
  runProcess: BoundedProcessRunner;
  versionCheckTimeoutMs: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRequiredPnpmVersion(packageJsonPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(
      `No se pudo leer ${packageJsonPath} para conocer la versión de pnpm exigida: ${errorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`package.json inválido en ${packageJsonPath}: ${errorMessage(error)}`);
  }

  const packageManager = (parsed as { packageManager?: unknown }).packageManager;
  if (typeof packageManager !== "string" || packageManager.trim() === "") {
    throw new Error(
      `${packageJsonPath} no declara packageManager; se exige una versión exacta de pnpm para verificar.`,
    );
  }

  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(
      `packageManager debe fijar una versión exacta de pnpm (pnpm@X.Y.Z); se encontró "${packageManager.trim()}".`,
    );
  }
  return match[1];
}

function findPackageJson(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Locates the pnpm package metadata that owns `entry`, resolving symlinks first. */
export function readPnpmPackageMetadata(entry: string): PnpmPackageMetadata | undefined {
  let resolvedEntry: string;
  try {
    resolvedEntry = fs.realpathSync(entry);
  } catch (error) {
    // A missing entrypoint is an expected absence; anything else is unexpected.
    if (errnoCode(error) === "ENOENT") return undefined;
    throw new Error(`No se pudo resolver el entrypoint preparado "${entry}": ${errorMessage(error)}`);
  }

  const packageJsonPath = findPackageJson(path.dirname(resolvedEntry));
  if (packageJsonPath === undefined) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw new Error(`No se pudo leer la metadata de "${packageJsonPath}": ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unreadable/incompatible metadata is not an identity claim.
    return undefined;
  }

  const record = parsed as { name?: unknown; version?: unknown; bin?: unknown };
  if (record.name !== "pnpm" || typeof record.version !== "string" || record.version === "") {
    return undefined;
  }

  const bin = record.bin;
  const binField =
    typeof bin === "string"
      ? bin
      : (bin as Record<string, unknown> | undefined)?.["pnpm"];
  if (typeof binField !== "string" || binField === "") return undefined;

  return {
    version: record.version,
    binPath: path.resolve(path.dirname(packageJsonPath), binField),
  };
}

function resolvePreparedEntry(env: NodeJS.ProcessEnv): string {
  const override = typeof env[PREPARED_PNPM_ENTRY_ENV] === "string" ? env[PREPARED_PNPM_ENTRY_ENV].trim() : "";
  const execPath = typeof env.npm_execpath === "string" ? env.npm_execpath.trim() : "";
  const entry = override !== "" ? override : execPath;
  const origin = override !== "" ? PREPARED_PNPM_ENTRY_ENV : "npm_execpath";

  if (entry === "") {
    throw new Error(
      `No hay un pnpm preparado: define ${PREPARED_PNPM_ENTRY_ENV} con la ruta absoluta a su binario preparado o ejecuta la verificación desde pnpm. No se usa Corepack ni PATH.`,
    );
  }
  if (!path.isAbsolute(entry)) {
    throw new Error(`El pnpm preparado indicado por ${origin} debe ser una ruta absoluta: "${entry}".`);
  }
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(`El pnpm preparado indicado por ${origin} no existe como archivo: "${entry}".`);
  }
  return entry;
}

function observedPnpmVersion(result: BoundedProcessResult): string {
  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar el pnpm preparado: ${result.error.message}`);
  }
  if (result.timedOut) {
    throw new Error("El pnpm preparado no respondió a --version dentro del límite acotado.");
  }
  if (result.status !== 0) {
    throw new Error(
      `El pnpm preparado falló al comprobar --version (status ${result.status ?? "null"}): ${result.stderr.trim()}`,
    );
  }
  const output = result.stdout.trim();
  const match = /^(\d+\.\d+\.\d+)$/.exec(output);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `Salida de pnpm --version no exacta (se esperaba solo la versión): "${output}".`,
    );
  }
  return match[1];
}

/**
 * Resolves the exact prepared pnpm and returns the bounded `pnpm build`
 * invocation. Throws before creating any process when the tool is missing,
 * unknown or does not match the required version.
 */
export async function resolvePnpmBuildInvocation(
  options: ResolvePnpmBuildInvocationOptions,
): Promise<PnpmBuildInvocation> {
  const requiredVersion = readRequiredPnpmVersion(path.join(options.repoRoot, "package.json"));
  const entry = resolvePreparedEntry(options.env);
  const metadata = readPnpmPackageMetadata(entry);

  if (metadata === undefined) {
    throw new Error(
      `El pnpm preparado "${entry}" no declara el paquete pnpm (name "pnpm" con bin.pnpm); no se usa Corepack ni PATH.`,
    );
  }
  if (metadata.version !== requiredVersion) {
    throw new Error(
      `El pnpm preparado "${entry}" es ${metadata.version}, pero el repositorio exige pnpm@${requiredVersion}. Instala o selecciona la versión exacta; no se permite instalación ni cambio automático.`,
    );
  }
  if (!fs.existsSync(metadata.binPath) || !fs.statSync(metadata.binPath).isFile()) {
    throw new Error(
      `El pnpm preparado "${entry}" declara bin.pnpm "${metadata.binPath}", que no existe como archivo.`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...options.env,
    [PNPM_PM_ON_FAIL_ENV]: PNPM_FAIL_CLOSED,
    [PNPM_VERIFY_DEPS_ENV]: PNPM_FAIL_CLOSED,
  };
  const result = await options.runProcess(
    { command: process.execPath, args: [metadata.binPath, "--version"] },
    { cwd: options.repoRoot, env, timeoutMs: options.versionCheckTimeoutMs },
  );

  const observed = observedPnpmVersion(result);
  if (observed !== requiredVersion) {
    throw new Error(
      `El pnpm preparado "${entry}" informó ${observed}, pero el repositorio exige pnpm@${requiredVersion}. No se permite instalación ni cambio automático.`,
    );
  }

  return { command: process.execPath, args: [metadata.binPath, "build"], env };
}

export const VERIFICATION_DISK_ROOT_ENV = "JORGEX_VERIFICATION_DISK_ROOT";

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isInsideWorkspace(base: string, repoRoot: string): boolean {
  const relative = path.relative(realpathOrSelf(repoRoot), base);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;

  let current = base;
  for (;;) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Resolves a disk base for private verification roots, rejecting anything that
 * could inherit a workspace selection or live in RAM: paths inside a workspace
 * (repo root or an ancestor with `pnpm-workspace.yaml`), paths with a
 * `node_modules`/`worktrees` segment, and tmpfs or ramfs filesystems (Node
 * `statfs`). A disk-backed OS temp directory is allowed; an unverifiable
 * filesystem fails closed instead of being assumed safe. Override with
 * `JORGEX_VERIFICATION_DISK_ROOT` when the default (the repository's parent)
 * is not disk storage.
 */
export function resolveVerificationDiskBase(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}): string {
  const rawOverride = options.env[VERIFICATION_DISK_ROOT_ENV];
  const override = typeof rawOverride === "string" ? rawOverride.trim() : "";
  const origin = override !== "" ? VERIFICATION_DISK_ROOT_ENV : "el directorio padre del repositorio";
  const base = override !== "" ? override : path.resolve(options.repoRoot, "..");

  if (!path.isAbsolute(base)) {
    throw new Error(`La base de disco de verificación indicada por ${origin} debe ser absoluta: "${base}".`);
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`La base de disco de verificación indicada por ${origin} no es un directorio: "${base}".`);
  }

  const resolved = realpathOrSelf(base);
  if (isInsideWorkspace(resolved, options.repoRoot)) {
    throw new Error(
      `La base de disco de verificación "${resolved}" está dentro de un workspace; define ${VERIFICATION_DISK_ROOT_ENV} fuera de todo workspace.`,
    );
  }

  const segments = resolved.split(path.sep);
  if (segments.includes("node_modules") || segments.includes("worktrees")) {
    throw new Error(
      `La base de disco de verificación "${resolved}" pasa por node_modules/worktrees; define ${VERIFICATION_DISK_ROOT_ENV} fuera de esas rutas.`,
    );
  }

  let fsType: number;
  try {
    fsType = fs.statfsSync(resolved).type;
  } catch (error) {
    throw new Error(
      `No se pudo verificar que la base de disco "${resolved}" no sea RAM (statfs no disponible): ${errorMessage(error)}. Define ${VERIFICATION_DISK_ROOT_ENV} en un filesystem de disco verificable.`,
    );
  }
  if (fsType === 0) {
    throw new Error(
      `La base de disco de verificación "${resolved}" tiene un filesystem no verificable (statfs type 0); define ${VERIFICATION_DISK_ROOT_ENV} en un filesystem de disco verificable.`,
    );
  }
  if (fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC) {
    throw new Error(
      `La base de disco de verificación "${resolved}" está en un filesystem temporal en RAM; define ${VERIFICATION_DISK_ROOT_ENV} en disco.`,
    );
  }

  return resolved;
}

export type OwnedVerificationHome = {
  root: string;
  env: Record<string, string>;
};

/**
 * Creates a private HOME/stage under `base`. Teardown is armed through
 * `register` before the directory exists and a failed creation is cleaned up
 * immediately.
 */
export function createOwnedVerificationHome(options: {
  base: string;
  prefix: string;
  register: (root: string) => void;
}): OwnedVerificationHome {
  const root = path.join(
    options.base,
    `${options.prefix}${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  options.register(root);

  try {
    const dirs = {
      home: path.join(root, "home"),
      userProfile: path.join(root, "user-profile"),
      appData: path.join(root, "app-data"),
      localAppData: path.join(root, "local-app-data"),
      temp: path.join(root, "temp"),
      tmp: path.join(root, "tmp"),
      tmpdir: path.join(root, "tmpdir"),
      xdgConfig: path.join(root, "xdg-config"),
      xdgData: path.join(root, "xdg-data"),
      xdgCache: path.join(root, "xdg-cache"),
    };
    for (const directory of Object.values(dirs)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    return {
      root,
      env: {
        HOME: dirs.home,
        USERPROFILE: dirs.userProfile,
        APPDATA: dirs.appData,
        LOCALAPPDATA: dirs.localAppData,
        TEMP: dirs.temp,
        TMP: dirs.tmp,
        TMPDIR: dirs.tmpdir,
        XDG_CONFIG_HOME: dirs.xdgConfig,
        XDG_DATA_HOME: dirs.xdgData,
        XDG_CACHE_HOME: dirs.xdgCache,
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
    } catch (removeError) {
      cleanupError = removeError;
    }
    const cleanupDetail =
      cleanupError === undefined
        ? ""
        : `; además falló la limpieza de "${root}": ${errorMessage(cleanupError)}`;
    throw new Error(
      `No se pudo crear el HOME privado de verificación en "${root}": ${errorMessage(error)}${cleanupDetail}`,
    );
  }
}

/**
 * Removes every temporary root, keeping failures for a later retry and
 * aggregating all causes plus the still-pending paths. Attempts all roots even
 * when one fails; never loses pending roots.
 */
export function removeTemporaryRoots(
  roots: string[],
  remove: (target: string) => void = (target) =>
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }),
): void {
  const failures: string[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    if (root === undefined) continue;
    try {
      remove(root);
      roots.splice(index, 1);
    } catch (error) {
      failures.push(`${root} (${errorMessage(error)})`);
    }
  }
  if (failures.length > 0 || roots.length > 0) {
    const pending = roots.length === 0 ? "" : `; pendientes: ${roots.join(", ")}`;
    throw new Error(`No se pudieron limpiar roots temporales: ${failures.join("; ")}${pending}`);
  }
}

export type PreparedRepoBuildRun = {
  invocation: ProcessInvocation;
  env: NodeJS.ProcessEnv;
  root: string;
};

/**
 * Real caller wiring for the acceptance build: resolves the exact prepared
 * pnpm before altering the environment, then creates a private disk-backed
 * HOME/stage and overlays it while preserving the pnpm fail-closed guards.
 */
export async function prepareRepoBuildRun(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runProcess: BoundedProcessRunner;
  versionCheckTimeoutMs: number;
  registerTempRoot: (root: string) => void;
}): Promise<PreparedRepoBuildRun> {
  const resolved = await resolvePnpmBuildInvocation({
    repoRoot: options.repoRoot,
    env: options.env,
    runProcess: options.runProcess,
    versionCheckTimeoutMs: options.versionCheckTimeoutMs,
  });

  const base = resolveVerificationDiskBase({ repoRoot: options.repoRoot, env: options.env });
  const owned = createOwnedVerificationHome({
    base,
    prefix: ".jorgex-build-home-",
    register: options.registerTempRoot,
  });

  return {
    invocation: { command: resolved.command, args: resolved.args },
    env: { ...resolved.env, ...owned.env },
    root: owned.root,
  };
}
