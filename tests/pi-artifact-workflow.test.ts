import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { resolveBashExecutable } from "./helpers/bash.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(ROOT, ".github", "workflows", "pi-artifact.yml");

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n/g, "\n");
}

function expectInOrder(haystack: string, needles: string[]): void {
  let cursor = -1;

  for (const needle of needles) {
    const index = haystack.indexOf(needle, cursor + 1);
    expect(index, `No se encontró "${needle}" después de la posición ${cursor}.`).toBeGreaterThan(-1);
    cursor = index;
  }
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  raw: string;
};

type WorkflowJob = {
  name?: string;
  if?: string;
  raw: string;
  steps: WorkflowStep[];
};

/**
 * Extract only the line-oriented job and step fields used by this workflow.
 * This is deliberately not a YAML parser or a GitHub Actions interpreter; it
 * checks the workflow text without adding a parser dependency.
 */
function readWorkflowShape(workflow: string): { jobs: WorkflowJob[] } {
  const lines = workflow.split("\n");
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  if (jobsIndex < 0) {
    throw new Error("El workflow no contiene jobs.");
  }

  const jobs: WorkflowJob[] = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[index] ?? "");
    if (!jobMatch) {
      continue;
    }

    const end = lines.findIndex((line, candidate) => candidate > index && (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^[^\s].*:\s*$/.test(line)));
    const block = lines.slice(index, end < 0 ? lines.length : end);
    const job: WorkflowJob = { raw: block.join("\n"), steps: [] };
    for (const line of block) {
      const nameMatch = /^    name:\s*(.+)$/.exec(line);
      const ifMatch = /^    if:\s*(.+)$/.exec(line);
      if (nameMatch) job.name = nameMatch[1];
      if (ifMatch) job.if = ifMatch[1];
    }

    const stepsIndex = block.findIndex((line) => line === "    steps:");
    if (stepsIndex >= 0) {
      const stepStarts = block
        .map((line, candidate) => (/^      -\s*/.test(line) ? candidate : -1))
        .filter((candidate) => candidate >= stepsIndex);

      for (const [position, stepStart] of stepStarts.entries()) {
        const stepEnd = stepStarts[position + 1] ?? block.length;
        const stepLines = block.slice(stepStart, stepEnd);
        const step: WorkflowStep = { raw: stepLines.join("\n") };
        const firstLine = stepLines[0]?.replace(/^      -\s*/, "") ?? "";
        const fields = [firstLine, ...stepLines.slice(1).map((line) => line.trimStart())];
        for (const field of fields) {
          const match = /^(name|uses|run|if):\s*(.*)$/.exec(field);
          if (match) {
            const key = match[1] as "name" | "uses" | "run" | "if";
            step[key] = match[2] ?? "";
          }
        }
        job.steps.push(step);
      }
    }

    jobs.push(job);
  }

  return { jobs };
}

/**
 * Isolate the small, fixed trigger block used by this workflow. This is
 * intentionally line-oriented; it is not a general YAML parser.
 */
function readTriggerBlock(workflow: string): string {
  const lines = workflow.split("\n");
  const onIndex = lines.findIndex((line) => line === "on:");
  if (onIndex < 0) {
    throw new Error("El workflow no contiene on:.");
  }

  const triggerEnd = lines.findIndex((line, index) => index > onIndex && line.length > 0 && !/^\s/.test(line));
  return lines.slice(onIndex + 1, triggerEnd < 0 ? lines.length : triggerEnd).join("\n").trim();
}

function extractWithBlock(step: WorkflowStep): string[] {
  const lines = step.raw.split("\n");
  const withIndex = lines.findIndex((line) => /^\s*with:\s*$/.test(line));
  if (withIndex < 0) {
    throw new Error(`El step ${step.name ?? "sin nombre"} no contiene with:.`);
  }

  const withLine = lines[withIndex] ?? "";
  const withIndent = withLine.search(/\S/);
  if (withIndent < 0) {
    throw new Error(`No se pudo determinar la indentación de with en ${step.name ?? "sin nombre"}.`);
  }

  const block: string[] = [];
  for (const line of lines.slice(withIndex + 1)) {
    if (line.trim() === "") {
      continue;
    }
    const indent = line.search(/\S/);
    if (indent <= withIndent) {
      break;
    }
    block.push(line.slice(withIndent + 2).trimEnd());
  }
  return block;
}

