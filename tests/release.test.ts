import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
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
  PUBLICABLE_EXACT,
  PUBLICABLE_PREFIXES,
  WORK_PREFIXES,
  WORKFLOW_PREFIXES,
  isNpmVersionNotFoundMessage,
  npmHasVersion,
  isReleaseBumpCommit,
  isTestPath,
  isWorkflowPath,
  isWorkPath,
  resolveEventDiffBase,
  resolvePublishDiffBase,
  resolveRecoveryDiffBase,
  readPackageVersion,
  shouldBlockMixedWorkflowRelease,
  writePackageVersion,
} from "../src/lib/release.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_METADATA = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8") as string) as { packageManager: string; version: string };
const PACKAGE_VERSION = PACKAGE_METADATA;
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "publish.yml");

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

type InlineReleaseClassifier = (changedPaths: readonly string[]) => {
  publicPaths: string[];
  ignoredPaths: string[];
  testPaths: string[];
  workPaths: string[];
  workflowPaths: string[];
};

/**
 * Extract only the inline path classifier from publish.yml. The fixture stops
 * before bumpPatch, so it cannot invoke release/version, git, or registry code.
 */
function extractInlineReleaseClassifier(): InlineReleaseClassifier {
  const workflow = readWorkflow();
  const helpersStart = workflow.indexOf("const PUBLICABLE_EXACT =");
  const helpersEnd = workflow.indexOf("const bumpPatch = (version) =>", helpersStart);
  const loopStart = workflow.indexOf("const publicPaths = [];", helpersEnd);
  const loopEnd = workflow.indexOf("const recoveryRun =", loopStart);

  if (helpersStart < 0 || helpersEnd < 0 || loopStart < 0 || loopEnd < 0) {
    throw new Error("No se pudo extraer el clasificador inline de publish.yml.");
  }

  const helpers = workflow.slice(helpersStart, helpersEnd);
  const loop = workflow.slice(loopStart, loopEnd);
  if (helpers.includes("execFileSync") || loop.includes("execFileSync")) {
    throw new Error("El fixture del clasificador no debe ejecutar git, bump ni registry.");
  }

  const source = `${helpers}\nconst classify = (changedPaths) => {\n${loop}\nreturn { publicPaths, ignoredPaths, testPaths, workPaths, workflowPaths };\n};\nclassify`;
  return vm.runInNewContext(source, Object.create(null), { timeout: 100 }) as InlineReleaseClassifier;
}

type PreflightRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
};

type GitFixture = {
  dir: string;
  initialSha: string;
};

function isolatedFixtureEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "appdata"),
    LOCALAPPDATA: path.join(dir, "localappdata"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    TMP: dir,
    TEMP: dir,
    TMPDIR: dir,
    RUNNER_TEMP: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };

  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
  ]) {
    delete env[key];
  }

  return env;
}

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: isolatedFixtureEnv(dir),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 1_000_000,
  }).trim();
}

