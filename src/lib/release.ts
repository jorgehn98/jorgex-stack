import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type ExecFileSyncLike = typeof execFileSync;

const PNPM_VERSION_NOT_FOUND_PATTERN = /\bERR_PNPM_PACKAGE_NOT_FOUND\b/i;
const GIT_TAG_NOT_FOUND_PATTERN = /unknown revision|ambiguous argument|needed a single revision|bad revision|unknown commit|does not have any parents/i;
const ZERO_SHA_PATTERN = /^0+$/;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

const PUBLICABLE_EXACT = new Set([
  "upstreams.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "README.md",
  "PRD.md",
]);

const PUBLICABLE_PREFIXES = ["src/", "stack/"];
const WORK_PREFIXES = ["work/", "worktrees/"];
const WORKFLOW_PREFIXES = [".github/workflows/"];
const TEST_DIR_PATTERN = /(^|\/)(?:__tests__|tests?|specs?)\//i;
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i;

/** Clasificación del diff de un push a main: qué se publicaría y qué se ignora. */
export interface ReleasePathDecision {
  publishable: boolean;
  reason: string;
  publicPaths: string[];
  ignoredPaths: string[];
  testPaths: string[];
  workPaths: string[];
  workflowPaths: string[];
}

/** Nombre y versión leídos de package.json. */
export interface ReleasePackageMetadata {
  name: string;
  version: string;
}

/** Señales del HEAD (mensaje + actor) que se evalúan para detectar commits de bump. */
export interface ReleaseCommitSignal {
  message?: string | null;
  actor?: string | null;
}

/** Plan completo de release: clasificación + estado del paquete + decisión de bump. */
export interface ReleasePlan extends ReleasePathDecision {
  packageName: string;
  currentVersion: string;
  currentVersionExists: boolean;
  releaseBumpCommit: boolean;
  nextVersion: string;
  releaseVersion: string;
  bumpAllowed: boolean;
}

export interface MixedWorkflowReleaseSignal {
  currentVersionExists: boolean;
  releaseBumpCommit: boolean;
  recoveryRun: boolean;
}

export function shouldBlockMixedWorkflowRelease(
  classification: Pick<ReleasePathDecision, "publicPaths" | "workflowPaths">,
  signal: MixedWorkflowReleaseSignal,
): boolean {
  if (classification.publicPaths.length === 0 || classification.workflowPaths.length === 0) return false;

  const canAutoBumpPatch = !signal.recoveryRun && signal.currentVersionExists && !signal.releaseBumpCommit;
  return !canAutoBumpPatch;
}

export function assertCurrentReleaseRun(headSha: string, originMainSha: string): void {
  const head = headSha.trim();
  const originMain = originMainSha.trim();

  if (head === "" || originMain === "") {
    throw new Error("No se pudo resolver la SHA de la run o de origin/main.");
  }

  if (head !== originMain) {
    throw new Error("La run está obsoleta: origin/main cambió tras el fetch.");
  }
}

export function normalizeReleaseSha(releaseSha: string): string {
  const normalized = releaseSha.trim().toLowerCase();

  if (!FULL_GIT_SHA_PATTERN.test(normalized)) {
    throw new Error("La SHA de recuperación debe ser una SHA completa de 40 hex de main.");
  }

  return normalized;
}