function extractRunScript(step: WorkflowStep): string {
  const lines = step.raw.split("\n");
  const runIndex = lines.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
  if (runIndex < 0) {
    throw new Error(`El step ${step.name ?? "sin nombre"} no contiene run: |.`);
  }

  const runLine = lines[runIndex] ?? "";
  const runIndent = runLine.search(/\S/);
  if (runIndent < 0) {
    throw new Error(`No se pudo determinar la indentación del run en ${step.name ?? "sin nombre"}.`);
  }

  const body: string[] = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }

    const indent = line.search(/\S/);
    if (indent <= runIndent) {
      break;
    }
    body.push(line.slice(Math.min(line.length, runIndent + 2)));
  }

  const script = body.join("\n").replace(/\n+$/, "");
  if (script.length === 0) {
    throw new Error(`El run de ${step.name ?? "sin nombre"} está vacío.`);
  }
  return `${script}\n`;
}

type IdentityRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  summary: string;
};

function runIdentityScript(script: string, expectedSha: string, actualSha: string): IdentityRunResult {
  const bash = resolveBashExecutable();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-pi-identity-"));
  const summaryPath = path.join(fixtureDir, "summary.md");

  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["BASH_ENV", "ENV"]) {
      delete env[key];
    }
    const configDir = path.join(fixtureDir, "config");
    env.HOME = fixtureDir;
    env.USERPROFILE = fixtureDir;
    env.APPDATA = fixtureDir;
    env.LOCALAPPDATA = fixtureDir;
    env.XDG_CONFIG_HOME = configDir;
    env.GIT_CONFIG_GLOBAL = path.join(fixtureDir, ".gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.TMPDIR = fixtureDir;
    env.TMP = fixtureDir;
    env.TEMP = fixtureDir;
    env.RUNNER_TEMP = fixtureDir;
    env.PATH = fixtureDir;
    env.GITHUB_STEP_SUMMARY = summaryPath;
    env.EXPECTED_SHA = expectedSha;
    env.EVENT_NAME = "workflow_dispatch";
    env.EVENT_ACTION = "";
    env.PR_HEAD_SHA = "";
    env.PR_BASE_SHA = "";
    env.STUB_GIT_SHA = actualSha;

    const gitStub = [
      "git() {",
      '  if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then',
      '    printf "%s\\n" "$STUB_GIT_SHA"',
      "    return 0",
      "  fi",
      '  printf "Unexpected git invocation: %s\\n" "$*" >&2',
      "  return 2",
      "}",
    ].join("\n");
    const wrappedScript = `${gitStub}\n${script}`;
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", wrappedScript], {
      cwd: fixtureDir,
      encoding: "utf8",
      env,
      maxBuffer: 1_000_000,
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(`No se pudo ejecutar Bash para el script de identidad: ${result.error.message}`);
    }
    if (result.status === null) {
      throw new Error(`Bash no terminó dentro del timeout de verificación (signal=${result.signal ?? "unknown"}).`);
    }

    const stdout = result.stdout;
    const stderr = result.stderr;
    const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "";
    return { status: result.status, stdout, stderr, summary };
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

const FULL_EXPRESSION =
  "github.event_name != 'pull_request' || github.event.action == 'ready_for_review' || github.event.pull_request.draft != true";

function expressionBody(value: string): string {
  const match = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value.trim());
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(`Se esperaba una expresión Github completa: ${value}`);
  }
  return body;
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/^\((.*)\)$/, "$1");
}

type EventFixture = {
  eventName: string;
  action?: string;
  draft?: boolean | null;
  full: boolean;
};

/**
 * Evaluate the restricted boolean/string subset used by the routing predicates.
 * This is JavaScript-compatible evaluation of extracted text, not an Actions
 * expression interpreter or a security boundary.
 */
