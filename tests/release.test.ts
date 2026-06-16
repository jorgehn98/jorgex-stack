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
  findNextFreePatchVersion,
  isPublicablePath,
  isReleaseBumpCommit,
  isTestPath,
  isWorkPath,
  readPackageVersion,
  writePackageVersion,
} from "../src/lib/release.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8") as string) as { version: string };
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "publish.yml");

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function splitTopLevelJobs(workflow: string): Map<string, string> {
  const lines = workflow.split(/\r?\n/);
  const jobStarts: Array<{ name: string; line: number }> = [];
  const jobsIndex = lines.findIndex((line) => line === "jobs:");

  if (jobsIndex === -1) {
    throw new Error("No se encontró la sección jobs en el workflow.");
  }

  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^  ([a-z][\w-]*):$/.exec(lines[index] ?? "");
    if (match) {
      jobStarts.push({ name: match[1]!, line: index });
    }
  }

  const jobs = new Map<string, string>();
  for (let index = 0; index < jobStarts.length; index += 1) {
    const start = jobStarts[index]!.line;
    const end = jobStarts[index + 1]?.line ?? lines.length;
    jobs.set(jobStarts[index]!.name, lines.slice(start, end).join("\n"));
  }

  return jobs;
}

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

  it("no trata un chore normal como release", () => {
    expect(isReleaseBumpCommit({ message: "chore: update deps" })).toBe(false);
    expect(isReleaseBumpCommit({ message: "docs: update publish version section" })).toBe(false);
    expect(isReleaseBumpCommit({ message: "chore(release): 1.0.3" })).toBe(true);
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

  it("busca el primer patch libre si el siguiente ya existe", () => {
    const classification = classifyReleasePaths(["src/lib/release.ts"]);
    const plan = buildReleasePlan(
      classification,
      { name: "jorgex-stack", version: "1.0.2" },
      true,
      false,
      (candidate) => candidate === "1.0.3",
    );

    expect(plan.bumpAllowed).toBe(true);
    expect(plan.nextVersion).toBe("1.0.4");
    expect(plan.releaseVersion).toBe("1.0.4");
    expect(findNextFreePatchVersion("1.0.2", (candidate) => candidate === "1.0.3")).toBe("1.0.4");
  });

  it("no hace bump si la versión actual todavía no existe", () => {
    const classification = classifyReleasePaths(["src/lib/release.ts"]);
    const plan = buildReleasePlan(classification, { name: "jorgex-stack", version: "1.0.2" }, false, false);

    expect(plan.publishable).toBe(true);
    expect(plan.bumpAllowed).toBe(false);
    expect(plan.nextVersion).toBe("");
    expect(plan.releaseVersion).toBe("1.0.2");
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

describe("publish workflow contract", () => {
  it("mantiene validate, bump y publish como jobs separados", () => {
    const jobs = splitTopLevelJobs(readWorkflow());

    expect([...jobs.keys()]).toEqual(["validate", "bump", "publish"]);
  });

  it("limita permisos privilegiados al bump y usa OIDC solo en publish", () => {
    const workflow = readWorkflow();
    const jobs = splitTopLevelJobs(workflow);

    expect(workflow).toMatch(/^permissions:\n  contents: read$/m);
    expect(jobs.get("validate")).toContain("permissions:\n      contents: read");
    expect(jobs.get("bump")).toContain("permissions:\n      contents: write");
    expect(jobs.get("publish")).toContain("permissions:\n      contents: read");
    expect(jobs.get("publish")).toContain("id-token: write");
  });

  it("publica desde publish_sha, no ejecuta dist/release.js y no filtra tokens", () => {
    const workflow = readWorkflow();
    const publish = splitTopLevelJobs(workflow).get("publish") ?? "";

    expect(publish).toContain("ref: ${{ needs.bump.outputs.publish_sha }}");
    expect(publish).toContain("npm pack --dry-run --ignore-scripts");
    expect(publish).toContain("npm publish --ignore-scripts --provenance");
    expect(publish).not.toContain("dist/release.js");
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
  });

  it("mantiene la guarda anti-loop cerrada a chore(release), no a chore genérico", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";

    expect(bump).toContain("/^chore\\(release\\):\\s+/i.test(trimmedMessage)");
    expect(bump).not.toContain("/^chore:/i");
  });
});