function copyReleaseModule(dir: string): void {
  const source = path.join(ROOT, "src", "lib", "release.ts");
  for (const target of [path.join(dir, "release.ts"), path.join(dir, "src", "lib", "release.ts")]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function createGitFixture(options: { copyModule?: boolean } = {}): GitFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-release-preflight-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture-release", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "src", "base.ts"), "export const fixture = true;\n", "utf8");
  if (options.copyModule !== false) copyReleaseModule(dir);

  runGit(dir, ["init"]);
  runGit(dir, ["config", "user.name", "JorgeX preflight fixture"]);
  runGit(dir, ["config", "user.email", "fixture@example.invalid"]);
  runGit(dir, ["config", "core.quotePath", "true"]);
  runGit(dir, ["add", "--all"]);
  runGit(dir, ["commit", "-m", "fixture: initial"]);
  const initialSha = runGit(dir, ["rev-parse", "HEAD"]);
  runGit(dir, ["tag", "v1.0.0", initialSha]);

  return { dir, initialSha };
}

function commitFixture(fixture: GitFixture, files: Record<string, string>, message: string): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(fixture.dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  runGit(fixture.dir, ["add", "--all"]);
  runGit(fixture.dir, ["commit", "-m", message]);
  return runGit(fixture.dir, ["rev-parse", "HEAD"]);
}

function extractPreflightNodeScript(): string {
  const validate = splitTopLevelJobs(readWorkflow()).get("validate") ?? "";
  const lines = validate.split(/\r?\n/);
  const preflightIndex = lines.findIndex((line) => /^\s*-\s+id:\s+preflight\s*$/.test(line));
  if (preflightIndex < 0) {
    throw new Error("No se encontró el step id: preflight en publish.yml.");
  }

  const preflightIndent = (lines[preflightIndex] ?? "").search(/\S/);
  const stepEnd = lines.findIndex((line, index) => {
    if (index <= preflightIndex || line.trim() === "") return false;
    const indent = line.search(/\S/);
    return indent >= 0 && indent <= preflightIndent && /^\s*-\s+/.test(line);
  });
  const stepLines = lines.slice(preflightIndex, stepEnd < 0 ? lines.length : stepEnd);
  const runIndex = stepLines.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
  if (runIndex < 0) {
    throw new Error("El step id: preflight no contiene run: |.");
  }

  const runIndent = (stepLines[runIndex] ?? "").search(/\S/);
  const body: string[] = [];
  for (const line of stepLines.slice(runIndex + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= runIndent) break;
    body.push(line.slice(Math.min(line.length, runIndent + 2)));
  }

  const shellScript = body.join("\n").replace(/\n+$/, "");
  const heredoc = /node\b[^\n]*<<\s*["']?NODE["']?\s*\n/.exec(shellScript);
  if (heredoc === null) {
    throw new Error("El preflight no contiene un heredoc Node delimitado por NODE.");
  }
  const sourceStart = heredoc.index + heredoc[0].length;
  const sourceEnd = shellScript.indexOf("\nNODE", sourceStart);
  if (sourceEnd < 0) {
    throw new Error("El heredoc Node del preflight no tiene cierre NODE.");
  }

  const source = shellScript.slice(sourceStart, sourceEnd).replace(/^\n+/, "");
  if (source.includes("pnpm") || source.includes("npm publish") || source.includes("git push")) {
    throw new Error("El fixture del preflight no debe ejecutar instalación, publicación ni push.");
  }
  return `${source}\n`;
}

function runPreflight(
  fixture: GitFixture,
  nodeSource: string,
  options: { eventName?: string; before?: string; releaseSha?: string; head?: string } = {},
): PreflightRunResult {
  const head = options.head ?? runGit(fixture.dir, ["rev-parse", "HEAD"]);
  const outputPath = path.join(fixture.dir, "github-output.txt");
  const summaryPath = path.join(fixture.dir, "github-summary.md");
  const env = isolatedFixtureEnv(fixture.dir, {
    GITHUB_EVENT_NAME: options.eventName ?? "push",
    GITHUB_EVENT_BEFORE: options.before ?? fixture.initialSha,
    GITHUB_SHA: head,
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_WORKSPACE: fixture.dir,
    GITHUB_ACTOR: "fixture-user",
    TARGET_SHA: head,
    RELEASE_SHA: options.releaseSha ?? "",
    EVENT_NAME: options.eventName ?? "push",
    BRANCH_NAME: "main",
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
  });
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: fixture.dir,
    encoding: "utf8",
    env,
    input: nodeSource,
    maxBuffer: 2_000_000,
    timeout: 10_000,
    windowsHide: true,
  });

  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar Node para el preflight: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(`Node no terminó dentro del timeout del preflight (signal=${result.signal ?? "unknown"}).`);
  }

  return {
    status: result.status,
    stdout,
    stderr,
    output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
  };
}

