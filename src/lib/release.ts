import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLICABLE_EXACT = new Set([
  "upstreams.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsup.config.ts",
  "README.md",
  "PRD.md",
  ".github/workflows/publish.yml",
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

export interface ReleaseCommitSignal {
  message?: string | null;
  actor?: string | null;
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
  const packageJson = findPackageJson();
  const raw = fs.readFileSync(packageJson, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version.trim();

  const fallback = process.env.npm_package_version?.trim();
  if (fallback) return fallback;

  throw new Error("No se pudo leer la versión desde package.json.");
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

export function isReleaseBumpCommit(signal: ReleaseCommitSignal): boolean {
  const message = signal.message?.trim() ?? "";
  const actor = signal.actor?.trim() ?? "";
  const lowerMessage = message.toLowerCase();
  const lowerActor = actor.toLowerCase();

  if (message === "") return false;
  if (/^chore(?:\(release\))?:\s+/i.test(message)) return true;
  if (/^release(?:[:\s-]|$)/i.test(message)) return true;
  if (/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i.test(message)) return true;
  if (/\b(?:release|publish|bump)\b.*\bversion\b/i.test(message)) return true;
  if (/\b(?:release|publish|version)\b.*\b(?:bump|update|commit)\b/i.test(message)) return true;
  if (lowerActor.includes("bot") && /\b(?:release|publish|bump|version)\b/i.test(lowerMessage)) return true;
  return false;
}