export function assertRecoveryReleaseSha(releaseSha: string, originMainSha: string): string {
  const recoverySha = normalizeReleaseSha(releaseSha);
  const originMain = originMainSha.trim().toLowerCase();

  if (originMain === "") {
    throw new Error("No se pudo resolver la SHA de origin/main para la recuperación.");
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", recoverySha, originMain], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (typeof (error as { status?: unknown }).status === "number" && (error as { status?: number }).status === 1) {
      throw new Error(`La SHA de recuperación ${recoverySha} no pertenece a main. Reejecuta workflow_dispatch con release_sha=${recoverySha}.`);
    }

    const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stderr?: unknown }).stderr ?? "")}`.trim();
    throw new Error(`No se pudo comprobar la ascendencia de release_sha contra origin/main. ${message}`.trim());
  }

  return recoverySha;
}

function findPackageJson(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error("No se encontró package.json cerca del CLI.");
}

export function readPackageVersion(): string {
  return readPackageMetadata().version;
}

/** Lee nombre y versión del package.json del repo (busca hacia arriba desde el dist/ del CLI). */
export function readPackageMetadata(): ReleasePackageMetadata {
  const packageJson = findPackageJson();
  const raw = fs.readFileSync(packageJson, "utf8");
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";

  if (name === "" || version === "") {
    throw new Error("package.json no expone nombre o versión válidos.");
  }

  return { name, version };
}

export function normalizeReleasePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function isWorkPath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  return WORK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isWorkflowPath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  return WORKFLOW_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isTestPath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  return TEST_DIR_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(normalized);
}

export function isPublicablePath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  // work/ y worktrees/ se excluyen SIEMPRE, aunque la subruta viva bajo src/ o stack/
  // (p. ej. un worktree que contiene un src/ propio): nunca se publica nada de ahí.
  if (WORK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (PUBLICABLE_EXACT.has(normalized)) return true;
  return PUBLICABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyReleasePaths(paths: readonly string[]): ReleasePathDecision {
  const publicPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const testPaths: string[] = [];
  const workPaths: string[] = [];
  const workflowPaths: string[] = [];

  for (const rawPath of paths) {
    const normalized = normalizeReleasePath(rawPath);
    if (normalized === "") continue;

    if (isWorkPath(normalized)) {
      workPaths.push(normalized);
      continue;
    }

    if (isTestPath(normalized)) {
      testPaths.push(normalized);
      continue;
    }

    if (isWorkflowPath(normalized)) {
      workflowPaths.push(normalized);
      continue;
    }

    if (isPublicablePath(normalized)) {
      publicPaths.push(normalized);
      continue;
    }

    ignoredPaths.push(normalized);
  }

  if (publicPaths.length > 0 && workflowPaths.length > 0) {
    return {
      publishable: false,
      reason: `Release bloqueada: cambios publicables (${publicPaths.join(", ")}) mezclados con workflows (${workflowPaths.join(", ")}).`,
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
      workflowPaths,
    };
  }

  if (publicPaths.length > 0) {
    return {
      publishable: true,
      reason: `Cambios publicables en ${publicPaths.join(", ")}`,
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
      workflowPaths,
    };
  }

  if (workPaths.length > 0 && testPaths.length === 0 && ignoredPaths.length === 0) {
    return {
      publishable: false,
      reason: "Solo cambios en work/ o worktrees/.",
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
      workflowPaths,
    };
  }

  if (testPaths.length > 0 && ignoredPaths.length === 0 && workPaths.length === 0 && workflowPaths.length === 0) {
    return {
      publishable: false,
      reason: "Solo cambios de tests.",
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
      workflowPaths,
    };
  }

  const categories = [
    workPaths.length > 0 ? "work/worktrees" : null,
    testPaths.length > 0 ? "tests" : null,
    workflowPaths.length > 0 ? "workflows" : null,
    ignoredPaths.length > 0 ? "otros no publicables" : null,
  ].filter((part): part is string => part !== null);

  return {
    publishable: false,
    reason: categories.length > 0 ? `Sin cambios publicables: ${categories.join(", ")}.` : "Sin cambios publicables.",
    publicPaths,
    ignoredPaths,
    testPaths,
    workPaths,
    workflowPaths,
  };
}

export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`La versión "${version}" no es un semver simple x.y.z.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Resuelve la base del diff cuando NO existe el tag v<package.version>:
 * usa `github.event.before` (push normal) o cae al SHA del árbol vacío de git
 * (`4b825d…`) en el primer commit de la rama.
 */
export function resolveEventDiffBase(before: string, head: string): string {
  const trimmed = before.trim();

  if (trimmed === "") {
    try {
      return execFileSync("git", ["rev-parse", `${head}^`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
      if (/unknown revision|ambiguous argument|needed a single revision|does not have any parents/i.test(message)) {
        return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      }

      throw new Error(`No se pudo resolver la base de diff para ${head}: ${message.trim()}`);
    }
  }

  return ZERO_SHA_PATTERN.test(trimmed) ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : trimmed;
}

export function resolvePublishDiffBase(
  packageVersion: string,
  eventBefore: string,
  tagExists: (tagRef: string) => boolean,
  head: string,
): string {
  // Si el tag v<version> ya existe, lo usamos como base acumulada: el diff contra
  // ese tag refleja TODO lo que cambió desde la última release. Si no existe
  // (versión nueva que nunca llegó a tagearse), caemos a github.event.before.
  const tagRef = `v${packageVersion.trim()}`;

  if (tagExists(tagRef)) {
    return tagRef;
  }

  return resolveEventDiffBase(eventBefore, head);
}

export function resolveRecoveryDiffBase(
  head: string,
  latestReachableTagBeforeHead: (headParentRef: string) => string | null = resolveLatestReachableTag,
): string {
  const previousTag = latestReachableTagBeforeHead(`${head}^`);
  if (previousTag === null) {
    throw new Error(
      `No se pudo reconstruir la base de recovery para ${head}: falta un tag de release previo. `
      + "No se continúa porque eso podría ocultar cambios anteriores, incluido .github/workflows/*. "
      + "Haz publish/tag manuales con permisos elevados o recrea el tag previo.",
    );
  }

  return previousTag;
}

function resolveLatestReachableTag(ref: string): string | null {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--first-parent", "--match", "v[0-9]*.[0-9]*.[0-9]*", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return tag === "" ? null : tag;
  } catch (error) {
    const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stderr?: unknown }).stderr ?? "")}`.trim();
    if (/No names found|No tags can describe|not a valid object name|unknown revision|ambiguous argument|needed a single revision/i.test(message)) {
      return null;
    }

    throw new Error(`No se pudo resolver el último tag alcanzable desde ${ref}: ${message}`.trim());
  }
}

export function resolveGitTagSha(tagRef: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-list", "-n", "1", tagRef], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().toLowerCase();
    return sha === "" ? null : sha;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stderr?: unknown }).stderr ?? "")}`.trim();

    if (typeof status === "number" && GIT_TAG_NOT_FOUND_PATTERN.test(message)) {
      return null;
    }

    throw new Error(`No se pudo resolver la SHA del tag ${tagRef}: ${message}`.trim());
  }
}

