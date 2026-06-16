import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildReleasePlan,
  assertReleaseBumpTarget,
  classifyReleasePaths,
  bumpPatch,
  isPublicablePath,
  isReleaseBumpCommit,
  isTestPath,
  isWorkPath,
  readPackageVersion,
  writePackageVersion,
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
      ".github/workflows/publish.yml",
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
    expect(result.ignoredPaths).toEqual(["docs/internal.md", ".github/workflows/publish.yml"]);
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

    const workflowOnly = classifyReleasePaths([".github/workflows/publish.yml"]);
    expect(workflowOnly.publishable).toBe(false);
    expect(workflowOnly.reason).toBe("Sin cambios publicables: otros no publicables.");
    expect(workflowOnly.ignoredPaths).toEqual([".github/workflows/publish.yml"]);
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

  it("solo permite empujar el bump desde main", () => {
    expect(() => assertReleaseBumpTarget("main")).not.toThrow();
    expect(() => assertReleaseBumpTarget("feature/publish"))
      .toThrow("El bump de release solo puede empujarse a main.");
  });
});

describe("release version planning", () => {
  it("auto-bumpea patch cuando la versión publicada ya existe", () => {
    const classification = classifyReleasePaths(["src/lib/release.ts"]);
    const plan = buildReleasePlan(classification, { name: "jorgex-stack", version: "1.0.2" }, true, false);

    expect(plan.publishable).toBe(true);
    expect(plan.bumpAllowed).toBe(true);
    expect(plan.nextVersion).toBe("1.0.3");
    expect(plan.releaseVersion).toBe("1.0.3");
  });

  it("bloquea el auto-bump en commits de release y deja la versión tal cual", () => {
    const classification = classifyReleasePaths(["src/lib/release.ts"]);
    const plan = buildReleasePlan(classification, { name: "jorgex-stack", version: "1.0.3" }, true, true);

    expect(plan.bumpAllowed).toBe(false);
    expect(plan.nextVersion).toBe("");
    expect(plan.releaseVersion).toBe("1.0.3");
  });

  it("sube el patch con semver simple", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("1.2.3-beta.1")).toBe("1.2.4");
    expect(() => bumpPatch("1.2")).toThrow('La versión "1.2" no es un semver simple x.y.z.');
  });
});

describe("version sync", () => {
  it("actualiza package.json sin depender de pnpm", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-release-"));
    const packageJson = path.join(dir, "package.json");

    try {
      fs.writeFileSync(packageJson, `${JSON.stringify({ name: "demo", version: "1.0.2", private: true }, null, 2)}\n`);
      writePackageVersion(packageJson, "1.0.3");

      const updated = JSON.parse(fs.readFileSync(packageJson, "utf8") as string) as { version: string; name: string; private: boolean };
      expect(updated).toEqual({ name: "demo", version: "1.0.3", private: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

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