function expectPreflightFlag(result: PreflightRunResult, expected: boolean, label: string): void {
  expect(result.status, `${label}: status`).toBe(0);
  expect(result.output.trim().split(/\r?\n/).filter(Boolean), `${label}: output`).toEqual([
    `should_validate=${expected ? "true" : "false"}`,
  ]);
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

function extractWorkflowStepBlock(job: string, marker: string): string {
  const markerIndex = job.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`No se encontró el marcador de step ${marker}.`);
  }

  const stepStart = job.lastIndexOf("      - ", markerIndex);
  const stepEnd = job.indexOf("\n      - ", markerIndex + marker.length);
  if (stepStart < 0) {
    throw new Error(`No se pudo determinar el inicio del step ${marker}.`);
  }

  return job.slice(stepStart, stepEnd < 0 ? job.length : stepEnd);
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
    ]);

    expect(result.publishable).toBe(true);
    expect(result.publicPaths).toEqual([
      "src/foo.ts",
      "stack/agents/foo.md",
      "upstreams.json",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    expect(result.reason).toContain("src/foo.ts");
    expect(result.reason).toContain("stack/agents/foo.md");
  });

  it("bloquea mezclar cambios publicables con workflows", () => {
    const result = classifyReleasePaths([
      "src/foo.ts",
      ".github/workflows/publish.yml",
      "tests/release.test.ts",
      "worktrees/auto-version-publish/plan.md",
      "docs/internal.md",
    ]);

    expect(result.publishable).toBe(false);
    expect(result.publicPaths).toEqual(["src/foo.ts"]);
    expect(result.workflowPaths).toEqual([".github/workflows/publish.yml"]);
    expect(result.testPaths).toEqual(["tests/release.test.ts"]);
    expect(result.workPaths).toEqual(["worktrees/auto-version-publish/plan.md"]);
    expect(result.ignoredPaths).toEqual(["docs/internal.md"]);
    expect(result.reason).toContain("Release bloqueada");
    expect(result.reason).toContain("src/foo.ts");
    expect(result.reason).toContain(".github/workflows/publish.yml");
  });

  it("no bloquea la mezcla publicable+workflow cuando puede auto-bumpear patch", () => {
    const result = classifyReleasePaths([
      "src/foo.ts",
      ".github/workflows/publish.yml",
    ]);

    expect(shouldBlockMixedWorkflowRelease(result, {
      currentVersionExists: true,
      recoveryRun: false,
      releaseBumpCommit: false,
    })).toBe(false);
    expect(shouldBlockMixedWorkflowRelease(result, {
      currentVersionExists: false,
      recoveryRun: false,
      releaseBumpCommit: false,
    })).toBe(true);
    expect(shouldBlockMixedWorkflowRelease(result, {
      currentVersionExists: true,
      recoveryRun: true,
      releaseBumpCommit: false,
    })).toBe(true);
  });

  it("prioriza workflows sobre sufijos test/spec y bloquea mezcla sin auto-bump en ambos clasificadores", () => {
    const changedPaths = [
      ".github/workflows/foo.test.yml",
      ".github/workflows/foo.spec.yml",
      "src/foo.ts",
    ];
    const expected = {
      publicPaths: ["src/foo.ts"],
      ignoredPaths: [],
      testPaths: [],
      workPaths: [],
      workflowPaths: [
        ".github/workflows/foo.test.yml",
        ".github/workflows/foo.spec.yml",
      ],
    };
    const classification = classifyReleasePaths(changedPaths);
    const inlineClassification = extractInlineReleaseClassifier()(changedPaths);

    expect.soft(inlineClassification).toEqual(expected);
    expect.soft(classification).toMatchObject({ publishable: false, ...expected });
    expect.soft(shouldBlockMixedWorkflowRelease(classification, {
      currentVersionExists: false,
      recoveryRun: false,
      releaseBumpCommit: false,
    })).toBe(true);

    expect.soft(inlineClassification).toEqual({
      publicPaths: classification.publicPaths,
      ignoredPaths: classification.ignoredPaths,
      testPaths: classification.testPaths,
      workPaths: classification.workPaths,
      workflowPaths: classification.workflowPaths,
    });
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
    expect(workflowOnly.reason).toBe("Sin cambios publicables: workflows.");
    expect(workflowOnly.workflowPaths).toEqual([".github/workflows/publish.yml"]);
    expect(workflowOnly.ignoredPaths).toEqual([]);
  });

  it("expone los predicados directos para rutas conocidas", () => {
    expect(isPublicablePath("src/lib/release.ts")).toBe(true);
    expect(isPublicablePath("stack/agents/implementer.md")).toBe(true);
    expect(isPublicablePath("work/auto-version-publish/plan.md")).toBe(false);
    expect(isTestPath("tests/release.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.ts")).toBe(true);
    expect(isWorkflowPath(".github/workflows/publish.yml")).toBe(true);
    expect(isWorkflowPath("src/lib/release.ts")).toBe(false);
    expect(isWorkPath("worktrees/auto-version-publish/plan.md")).toBe(true);
  });

  it("no publica cambios de solo documentación (README, PRD, docs/)", () => {
    expect(isPublicablePath("README.md")).toBe(false);
    expect(isPublicablePath("PRD.md")).toBe(false);
    expect(isPublicablePath("docs/guides/setup.md")).toBe(false);

    const docsOnly = classifyReleasePaths(["README.md", "docs/guides/setup.md"]);
    expect(docsOnly.publishable).toBe(false);
    expect(docsOnly.publicPaths).toEqual([]);
    expect(docsOnly.ignoredPaths).toEqual(["README.md", "docs/guides/setup.md"]);
  });

  it("una mezcla doc + código publica, con el doc en ignoredPaths", () => {
    const mixed = classifyReleasePaths(["README.md", "src/foo.ts"]);
    expect(mixed.publishable).toBe(true);
    expect(mixed.publicPaths).toEqual(["src/foo.ts"]);
    expect(mixed.ignoredPaths).toEqual(["README.md"]);
  });

  // El clasificador vive duplicado: la copia inline de publish.yml es la que
  // corre en CI. Si una se desincroniza (p. ej. re-añadir README.md al inline),
  // CI volvería a publicar en doc-only mientras la suite sigue verde. Este test
  // enforza la invariante "Mantener en sync" en vez de confiar en el comentario.
  it("la copia inline de publish.yml coincide con el clasificador de release.ts", () => {
    const workflow = readWorkflow();
    const extractInlineList = (name: string): string[] => {
      const match = new RegExp(`const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]`).exec(workflow);
      if (!match) throw new Error(`No se encontró ${name} en publish.yml`);
      return [...match[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!).sort();
    };

    expect(extractInlineList("PUBLICABLE_EXACT")).toEqual([...PUBLICABLE_EXACT].sort());
    expect(extractInlineList("PUBLICABLE_PREFIXES")).toEqual([...PUBLICABLE_PREFIXES].sort());
    expect(extractInlineList("WORK_PREFIXES")).toEqual([...WORK_PREFIXES].sort());
    expect(extractInlineList("WORKFLOW_PREFIXES")).toEqual([...WORKFLOW_PREFIXES].sort());
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

  it("reconoce el error de pnpm cuando una versión npm no existe", () => {
    expect(isNpmVersionNotFoundMessage("[ERR_PNPM_PACKAGE_NOT_FOUND] No matching version found for jorgex-stack@1.0.3", "jorgex-stack", "1.0.3")).toBe(true);
    expect(isNpmVersionNotFoundMessage("No matching version found for jorgex-stack@1.0.3", "jorgex-stack", "1.0.3")).toBe(true);
    expect(isNpmVersionNotFoundMessage("404 Not Found - GET https://registry.npmjs.org/jorgex-stack", "jorgex-stack", "1.0.3")).toBe(false);
    expect(isNpmVersionNotFoundMessage("ERR_PNPM_FETCH_404 jorgex-stack is not in the npm registry", "jorgex-stack", "1.0.3")).toBe(false);
    expect(isNpmVersionNotFoundMessage("ECONNRESET registry timeout", "jorgex-stack", "1.0.3")).toBe(false);
  });

  it("npmHasVersion devuelve false para versiones ausentes de pnpm y relanza errores reales", () => {
    const missingVersionError = Object.assign(new Error("Command failed: pnpm view jorgex-stack@1.0.3 version"), {
      stdout: "[ERR_PNPM_PACKAGE_NOT_FOUND] No matching version found for jorgex-stack@1.0.3",
      stderr: "",
    });
    const missingVersionStderrError = Object.assign(new Error("Command failed: pnpm view jorgex-stack@1.0.3 version"), {
      stdout: "",
      stderr: "[ERR_PNPM_PACKAGE_NOT_FOUND] No matching version found for jorgex-stack@1.0.3",
    });
    const networkError = Object.assign(new Error("Command failed: pnpm view jorgex-stack@1.0.3 version"), {
      stderr: "ERR_PNPM_META_FETCH_FAIL registry timeout",
    });
    const registry404Error = Object.assign(new Error("Command failed: pnpm view jorgex-stack@1.0.3 version"), {
      stdout: "ERR_PNPM_FETCH_404 jorgex-stack is not in the npm registry, or you have no permission to fetch it",
    });

    expect(npmHasVersion("jorgex-stack", "1.0.3", (() => { throw missingVersionError; }) as never)).toBe(false);
    expect(npmHasVersion("jorgex-stack", "1.0.3", (() => { throw missingVersionStderrError; }) as never)).toBe(false);
    expect(() => npmHasVersion("jorgex-stack", "1.0.3", (() => { throw networkError; }) as never)).toThrow(networkError);
    expect(() => npmHasVersion("jorgex-stack", "1.0.3", (() => { throw registry404Error; }) as never)).toThrow(registry404Error);
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

  it("en recovery usa el último tag alcanzable antes del release_sha", () => {
    expect(resolveRecoveryDiffBase("release-sha", (ref) => (ref === "release-sha^" ? "v1.0.2" : null))).toBe("v1.0.2");
  });

  it("en recovery falla cerrado si no hay tag previo alcanzable", () => {
    expect(() => resolveRecoveryDiffBase("release-sha", () => null)).toThrow(
      "No se pudo reconstruir la base de recovery para release-sha: falta un tag de release previo. No se continúa porque eso podría ocultar cambios anteriores, incluido .github/workflows/*. Haz publish/tag manuales con permisos elevados o recrea el tag previo.",
    );
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

describe("release preflight contract", () => {
  it("decide conservadoramente sobre un fixture Git ejecutando el Node real del workflow", () => {
    const nodeSource = extractPreflightNodeScript();

    const expectFlag = (
      label: string,
      setup: (fixture: GitFixture) => { head: string; before?: string; eventName?: string; releaseSha?: string },
      expected: boolean,
      fixtureOptions?: { copyModule?: boolean },
    ): void => {
      const fixture = createGitFixture(fixtureOptions);
      try {
        const scenario = setup(fixture);
        const result = runPreflight(fixture, nodeSource, scenario);
        expectPreflightFlag(result, expected, label);
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    };

    const expectFailure = (
      label: string,
      setup: (fixture: GitFixture) => { head: string; before?: string; eventName?: string; releaseSha?: string },
      errorPattern: RegExp,
    ): void => {
      const fixture = createGitFixture();
      try {
        const scenario = setup(fixture);
        const result = runPreflight(fixture, nodeSource, scenario);
        expect(result.status, `${label}: status`).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`, `${label}: git error`).toMatch(errorPattern);
        expect(result.output, `${label}: no false skip`).not.toContain("should_validate=false");
      } finally {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      }
    };

    expectFlag("tag docs-only", (fixture) => ({
      head: commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: note"),
    }), false);

    expectFlag("public change before latest docs commit", (fixture) => {
      const publicSha = commitFixture(fixture, { "src/public.ts": "export const publicChange = true;\n" }, "feat: public change");
      const head = commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: note");
      return { head, before: publicSha };
    }, true);

    expectFlag("mixed workflow test filename and source", (fixture) => ({
      head: commitFixture(fixture, {
        ".github/workflows/foo.test.yml": "name: fixture\n",
        "src/public.ts": "export const publicChange = true;\n",
      }, "feat: mixed workflow change"),
    }), true);

    expectFlag("missing current tag falls back conservatively", (fixture) => {
      runGit(fixture.dir, ["tag", "-d", "v1.0.0"]);
      return {
        head: commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: note"),
      };
    }, true);

    expectFailure("invalid diff ref", (fixture) => {
      runGit(fixture.dir, ["tag", "-d", "v1.0.0"]);
      return {
        head: commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: note"),
        before: "refs/heads/does-not-exist",
      };
    }, /does-not-exist|bad revision|unknown revision/i);

    expectFlag("workflow dispatch recovery is always full", (fixture) => {
      const head = commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: note");
      runGit(fixture.dir, ["update-ref", "refs/remotes/origin/main", head]);
      return { head, eventName: "workflow_dispatch", releaseSha: head, before: "" };
    }, true);

    expectFlag("release bump commit is always full", (fixture) => ({
      head: commitFixture(fixture, { "docs/note.md": "documentation\n" }, "chore(release): 1.0.0"),
    }), true);

    expectFlag("dispatch without release module is full", (fixture) => {
      const head = commitFixture(fixture, { "docs/note.md": "documentation\n" }, "docs: historical checkout");
      runGit(fixture.dir, ["update-ref", "refs/remotes/origin/main", head]);
      return { head, eventName: "workflow_dispatch", before: "" };
    }, true, { copyModule: false });

    expectFailure("tag that is not an ancestor", (fixture) => {
      runGit(fixture.dir, ["checkout", "--orphan", "unrelated"]);
      runGit(fixture.dir, ["rm", "-r", "--cached", "."]);
      runGit(fixture.dir, ["add", "--all"]);
      runGit(fixture.dir, ["commit", "-m", "fixture: unrelated root"]);
      const head = runGit(fixture.dir, ["rev-parse", "HEAD"]);
      return { head, before: fixture.initialSha };
    }, /ancestor|ancestro/i);

    expectFlag("quoted Unicode public path remains public", (fixture) => ({
      head: commitFixture(fixture, { "src/ñ.ts": "export const unicode = true;\n" }, "feat: unicode path"),
    }), true);
  }, 60_000);

  it("gobierna pasos caros y bump con should_validate y conserva contratos de seguridad", () => {
    const workflow = readWorkflow();
    const jobs = splitTopLevelJobs(workflow);
    const validate = jobs.get("validate") ?? "";
    const bump = jobs.get("bump") ?? "";
    const preflightIndex = validate.indexOf("id: preflight");
    const resolveIndex = validate.indexOf("id: resolve");

    expect(preflightIndex).toBeGreaterThan(resolveIndex);
    expect(validate).toContain("should_validate: ${{ steps.preflight.outputs.should_validate }}");

    const preflightGuard = /if:\s*(?:\$\{\{\s*)?steps\.preflight\.outputs\.should_validate\s*==\s*['"]true['"](?:\s*\}\})?/;
    for (const marker of [
      "pnpm/action-setup@",
      "cache: pnpm",
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "actions/upload-artifact@",
    ]) {
      const step = extractWorkflowStepBlock(validate, marker);
      expect(step, `step ${marker}`).toMatch(preflightGuard);
      expect(validate.indexOf(marker), `orden ${marker}`).toBeGreaterThan(preflightIndex);
    }

    expect(bump).toMatch(/if:\s*(?:\$\{\{\s*)?needs\.validate\.outputs\.should_validate\s*==\s*['"]true['"](?:\s*\}\})?/);

    expect(workflow).toMatch(/^\s*cancel-in-progress:\s*false\s*$/m);
    for (const name of ["validate", "bump", "publish", "tag-release"]) {
      expect(jobs.get(name), `timeout ${name}`).toMatch(/^\s+timeout-minutes:\s*\d+\s*$/m);
    }

    expect(validate).toContain("permissions:\n      contents: read");
    expect(jobs.get("publish")).toContain("permissions:\n      contents: read");
    expect(jobs.get("bump")).toContain("permissions:\n      contents: write");
    expect(jobs.get("tag-release")).toContain("permissions:\n      contents: write");
    expect(extractWorkflowStepBlock(validate, "actions/checkout@")).toContain("persist-credentials: false");
    expect(extractWorkflowStepBlock(jobs.get("publish") ?? "", "actions/checkout@")).toContain("persist-credentials: false");
    expect(extractWorkflowStepBlock(bump, "actions/checkout@")).not.toContain("persist-credentials: false");
    expect(extractWorkflowStepBlock(jobs.get("tag-release") ?? "", "actions/checkout@")).not.toContain("persist-credentials: false");

    const pinValidation = extractWorkflowStepBlock(validate, "Validate pinned action SHAs");
    const pinValidationCode = pinValidation
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(pinValidationCode).toMatch(/grep -E(?:o)?\s+['"][^'"]*uses:/);
    expect(pinValidationCode).toContain(".github/workflows/publish.yml");
    expect(pinValidationCode).not.toContain("-[[:space:]]+uses:");
    expect(pinValidationCode).toContain("[0-9a-f]{40}");
    expect(validate).toContain("id: resolve");
    expect(validate).toContain("git checkout --detach \"$checkout_sha\"");
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

  it("`--version` usa la acción de versión del CLI", async () => {
    const { parseCliArgs } = await import("../src/cli.js");

    expect(parseCliArgs(["--version"])).toMatchObject({
      action: "version",
      command: "install",
    });
    expect(readPackageVersion()).toBe(PACKAGE_VERSION.version);
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

  it("permite auto-bump cuando el diff acumulado mezcla cambios publicables con workflows", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";
    const noPublicableIndex = bump.indexOf("if (publicPaths.length === 0 && !recoveryRun) {");
    const autoBumpRunIndex = bump.indexOf("const autoBumpRun = !recoveryRun && currentVersionExists && !releaseBumpCommit;");
    const guardIndex = bump.indexOf("if (publicPaths.length > 0 && workflowPaths.length > 0 && !autoBumpRun) {");
    const recoveryBranchIndex = bump.indexOf("if (recoveryRun) {");
    const autoBumpBranchIndex = bump.indexOf("} else if (currentVersionExists && !releaseBumpCommit) {");

    expect(noPublicableIndex).toBeGreaterThan(-1);
    expect(autoBumpRunIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(noPublicableIndex);
    expect(guardIndex).toBeGreaterThan(autoBumpRunIndex);
    expect(guardIndex).toBeLessThan(recoveryBranchIndex);
    expect(guardIndex).toBeLessThan(autoBumpBranchIndex);
    expect(bump).toContain("const workflowPaths = [];");
    expect(bump).toContain("if (isWorkflowPath(rawPath)) {");
    expect(bump).toContain("workflowPaths.push(rawPath);");
    expect(bump).toContain("const resolveRecoveryDiffBase = (head) => {");
    expect(bump).toContain("['describe', '--tags', '--abbrev=0', '--first-parent', '--match', 'v[0-9]*.[0-9]*.[0-9]*', `${head}^`]");
    expect(bump).toContain("? resolveRecoveryDiffBase(head)");
    expect(bump).toContain("falta un tag de release previo");
    expect(bump).not.toContain("return resolveEventDiffBase('', head);");
    expect(bump).not.toContain("if (publicPaths.length > 0 && workflowPaths.length > 0) {");
    expect(bump).not.toContain("if (!recoveryRun && publicPaths.length > 0 && workflowPaths.length > 0) {");
    expect(bump).toContain("GitHub puede rechazar el push del tag sin permisos para workflows");
    expect(bump).toContain("ya está publicada, pero falta ${releaseTag}");
    expect(bump).toContain("Separa la release o publica/tagea manualmente con permisos elevados.");
  });

  it("publica automáticamente una versión manual nueva sin aplicar otro bump", () => {
    const bump = splitTopLevelJobs(readWorkflow()).get("bump") ?? "";
    const manualVersionBranchIndex = bump.indexOf("} else if (!currentVersionExists && !releaseBumpCommit) {");
    const outputsIndex = bump.indexOf("if (shouldPublish) {", manualVersionBranchIndex);

    expect(manualVersionBranchIndex).toBeGreaterThan(-1);
    expect(outputsIndex).toBeGreaterThan(manualVersionBranchIndex);

    const manualVersionBranch = bump.slice(manualVersionBranchIndex, outputsIndex);

    expect(manualVersionBranch).toContain("tagNeeded = releaseTagSha === null;");
    expect(manualVersionBranch).toContain("shouldPublish = true;");
    expect(manualVersionBranch).not.toContain("bumpPatch(");
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
    const enableIndex = bump.indexOf("corepack enable pnpm");
    const corepackIndex = bump.indexOf("corepack prepare pnpm@11.1.1 --activate");
    const releaseIndex = bump.indexOf("id: release");
    const pnpmVersion = PACKAGE_METADATA.packageManager.replace(/^pnpm@/, "");

    expect(setupNodeIndex).toBeGreaterThan(-1);
    expect(enableIndex).toBeGreaterThan(-1);
    expect(corepackIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(setupNodeIndex).toBeLessThan(enableIndex);
    expect(enableIndex).toBeLessThan(corepackIndex);
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
    expect(workflow).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(validate).toContain("Validate pinned action SHAs");
    const pinValidationCode = extractWorkflowStepBlock(validate, "Validate pinned action SHAs")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(pinValidationCode).toMatch(/grep -E(?:o)?\s+['"][^'"]*uses:/);
    expect(pinValidationCode).toContain(".github/workflows/publish.yml");
    expect(pinValidationCode).not.toContain("-[[:space:]]+uses:");
    expect(validate).toContain("curl -fsS \"https://api.github.com/repos/${repo}/commits/${sha}\"");
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
    expect(publish).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
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
    expect(bump).toContain("ERR_PNPM_PACKAGE_NOT_FOUND");
    expect(bump).toContain("No matching version found");
    expect(bump).toContain("String(error?.stdout ?? '')");
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