export function assertGitTagTargetsSha(tagRef: string, expectedSha: string): string {
  const actualSha = resolveGitTagSha(tagRef);

  if (actualSha === null) {
    throw new Error(`No existe el tag ${tagRef}.`);
  }

  const normalizedExpected = expectedSha.trim().toLowerCase();

  if (actualSha !== normalizedExpected) {
    throw new Error(`El tag ${tagRef} apunta a ${actualSha}, no a ${normalizedExpected}.`);
  }

  return actualSha;
}

export function buildReleasePlan(
  classification: ReleasePathDecision,
  packageMetadata: ReleasePackageMetadata,
  currentVersionExists: boolean,
  releaseBumpCommit: boolean,
  versionExists: (candidateVersion: string) => boolean = () => false,
): ReleasePlan {
  const bumpAllowed = classification.publishable && currentVersionExists && !releaseBumpCommit;
  const nextVersion = bumpAllowed ? findNextFreePatchVersion(packageMetadata.version, versionExists) : "";

  return {
    ...classification,
    packageName: packageMetadata.name,
    currentVersion: packageMetadata.version,
    currentVersionExists,
    releaseBumpCommit,
    nextVersion,
    releaseVersion: bumpAllowed ? nextVersion : packageMetadata.version,
    bumpAllowed,
  };
}

/**
 * Detecta commits cuyo ÚNICO propósito es bumpear versión (guarda anti-loop).
 * Reconoce: `chore(release): …`, versiones sueltas (`1.0.3`, `v1.0.3`) y
 * bumps atribuidos a actores bot con sufijo exacto `[bot]` + keywords de release.
 * NO matchea `release:` genérico ni `chore:` normal — un chore corriente no
 * debe saltarse el auto-bump.
 */
export function isReleaseBumpCommit(signal: ReleaseCommitSignal): boolean {
  const message = signal.message?.trim() ?? "";
  const actor = signal.actor?.trim() ?? "";
  const lowerMessage = message.toLowerCase();

  if (message === "") return false;
  if (/^chore\(release\):\s+/i.test(message)) return true;
  if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i.test(message)) return true;
  if (/\[bot\]$/i.test(actor) && /\b(?:release|publish|bump|version)\b/i.test(lowerMessage)) return true;
  return false;
}

export function findNextFreePatchVersion(version: string, versionExists: (candidateVersion: string) => boolean): string {
  let candidate = bumpPatch(version);

  while (versionExists(candidate)) {
    candidate = bumpPatch(candidate);
  }

  return candidate;
}

export function isNpmVersionNotFoundMessage(message: string, packageName: string, version: string): boolean {
  const target = `${packageName}@${version}`;
  return PNPM_VERSION_NOT_FOUND_PATTERN.test(message) || message.includes(`No matching version found for ${target}`);
}

/**
 * Comprueba si `<name>@<version>` existe en npm usando `pnpm view` (regla "pnpm
 * siempre, nunca npm"). 404 = "no existe" (caso normal de primera publicación);
 * cualquier otro error se relanza para no enmascarar fallos de red/permisos.
 */
export function npmHasVersion(packageName: string, version: string, execFile: ExecFileSyncLike = execFileSync): boolean {
  try {
    execFile("pnpm", ["view", `${packageName}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stdout?: unknown }).stdout ?? "")}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
    if (isNpmVersionNotFoundMessage(message, packageName, version)) return false;
    throw error;
  }
}

export function writePackageVersion(packageJsonPath: string, version: string): void {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  parsed.version = version;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function assertReleaseBumpTarget(branch: string): void {
  if (branch.trim() !== "main") {
    throw new Error("El bump de release solo puede empujarse a main.");
  }
}