function evaluateExpression(raw: string, fixture: EventFixture): unknown {
  let expression = expressionBody(raw)
    .replace(/github\.event\.pull_request\.draft/g, "draft")
    .replace(/github\.event\.action/g, "action")
    .replace(/github\.event_name/g, "eventName");

  if (!/^[\sA-Za-z0-9_!<>=&|().'"-]+$/.test(expression) || /github\.|\b(env|secrets|steps|runner)\b/.test(expression)) {
    throw new Error(`Expresión fuera del subconjunto soportado por este test: ${expression}`);
  }

  return vm.runInNewContext(expression, {
    eventName: fixture.eventName,
    action: fixture.action,
    draft: fixture.draft,
  }, { timeout: 50 });
}

function isExpensiveStep(step: WorkflowStep): boolean {
  const description = `${step.name ?? ""}\n${step.run ?? ""}\n${step.raw ?? ""}`;
  return /pnpm build(?:\s|$)|dist\/pi-ci-artifact\.js|pi-cross-repo-contract|pnpm test(?:\s|$)/i.test(description);
}

const EVENT_MATRIX: EventFixture[] = [
  { eventName: "pull_request", action: "opened", draft: true, full: false },
  { eventName: "pull_request", action: "synchronize", draft: true, full: false },
  { eventName: "pull_request", action: "reopened", draft: true, full: false },
  { eventName: "pull_request", action: "opened", draft: false, full: true },
  { eventName: "pull_request", action: "synchronize", draft: false, full: true },
  { eventName: "pull_request", action: "reopened", draft: false, full: true },
  { eventName: "pull_request", action: "ready_for_review", draft: true, full: true },
  { eventName: "pull_request", action: "converted_to_draft", draft: true, full: false },
  { eventName: "workflow_dispatch", full: true },
  { eventName: "pull_request", action: "opened", draft: null, full: true },
  { eventName: "pull_request", action: "opened", full: true },
];

const OBSERVED_TARBALL_ENV = "JORGEX_PI_TARBALL: ${{ runner.temp }}/jorgex-pi.tgz";
const OBSERVED_CANDIDATE_ENV = "JORGEX_PI_CANDIDATE: ${{ runner.temp }}/pi-observed.json";
const OBSERVED_RUN = 'node dist/pi-ci-artifact.js "$JORGEX_PI_TARBALL" "$JORGEX_PI_CANDIDATE"';
const CONTRACT_RUN = "pnpm exec vitest run tests/pi-cross-repo-contract.test.ts";

describe("JorgeX Pi artifact pull-request gate", () => {
  it("resuelve el latest publicado observado con el resolver producto y ordena build antes de adquirir", () => {
    const workflow = readWorkflow();

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd");
    expect(workflow).toContain("pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320");
    expect(workflow).toContain("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    expect(workflow).toContain(OBSERVED_TARBALL_ENV);
    expect(workflow).toContain(OBSERVED_CANDIDATE_ENV);
    expect(workflow).toContain(OBSERVED_RUN);
    expect(workflow).toContain(CONTRACT_RUN);
    expect(workflow).not.toContain(".github/scripts/pi-pin.mjs");
    expect(workflow).not.toContain("steps.pi-pin.outputs");
    expect(workflow).not.toContain("PI_TARBALL_URL");
    expect(workflow).not.toContain("PI_TARBALL_BYTES");
    expect(workflow).not.toContain("curl --fail");
    expect(workflow).not.toContain("GITHUB_ENV");
    expect(workflow).not.toContain("0.8.7");
    expect(workflow).not.toContain("89142426");
    expect(workflow).not.toMatch(/\bnpm\s+(?:install|publish)\b/);
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toMatch(/(?:contents|id-token):\s*write/);

    expectInOrder(workflow, [
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm build",
      OBSERVED_RUN,
      OBSERVED_TARBALL_ENV,
      OBSERVED_CANDIDATE_ENV,
      CONTRACT_RUN,
      "pnpm test",
    ]);
  });

  it("adquiere el tarball verificado con args absolutos temporales mediante el dist construido", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const resolveStep = (job?.steps ?? []).find((step) => step.raw.includes("dist/pi-ci-artifact.js"));

    expect(resolveStep, "Falta el paso que adquiere el artefacto Pi observado.").toBeDefined();
    if (resolveStep === undefined) throw new Error("Falta el paso que adquiere el artefacto Pi observado.");

    expect(resolveStep.name, "El paso de adquisición observada debe tener nombre.").toBeDefined();
    expect(resolveStep.name?.trim().length ?? 0).toBeGreaterThan(0);
    expect(resolveStep.if, "Falta if FULL en la adquisición observada.").toBeDefined();
    expect(normalizeExpression(expressionBody(resolveStep.if ?? ""))).toBe(normalizeExpression(FULL_EXPRESSION));
    expect(resolveStep.raw).toContain(OBSERVED_TARBALL_ENV);
    expect(resolveStep.raw).toContain(OBSERVED_CANDIDATE_ENV);
    expect(resolveStep.run).toBe(OBSERVED_RUN);
    expect(resolveStep.raw).not.toContain("curl --fail");
    expect(resolveStep.raw).not.toContain("PI_TARBALL_URL");
    expect(resolveStep.raw).not.toContain("PI_TARBALL_BYTES");
    expect(resolveStep.raw).not.toContain("GITHUB_OUTPUT");
    expectInOrder(workflow, ["pnpm build", OBSERVED_RUN, CONTRACT_RUN]);
  });

  it("el contrato consume ambos observados y precede a la suite completa", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const contractStep = (job?.steps ?? []).find((step) => (step.run ?? "").includes("tests/pi-cross-repo-contract.test.ts"));

    expect(contractStep, "Falta el paso de contrato del artefacto Pi.").toBeDefined();
    if (contractStep === undefined) throw new Error("Falta el paso de contrato del artefacto Pi.");

    expect(contractStep.if, "Falta if FULL en el contrato Pi.").toBeDefined();
    expect(normalizeExpression(expressionBody(contractStep.if ?? ""))).toBe(normalizeExpression(FULL_EXPRESSION));
    expect(contractStep.raw).toContain(OBSERVED_TARBALL_ENV);
    expect(contractStep.raw).toContain(OBSERVED_CANDIDATE_ENV);
    expect(contractStep.run).toBe(CONTRACT_RUN);
    expectInOrder(workflow, [OBSERVED_RUN, CONTRACT_RUN, "pnpm test"]);
  });
  it("desactiva la caché automática de setup-node y conserva la caché pnpm explícita", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const setupNodeSteps = (job?.steps ?? []).filter((step) => step.uses?.startsWith("actions/setup-node@") ?? false);

    expect(setupNodeSteps, "El gate de Pi debe tener un único setup-node común.").toHaveLength(1);
    const setupNode = setupNodeSteps[0];
    expect(setupNode).toBeDefined();
    if (setupNode === undefined) {
      throw new Error("Falta el setup-node del gate de Pi.");
    }

    const inputs = extractWithBlock(setupNode);
    expect(inputs).toContain("package-manager-cache: false");
    expect(inputs.filter((line) => /^cache\s*:/.test(line))).toEqual(["cache: pnpm"]);
  });

  it("routes the real job conservatively across pull-request and manual events", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    expect(jobs).toHaveLength(4);

    const [job] = jobs;
    expect(job).toBeDefined();
    expect(job?.if).toBeUndefined();
    expect(job?.name).toBeDefined();

    const nameExpression = expressionBody(job?.name ?? "");
    const qualityGateMarker = /&&\s*['"]Quality gate['"]/.exec(nameExpression);
    expect(qualityGateMarker, "El nombre debe derivar del mismo predicado FULL.").not.toBeNull();
    const fullPredicate = nameExpression.slice(0, qualityGateMarker?.index ?? 0).trim();
    expect(normalizeExpression(fullPredicate)).toBe(normalizeExpression(FULL_EXPRESSION));
    expect(nameExpression).toMatch(/['"]Draft checks['"]/);

    const expensiveSteps = (job?.steps ?? []).filter(isExpensiveStep);
    expect(expensiveSteps, "Deben estar presentes los cuatro pasos caros.").toHaveLength(4);
    for (const step of expensiveSteps) {
      expect(step.if, `Falta if en el paso caro ${step.name ?? step.run ?? "desconocido"}.`).toBeDefined();
      expect(normalizeExpression(expressionBody(step.if ?? ""))).toBe(normalizeExpression(FULL_EXPRESSION));
      expect(step.if).not.toMatch(/\benv\.|GITHUB_ENV/);
    }

    for (const fixture of EVENT_MATRIX) {
      expect(evaluateExpression(job?.name ?? "", fixture), JSON.stringify(fixture)).toBe(
        fixture.full ? "Quality gate" : "Draft checks",
      );
      for (const step of expensiveSteps) {
        expect(evaluateExpression(step.if ?? "", fixture), `${step.name ?? step.run}: ${JSON.stringify(fixture)}`).toBe(
          fixture.full,
        );
      }
    }

    const commonStepMatchers: Array<(step: WorkflowStep) => boolean> = [
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
      (step) => step.uses?.startsWith("pnpm/action-setup@") ?? false,
      (step) => step.uses?.startsWith("actions/setup-node@") ?? false,
      (step) => step.run?.includes("pnpm install --frozen-lockfile") ?? false,
      (step) => step.run?.includes("pnpm typecheck") ?? false,
    ];
    for (const matches of commonStepMatchers) {
      const commonStep = (job?.steps ?? []).find(matches);
      expect(commonStep, "Falta un paso común del gate.").toBeDefined();
      expect(commonStep?.if, "Los pasos comunes no deben rutearse por draft.").toBeUndefined();
    }

    const windows = jobs[1];
    expect(windows?.name).toBe("Browser Windows");
    expect(windows?.if).toBeUndefined();
    expect(workflow).toMatch(/^  browser-windows:\n    name: Browser Windows\n    runs-on: windows-latest/m);
    expect((windows?.steps ?? []).map((step) => step.run).filter(Boolean)).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec vitest run tests/browser-managed-windows.test.ts tests/playwright-windows-execution.test.ts",
      "pnpm exec vitest run tests/pi-host-version.test.ts",
      'pnpm exec vitest run tests/browser-provider-resolution.test.ts -t "through the real pnpm stage"',
    ]);
    for (const step of windows?.steps ?? []) {
      if (step.uses !== undefined) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    const livePi = jobs[2];
    expect(livePi?.name).toBe("Pi runtime (${{ matrix.os }})");
    expect(livePi?.if).toBeUndefined();
    expect(workflow).toContain("os: [ubuntu-latest, windows-latest]");
    expect(livePi?.steps.some((step) => step.raw.includes("dist/pi-ci-artifact.js"))).toBe(true);
    expect(livePi?.steps.some((step) => step.run?.includes("tests/pi-linked-smoke-live.test.ts"))).toBe(true);
    expect(livePi?.steps.some((step) => step.run?.includes("tests/pi-native-phase.test.ts"))).toBe(false);
    const nativePi = jobs[3];
    expect(nativePi?.name).toBe("Pi native runtime (${{ matrix.os }})");
    expect(nativePi?.if).toBeUndefined();
    expect(nativePi?.steps.some((step) => step.raw.includes("dist/pi-ci-artifact.js"))).toBe(true);
    expect(nativePi?.steps.some((step) => step.run?.includes("tests/pi-native-phase.test.ts"))).toBe(true);
    expect(workflow).toContain("PI_TEST_HOST:");
    expect(workflow).toContain("PI_TEST_CANDIDATE:");
  });

  it("separates the linked and native live runtime into independent, equally-scoped jobs", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const linked = jobs.find((job) => job.name === "Pi runtime (${{ matrix.os }})");
    const native = jobs.find((job) => job.name === "Pi native runtime (${{ matrix.os }})");
    expect(linked, "El runtime enlazado conserva su nombre de check estable.").toBeDefined();
    expect(native, "El runtime nativo corre en su propio job.").toBeDefined();
    if (linked === undefined || native === undefined) {
      throw new Error("Faltan los jobs de runtime Pi.");
    }

    // Neither split job is draft-routed, and both keep the two-OS matrix and
    // the same 20-minute budget; the split only narrows the test scope.
    expect(linked.if).toBeUndefined();
    expect(native.if).toBeUndefined();
    expect(workflow.match(/os: \[ubuntu-latest, windows-latest\]/g) ?? []).toHaveLength(2);
    expect(workflow.match(/runs-on: \$\{\{ matrix\.os \}\}/g) ?? []).toHaveLength(2);
    expect(workflow.match(/timeout-minutes: 20/g) ?? []).toHaveLength(2);

    const liveFiles = (job: WorkflowJob, sentinel: string): string[] => {
      const step = (job.steps ?? []).find((candidate) => candidate.run?.includes(sentinel));
      expect(step, `Falta el paso del smoke vivo ${sentinel}.`).toBeDefined();
      return (step?.run ?? "").match(/tests\/[A-Za-z0-9._-]+\.test\.ts/g) ?? [];
    };
    const linkedFiles = liveFiles(linked, "tests/pi-provider-update.test.ts");
    const nativeFiles = liveFiles(native, "tests/pi-native-phase.test.ts");

    // The union of both jobs is exactly the previous live suite: every file
    // still runs once, none is dropped and none is duplicated.
    expect(nativeFiles).toEqual(["tests/pi-native-phase.test.ts"]);
    expect(linkedFiles).not.toContain("tests/pi-native-phase.test.ts");
    expect([...linkedFiles, ...nativeFiles].sort()).toEqual([
      "tests/pi-linked-smoke-live.test.ts",
      "tests/pi-mcp-setup-integration.test.ts",
      "tests/pi-native-phase.test.ts",
      "tests/pi-provider-activation.test.ts",
      "tests/pi-provider-stage.test.ts",
      "tests/pi-provider-update.test.ts",
      "tests/pi-stage-smoke.test.ts",
      "tests/pi-staged-lock.test.ts",
    ]);

    // Both jobs acquire the same verified artifact with the same runner; the
    // split must not change that acquisition.
    for (const job of [linked, native]) {
      const acquire = (job.steps ?? []).find((step) => step.raw.includes("dist/pi-ci-artifact.js"));
      expect(acquire, "Cada job adquiere el artefacto verificado.").toBeDefined();
      expect(acquire?.raw).toContain('node dist/pi-ci-artifact.js "${{ env.JORGEX_PI_LIVE_ARTIFACT }}" "${{ env.PI_TEST_CANDIDATE }}"');
    }
  });

  it("limita GH_TOKEN a los dos pasos de verificación viva con contents: read", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);

    const liveSteps = [
      {
        jobName: "Pi runtime (${{ matrix.os }})",
        stepName: "Verify real Pi link layout and failure detection",
      },
      {
        jobName: "Pi native runtime (${{ matrix.os }})",
        stepName: "Verify authenticated native lifecycle and cleanup",
      },
    ];

    // La autenticación debe reutilizar la identidad efímera del workflow:
    // expresión exacta de github.token, sin PAT ni secreto adicional.
    const ghTokenExpression = /^[ \t]+GH_TOKEN:[ \t]*\$\{\{[ \t]*github\.token[ \t]*\}\}[ \t]*$/m;

    for (const { jobName, stepName } of liveSteps) {
      const job = jobs.find((candidate) => candidate.name === jobName);
      expect(job, `Falta el job ${jobName}.`).toBeDefined();
      if (job === undefined) throw new Error(`Falta el job ${jobName}.`);

      // El job conserva contents: read; el token no eleva permisos.
      expect(job.raw, `El job ${jobName} debe declarar contents: read.`).toContain(
        "permissions:\n      contents: read",
      );

      const step = job.steps.find((candidate) => candidate.name === stepName);
      expect(step, `Falta el paso vivo ${stepName}.`).toBeDefined();
      if (step === undefined) throw new Error(`Falta el paso vivo ${stepName}.`);
      expect(step.raw, `El paso ${stepName} debe exponer GH_TOKEN en su env de paso.`).toMatch(
        ghTokenExpression,
      );
    }

    // El token aparece exactamente una vez por paso de verificación viva: ni
    // en el env del job (scope amplio) ni en adquisición/instalador.
    expect(workflow.match(/\bGH_TOKEN\b/g) ?? []).toHaveLength(liveSteps.length);

    for (const { jobName } of liveSteps) {
      const job = jobs.find((candidate) => candidate.name === jobName);
      const acquire = (job?.steps ?? []).find((step) => step.raw.includes("dist/pi-ci-artifact.js"));
      const installer = (job?.steps ?? []).find((step) => step.raw.includes("pnpm --dir"));
      expect(acquire, `Falta la adquisición del artefacto en ${jobName}.`).toBeDefined();
      expect(installer, `Falta el instalador del host aislado en ${jobName}.`).toBeDefined();
      expect(acquire?.raw, "La adquisición no debe recibir GH_TOKEN.").not.toContain("GH_TOKEN");
      expect(installer?.raw, "El instalador no debe recibir GH_TOKEN.").not.toContain("GH_TOKEN");
    }
  });

  it("declares explicit routing, serialization, identity, and read-only contracts", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const triggerBlock = readTriggerBlock(workflow);

    expect(triggerBlock).toBe([
      "pull_request:",
      "    types:",
      "      - opened",
      "      - synchronize",
      "      - reopened",
      "      - ready_for_review",
      "      - converted_to_draft",
      "  workflow_dispatch:",
    ].join("\n"));

    expect(workflow).toMatch(/^concurrency:\n  group:[^\n]*(?:github\.event\.pull_request\.number|github\.ref)[^\n]*(?:github\.event\.pull_request\.number|github\.ref)/m);
    expect(workflow).toMatch(/^  cancel-in-progress:\s*true\s*$/m);
    expect(job).toBeDefined();
    expect(workflow).toMatch(/^    timeout-minutes:\s*10\s*$/m);
    const checkoutStep = (job?.steps ?? []).find((step) => step.uses?.startsWith("actions/checkout@") ?? false);
    expect(checkoutStep, "Falta el step checkout del workflow.").toBeDefined();
    if (checkoutStep === undefined) {
      throw new Error("Falta el step checkout del workflow.");
    }
    expect(extractWithBlock(checkoutStep)).toEqual([
      "ref: ${{ github.sha }}",
      "persist-credentials: false",
    ]);
    expect(workflow).not.toMatch(/^\s+continue-on-error\s*:/m);
    expect(workflow).not.toContain("GITHUB_ENV");

    const identityStep = (job?.steps ?? []).find((step) => step.raw.includes("git rev-parse HEAD"));
    expect(identityStep, "Falta el step de identidad del SHA probado.").toBeDefined();
    expect(identityStep?.raw).toContain("GITHUB_STEP_SUMMARY");
    expect(identityStep?.raw).toContain("github.sha");
    expect(identityStep?.raw).toContain("github.event_name");
    expect(identityStep?.raw).toContain("github.event.pull_request.head.sha");
    expect(identityStep?.raw).toContain("github.event.pull_request.base.sha");
    expect(workflow).not.toMatch(/\btoJSON\s*\(\s*github\s*\)|\bsecrets\./i);
  });

  it("mantiene los comandos escalares completos y ejecuta la comparación SHA real", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const identityStep = (job?.steps ?? []).find((step) => step.raw.includes("git rev-parse HEAD"));
    expect(identityStep, "Falta el step de identidad del SHA probado.").toBeDefined();

    const gateCommands = [
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm build",
      OBSERVED_RUN,
      CONTRACT_RUN,
      "pnpm test",
    ];
    const scalarRuns = (job?.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined && run !== "|");
    const gateRunPrefix = /^(?:pnpm (?:install|typecheck|exec vitest run tests\/pi-cross-repo-contract\.test\.ts|test|build)\b|node dist\/pi-ci-artifact\.js\b)/;
    expect(scalarRuns.filter((run) => gateRunPrefix.test(run))).toEqual(gateCommands);

    if (identityStep === undefined) {
      throw new Error("Falta el step de identidad del SHA probado.");
    }
    const script = extractRunScript(identityStep);
    const expectedSha = "a".repeat(40);
    const actualSha = "b".repeat(40);
    const matched = runIdentityScript(script, expectedSha, expectedSha);
    expect(matched.status).toBe(0);
    expect(matched.stderr).toBe("");
    expect(matched.summary).toContain(`- Tested SHA: ${expectedSha}`);
    expect(matched.summary).toContain(`- Expected checkout SHA: ${expectedSha}`);

    const mismatched = runIdentityScript(script, expectedSha, actualSha);
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain(`Checkout SHA mismatch: actual=${actualSha} expected=${expectedSha}`);
    expect(mismatched.summary).toContain(`- Tested SHA: ${actualSha}`);
    expect(mismatched.summary).toContain(`- Expected checkout SHA: ${expectedSha}`);
  }, 20_000);
});
