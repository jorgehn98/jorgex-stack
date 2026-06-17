import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildReleasePlan,
  assertCurrentReleaseRun,
  assertReleaseBumpTarget,
  classifyReleasePaths,
  bumpPatch,
  findNextFreePatchVersion,
  isPublicablePath,
  isReleaseBumpCommit,
  isTestPath,
  isWorkPath,
  resolveEventDiffBase,
  resolvePublishDiffBase,
  readPackageVersion,
  writePackageVersion,
} from "../src/lib/release.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_METADATA = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8") as string) as { packageManager: string; version: string };
const PACKAGE_VERSION = PACKAGE_METADATA;
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

function expectInOrder(haystack: string, needles: string[]): void {
  let cursor = -1;

  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    expect(index, `No se encontró "${needle}" después de la posición ${cursor}.`).toBeGreaterThan(-1);
    cursor = index;
  }
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
  it("reconoce solo chore(release), semver puro y bots [bot] exactos", () => {
    expect(isReleaseBumpCommit({ message: "chore(release): 1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "publish version", actor: "github-actions[bot]" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "feat: add docs" })).toBe(false);
  });

  it("no trata release: genérico ni un actor bot no exacto como bump", () => {
    expect(isReleaseBumpCommit({ message: "release: 1.0.3" })).toBe(false);
    expect(isReleaseBumpCommit({ message: "chore: update deps" })).toBe(false);
    expect(isReleaseBumpCommit({ message: "docs: update publish version section" })).toBe(false);
    expect(isReleaseBumpCommit({ message: "chore(release): 1.0.3" })).toBe(true);
    expect(isReleaseBumpCommit({ message: "publish version", actor: "release-bot" })).toBe(false);
  });

  it("solo permite empujar el bump desde main", () => {
    expect(() => assertReleaseBumpTarget("main")).not.toThrow();
    expect(() => assertReleaseBumpTarget("feature/publish"))
      .toThrow("El bump de release solo puede empujarse a main.");
  });
});

describe("release version planning", () => {
  it("rechaza SHAs vacías antes de decidir stale_run", () => {
    expect(() => assertCurrentReleaseRun("", "origin-main-sha")).toThrow(
      "No se pudo resolver la SHA de la run o de origin/main.",
    );
    expect(() => assertCurrentReleaseRun("head-sha", "")).toThrow(
      "No se pudo resolver la SHA de la run o de origin/main.",
    );
  });

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

  it("usa el tag v<package.version> como base acumulada si existe", () => {
    expect(resolvePublishDiffBase("1.0.2", "ignored", (tagRef) => tagRef === "v1.0.2", "head-sha")).toBe("v1.0.2");
  });

  it("cae a github.event.before cuando no existe el tag de la versión actual", () => {
    expect(resolvePublishDiffBase("1.0.2", "before-sha", () => false, "head-sha")).toBe("before-sha");
  });

  it("sigue usando la base vacía en el primer push sin parent", () => {
    expect(resolveEventDiffBase("0000000000000000000000000000000000000000", "head-sha")).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });

  it("aborta runs obsoletas cuando origin/main ya no coincide con GITHUB_SHA", () => {
    expect(() => assertCurrentReleaseRun("head-sha", "other-sha")).toThrow(
      "La run está obsoleta: origin/main cambió tras el fetch.",
    );
    expect(() => assertCurrentReleaseRun("head-sha", "head-sha")).not.toThrow();
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
  it("mantiene validate, bump, publish y tag-release como jobs separados", () => {
    const jobs = splitTopLevelJobs(readWorkflow());

    expect([...jobs.keys()]).toEqual(["validate", "bump", "publish", "tag-release"]);
  });

  it("workflow_dispatch sin release_sha resuelve una SHA objetivo una sola vez en validate y la reutiliza", () => {
    const workflow = readWorkflow();
    const jobs = splitTopLevelJobs(workflow);
    const validate = jobs.get("validate") ?? "";
    const bump = jobs.get("bump") ?? "";
    const publish = jobs.get("publish") ?? "";
    const tagRelease = jobs.get("tag-release") ?? "";

    expect(validate).toContain("workflow_dispatch");
    expect(validate).toContain("target_sha");
    expect(validate).toContain("id: resolve");
    expect(validate).toContain("echo \"target_sha=$checkout_sha\" >> \"$GITHUB_OUTPUT\"");
    expect(validate).toContain("GITHUB_OUTPUT");
    expect(bump).toContain("needs.validate.outputs.target_sha");
    expect(bump).toContain("TARGET_SHA: ${{ needs.validate.outputs.target_sha }}");
    expect(bump).toContain("ref: ${{ needs.validate.outputs.target_sha }}");
  });

  it("workflow_dispatch nunca emite skip_reason=stale_run", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";
    const recoveryRunStart = bump.indexOf("const recoveryRun = EVENT_NAME === 'workflow_dispatch';");
    const publicableStart = bump.indexOf("if (publicPaths.length > 0) {");

    expect(recoveryRunStart).toBeGreaterThan(-1);
    expect(publicableStart).toBeGreaterThan(recoveryRunStart);

    const recoveryRunBlock = bump.slice(recoveryRunStart, publicableStart);
    expect(recoveryRunBlock).not.toContain("skip_reason=stale_run");
  });

  it("separa permisos de validación, bump, publish y tag", () => {
    const workflow = readWorkflow();
    const jobs = splitTopLevelJobs(workflow);

    expect(workflow).toMatch(/^permissions:\r?\n  contents: read$/m);
    expect(workflow).toContain('workflow_dispatch:');
    expect(jobs.get("validate")).toContain("permissions:\n      contents: read");
    expect(jobs.get("bump")).toContain("permissions:\n      contents: write");
    expect(jobs.get("bump")).toContain("corepack prepare pnpm@11.1.1 --activate");
    expect(jobs.get("bump")).toContain("tag_needed=${tagNeeded ? 'true' : 'false'}");
    expect(jobs.get("bump")).toContain("tag_needed: ${{ steps.release.outputs.tag_needed }}");
    expect(jobs.get("publish")).toContain("permissions:\n      contents: read");
    expect(jobs.get("publish")).toContain("id-token: write");
    expect(jobs.get("tag-release")).toContain("permissions:\n      contents: write");
    expect(jobs.get("tag-release")).not.toContain("id-token: write");
    expect(jobs.get("tag-release")).toContain("needs.publish.result == 'success' || needs.bump.outputs.tag_needed == 'true'");
  });

  it("activa pnpm en bump antes del script de release", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";
    const setupNodeIndex = bump.indexOf("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    const corepackIndex = bump.indexOf("corepack prepare pnpm@11.1.1 --activate");
    const releaseIndex = bump.indexOf("id: release");
    const pnpmVersion = PACKAGE_METADATA.packageManager.replace(/^pnpm@/, "");

    expect(setupNodeIndex).toBeGreaterThan(-1);
    expect(corepackIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(setupNodeIndex).toBeLessThan(corepackIndex);
    expect(corepackIndex).toBeLessThan(releaseIndex);
    expect(bump).toContain(`corepack prepare pnpm@${pnpmVersion} --activate`);
    expect(bump).not.toContain("pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa");
  });

  it("escribe tag_needed=false en todos los early exits relevantes", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";
    const earlyExitTagFlags = bump.match(/tag_needed=false/g) ?? [];

    expect(earlyExitTagFlags).toHaveLength(3);
    expect(bump).toContain("La run está obsoleta: origin/main cambió tras el fetch.");
    expect(bump).toContain("Sin cambios publicables.");
  });

  it("usa acciones fijadas por SHA y hace fetch antes de validar la run", () => {
    const workflow = readWorkflow();
    const validate = splitTopLevelJobs(workflow).get("validate") ?? "";
    const bump = splitTopLevelJobs(workflow).get("bump") ?? "";
    const publish = splitTopLevelJobs(workflow).get("publish") ?? "";

    expect(workflow).not.toContain("ref: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.release_sha || 'main' }}");
    expect(workflow).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(workflow).toContain("pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("actions/download-artifact@d3f86a1060a0bac45b974a628896c90dbdf5c8093");
    expect(validate).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && 'main' || github.sha }}");
    expect(validate).toContain("git checkout --detach \"$checkout_sha\"");
    expect(validate).toContain("git merge-base --is-ancestor \"$release_sha\" \"$origin_main\"");
    expect(validate).toContain("^[0-9a-f]{40}$");
    expect(validate).toContain("status=$?");
    expect(validate).toContain("No se pudo comprobar la ascendencia de release_sha contra origin/main");
    expect(bump).toContain("['fetch', 'origin', 'main', '--tags']");
    expect(bump).toContain("['rev-parse', 'origin/main']");
    expect(bump).toContain("v${packageVersion.trim()}");
    expect(bump).toContain("GITHUB_EVENT_BEFORE");
    expect(bump).toContain("La run está obsoleta: origin/main cambió tras el fetch.");
    expect(bump).toContain("ref: ${{ needs.validate.outputs.target_sha }}");
    expect(publish).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(publish).toContain("actions/download-artifact@d3f86a1060a0bac45b974a628896c90dbdf5c8093");
  });

  it("distingue merge-base status 1 de errores reales en validate y en el helper de recovery", () => {
    const workflow = readWorkflow();
    const validate = splitTopLevelJobs(workflow).get("validate") ?? "";
    const bump = splitTopLevelJobs(workflow).get("bump") ?? "";

    expect(validate).toContain("git merge-base --is-ancestor \"$release_sha\" \"$origin_main\"");
    expect(validate).toContain("status=$?");
    expect(validate).toContain("[ \"$status\" -eq 1 ]");
    expect(validate).toContain("No se pudo comprobar la ascendencia de release_sha contra origin/main");

    const recoveryHelperStart = bump.indexOf("const assertRecoveryReleaseSha = (releaseSha, originMainSha) => {");
    const recoveryHelperEnd = bump.indexOf("const readPackageMetadataAtRef = (ref) => {", recoveryHelperStart);
    const recoveryHelper = bump.slice(recoveryHelperStart, recoveryHelperEnd);

    expect(recoveryHelper).toContain("git', ['merge-base', '--is-ancestor', recoverySha, originMain]");
    expect(recoveryHelper).toContain("error.status === 1");
    expect(recoveryHelper).toContain("No se pudo comprobar la ascendencia de release_sha contra origin/main");
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

  it("en bump resuelve la SHA del tag existente antes de declarar tag_needed=false", () => {
    const workflow = readWorkflow();
    const bump = splitTopLevelJobs(workflow).get("bump") ?? "";

    expect(bump).toContain("execFileSync('pnpm', ['view', `${packageName}@${version}`, 'version']");
    expect(bump).not.toContain("execFileSync('npm', ['view'");
    expect(bump).toContain("let releaseTagSha = resolveTagSha(releaseTag);");
    expect(bump).toContain("['rev-list', '-n', '1', tagRef]");
    expect(bump).toContain("publishSha");
    expect(bump).toContain("TARGET_SHA");
    expect(bump).toContain("if (releaseTagSha !== null && releaseTagSha !== publishSha)");
    expect(bump).toContain("El tag ${releaseTag} apunta a ${releaseTagSha}, no a ${publishSha}");
    expect(bump).toContain("Reejecuta workflow_dispatch con release_sha=<sha publicada>.");
  });

  it("workflow_dispatch con release_sha explícita deja publish=false, tag_needed=true y publish_sha=head cuando falta el tag", () => {
    const workflow = readWorkflow();
    const bump = splitTopLevelJobs(workflow).get("bump") ?? "";
    const tagRelease = splitTopLevelJobs(readWorkflow()).get("tag-release") ?? "";

    const recoveryRunStart = bump.indexOf("if (recoveryRun) {");
    const outputsStart = bump.indexOf("} else if (currentVersionExists && !releaseBumpCommit) {", recoveryRunStart);

    expect(recoveryRunStart).toBeGreaterThan(-1);
    expect(outputsStart).toBeGreaterThan(recoveryRunStart);

    const recoveryBlock = bump.slice(recoveryRunStart, outputsStart);

    expect(bump).toContain("const explicitRecoverySha = recoveryRun && RELEASE_SHA !== '';");
    expect(recoveryBlock).toContain("publishSha = head;");
    expect(recoveryBlock).toContain("shouldPublish = !currentVersionExists");
    expect(recoveryBlock).toContain("releaseTagSha === null");
    expect(recoveryBlock).toContain("if (currentVersionExists && releaseTagSha === null && !explicitRecoverySha) {");
    expect(recoveryBlock).not.toContain("if (currentVersionExists && releaseTagSha === null) {");
    expect(recoveryBlock).toContain("El tag ${releaseTag} apunta a ${releaseTagSha}, no a ${head}");
    expect(recoveryBlock).toContain("La versión ${packageJson.name}@${packageJson.version} ya existe en npm pero falta el tag ${releaseTag}");
    expect(recoveryBlock).toContain("Reejecuta workflow_dispatch con release_sha=<sha publicada>.");

    expect(tagRelease).toContain("needs: [bump, publish]");
    expect(tagRelease).toContain("ref: ${{ needs.bump.outputs.publish_sha }}");
    expect(tagRelease).toContain("always()");
    expect(tagRelease).toContain("!cancelled()");
    expect(tagRelease).toContain("needs.publish.result == 'skipped'");
    expect(tagRelease).toContain("needs.bump.outputs.tag_needed == 'true'");
    expect(tagRelease).toContain("needs.publish.result != 'failure'");
    expect(tagRelease).toContain("TAG=\"v$VERSION\"");
    expect(tagRelease).toContain("EXISTING_SHA=\"$(git rev-list -n 1 \"$TAG\")\"");
    expect(tagRelease).toContain("if [ \"$EXISTING_SHA\" != \"$SHA\" ]; then");
    expect(tagRelease).toContain("git tag \"$TAG\" \"$SHA\"");
    expect(tagRelease).toContain("git push origin \"$TAG\"");
  });

  it("workflow_dispatch sin release_sha exige una SHA explícita en vez de caer a origin/main", () => {
    const workflow = readWorkflow();
    const validate = splitTopLevelJobs(workflow).get("validate") ?? "";
    const bump = splitTopLevelJobs(workflow).get("bump") ?? "";

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("release_sha:");
    expect(workflow).toContain("^[0-9a-f]{40}$");
    expect(validate).toContain("release_sha");
    expect(bump).toContain("EVENT_NAME === 'workflow_dispatch'");
    expect(bump).toContain("RELEASE_SHA");
    expect(bump).toContain("const explicitRecoverySha = recoveryRun && RELEASE_SHA !== '';");
    expect(bump).toContain("if (currentVersionExists && releaseTagSha === null && !explicitRecoverySha)");
    expect(bump).toContain("falta el tag ${releaseTag}");
    expect(bump).toContain("release_sha=<sha publicada>");
    expect(bump).toMatch(/throw new Error\(|process\.exit\(1\)/);
  });

  it("mantiene la guarda anti-loop cerrada a chore(release), semver y bots [bot]", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";

    expect(bump).toContain("/^chore\\(release\\):\\s+/i.test(trimmedMessage)");
    expect(bump).not.toContain("/^release(?:[:\\s-]|$)/i.test(trimmedMessage)");
    expect(bump).toContain("/\\[bot\\]$/i.test(trimmedActor)");
    expect(bump).not.toContain(".includes('bot')");
  });

  it("distingue release_bump_commit de sin cambios publicables en logs u outputs", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";

    expect(bump).toContain("release_bump_commit");
    expect(bump).toContain("Sin cambios publicables.");
  });
});
