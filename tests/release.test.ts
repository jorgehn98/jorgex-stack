import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  classifyReleasePaths,
  isPublicablePath,
  isReleaseBumpCommit,
  isTestPath,
  isWorkPath,
  readPackageVersion,
} from "../src/lib/release.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8") as string) as { version: string };

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("release path classification", () => {
  it("marca src/, stack/ y manifests de release como publicables", () => {
    const result = classifyReleasePaths([
      "src/foo.ts",
      "stack/agents/foo.md",
      "upstreams.json",
      "package.json",
      "pnpm-lock.yaml",
      "docs/internal.md",
      "tests/release.test.ts",
      "worktrees/auto-version-publish/plan.md",
    ]);

    expect(result.publishable).toBe(true);
    expect(result.publicPaths).toEqual([
      "src/foo.ts",
      "stack/agents/foo.md",
      "upstreams.json",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    expect(result.testPaths).toEqual(["tests/release.test.ts"]);
    expect(result.workPaths).toEqual(["worktrees/auto-version-publish/plan.md"]);
    expect(result.ignoredPaths).toEqual(["docs/internal.md"]);
    expect(result.reason).toContain("src/foo.ts");
    expect(result.reason).toContain("stack/agents/foo.md");
  });

  it("no publica solo tests o worktrees", () => {
    const testsOnly = classifyReleasePaths(["tests/release.test.ts", "src/foo.spec.ts"]);
    expect(testsOnly.publishable).toBe(false);
    expect(testsOnly.reason).toBe("Solo cambios de tests.");
    expect(testsOnly.testPaths).toEqual(["tests/release.test.ts", "src/foo.spec.ts"]);

    const workOnly = classifyReleasePaths(["work/auto-version-publish/plan.md", "worktrees/auto-version-publish/log.txt"]);
    expect(workOnly.publishable).toBe(false);
    expect(workOnly.reason).toBe("Solo cambios en work/ o worktrees/.");
    expect(workOnly.workPaths).toEqual(["work/auto-version-publish/plan.md", "worktrees/auto-version-publish/log.txt"]);
  });

  it("expone los predicados directos para rutas conocidas", () => {
    expect(isPublicablePath("src/lib/release.ts")).toBe(true);
    expect(isPublicablePath("stack/agents/implementer.md")).toBe(true);
    expect(isPublicablePath("work/auto-version-publish/plan.md")).toBe(false);
    expect(isTestPath("tests/release.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.ts")).toBe(true);
    expect(isWorkPath("worktrees/auto-version-publish/plan.md")).toBe(true);
  });
});

describe("release bump loop guard", () => {
  it("reconoce commits de release, bump y bots de release", () => {
    expect(isReleaseBumpCommit({ message: "chore(release): 1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "release: 1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "publish version", actor: "release-bot" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "feat: add docs" })).toBe(false);
  });
});

describe("version sync", () => {
  it("lee la versión real desde package.json", () => {
    expect(readPackageVersion()).toBe(PACKAGE_VERSION.version);
  });

  it("`--version` imprime la misma versión que package.json", async () => {
    const originalArgv = process.argv;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    process.argv = ["node", "cli.ts", "--version"];
    try {
      await import("../src/cli.js");
      await Promise.resolve();
    } finally {
      process.argv = originalArgv;
      logSpy.mockRestore();
    }

    expect(logs).toEqual([PACKAGE_VERSION.version]);
  });
});
