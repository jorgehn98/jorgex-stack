import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NPM_NOT_FOUND_PATTERN = /E404|404 Not Found|No match found/i;
const ZERO_SHA_PATTERN = /^0+$/;

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
const TEST_DIR_PATTERN = /(^|\/)(?:__tests__|tests?|specs?)\//i;
const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i;

export interface ReleasePathDecision {
  publishable: boolean;
  reason: string;
  publicPaths: string[];
  ignoredPaths: string[];
  testPaths: string[];
  workPaths: string[];
}

export interface ReleasePackageMetadata {
  name: string;
  version: string;
}

export interface ReleaseCommitSignal {
  message?: string | null;
  actor?: string | null;
}

export interface ReleasePlan extends ReleasePathDecision {
  packageName: string;
  currentVersion: string;
  currentVersionExists: boolean;
  releaseBumpCommit: boolean;
  nextVersion: string;
  releaseVersion: string;
  bumpAllowed: boolean;
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

export function isTestPath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  return TEST_DIR_PATTERN.test(normalized) || TEST_FILE_PATTERN.test(normalized);
}

export function isPublicablePath(input: string): boolean {
  const normalized = normalizeReleasePath(input);
  if (WORK_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (PUBLICABLE_EXACT.has(normalized)) return true;
  return PUBLICABLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyReleasePaths(paths: readonly string[]): ReleasePathDecision {
  const publicPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const testPaths: string[] = [];
  const workPaths: string[] = [];

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

    if (isPublicablePath(normalized)) {
      publicPaths.push(normalized);
      continue;
    }

    ignoredPaths.push(normalized);
  }

  if (publicPaths.length > 0) {
    return {
      publishable: true,
      reason: `Cambios publicables en ${publicPaths.join(", ")}`,
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
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
    };
  }

  if (testPaths.length > 0 && ignoredPaths.length === 0 && workPaths.length === 0) {
    return {
      publishable: false,
      reason: "Solo cambios de tests.",
      publicPaths,
      ignoredPaths,
      testPaths,
      workPaths,
    };
  }

  const categories = [
    workPaths.length > 0 ? "work/worktrees" : null,
    testPaths.length > 0 ? "tests" : null,
    ignoredPaths.length > 0 ? "otros no publicables" : null,
  ].filter((part): part is string => part !== null);

  return {
    publishable: false,
    reason: categories.length > 0 ? `Sin cambios publicables: ${categories.join(", ")}.` : "Sin cambios publicables.",
    publicPaths,
    ignoredPaths,
    testPaths,
    workPaths,
  };
}

export function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`La versión "${version}" no es un semver simple x.y.z.`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

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
  const tagRef = `v${packageVersion.trim()}`;

  if (tagExists(tagRef)) {
    return tagRef;
  }

  return resolveEventDiffBase(eventBefore, head);
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

export function isReleaseBumpCommit(signal: ReleaseCommitSignal): boolean {
  const message = signal.message?.trim() ?? "";
  const actor = signal.actor?.trim() ?? "";
  const lowerMessage = message.toLowerCase();
  const lowerActor = actor.toLowerCase();

  if (message === "") return false;
  if (/^chore\(release\):\s+/i.test(message)) return true;
  if (/^release(?:[:\s-]|$)/i.test(message)) return true;
  if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i.test(message)) return true;
  if (lowerActor.includes("bot") && /\b(?:release|publish|bump|version)\b/i.test(lowerMessage)) return true;
  return false;
}

export function findNextFreePatchVersion(version: string, versionExists: (candidateVersion: string) => boolean): string {
  let candidate = bumpPatch(version);

  while (versionExists(candidate)) {
    candidate = bumpPatch(candidate);
  }

  return candidate;
}

export function npmHasVersion(packageName: string, version: string): boolean {
  try {
    execFileSync("pnpm", ["view", `${packageName}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const message = `${(error as { message?: string }).message ?? ""}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
    if (NPM_NOT_FOUND_PATTERN.test(message)) return false;
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
