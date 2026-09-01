import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";
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
    const job: WorkflowJob = { steps: [] };
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
  const description = `${step.name ?? ""}\n${step.run ?? ""}`;
  return /Download the exact JorgeX Pi artifact|Verify the exact JorgeX Pi artifact contract|pnpm test(?:\s|$)|pnpm build(?:\s|$)/i.test(description);
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

describe("JorgeX Pi artifact pull-request gate", () => {
  it("downloads and validates the exact frozen npm tarball before the complete quality suite", () => {
    const workflow = readWorkflow();
    const { name, version } = PI_RUNTIME_CANDIDATE.package;
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd");
    expect(workflow).toContain("pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320");
    expect(workflow).toContain("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    expect(workflow).toContain("curl --fail");
    expect(workflow).toContain("--connect-timeout 15");
    expect(workflow).toContain("--max-time 300");
    expect(workflow).toContain(tarballUrl);
    const artifactPath = "JORGEX_PI_TARBALL: ${{ runner.temp }}/jorgex-pi-" + version + ".tgz";
    expect(workflow).toContain(artifactPath);
    expect(workflow).not.toContain("GITHUB_ENV");
    expect(workflow).not.toMatch(/\bnpm\s+(?:install|publish)\b/);
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toMatch(/(?:contents|id-token):\s*write/);

    expectInOrder(workflow, [
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      tarballUrl,
      artifactPath,
      "pnpm exec vitest run tests/pi-cross-repo-contract.test.ts",
      "pnpm test",
      "pnpm build",
    ]);
  });

  it("acota la descarga de Pi al artefacto fijo y verifica su tamaño antes del contrato", () => {
    const workflow = readWorkflow();
    const { jobs } = readWorkflowShape(workflow);
    const [job] = jobs;
    const { name, version } = PI_RUNTIME_CANDIDATE.package;
    const { bytes } = PI_RUNTIME_CANDIDATE.tarball;
    const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    const downloadStep = (job?.steps ?? []).find((step) => step.name === "Download the exact JorgeX Pi artifact");

    expect(downloadStep, "Falta el paso de descarga del artefacto Pi.").toBeDefined();
    if (downloadStep === undefined) {
      throw new Error("Falta el paso de descarga del artefacto Pi.");
    }

    const script = extractRunScript(downloadStep);
    const exactSizeCheck = `test "$(wc -c < "$tarball")" -eq ${bytes}`;

    expect(script).toContain(tarballUrl);
    expect(script).toContain("--retry 3");
    expect(script).toContain("--connect-timeout 15");
    expect(script).toContain("--max-time 300");
    expect(script).toContain("--retry-max-time 300");
    expect(script).toContain("--remove-on-error");
    expect(script).toContain(`--max-filesize ${bytes}`);
    expect(script).not.toMatch(/\s(?:--location(?:-trusted)?|-L)(?:\s|$)/);
    expect(script).not.toContain("--retry-all-errors");
    expectInOrder(workflow, [exactSizeCheck, "pnpm exec vitest run tests/pi-cross-repo-contract.test.ts"]);
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
    expect(jobs).toHaveLength(1);

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
      "pnpm exec vitest run tests/pi-cross-repo-contract.test.ts",
      "pnpm test",
      "pnpm build",
    ];
    const scalarRuns = (job?.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => run !== undefined && run !== "|");
    const gateRunPrefix = /^pnpm (?:install|typecheck|exec vitest run tests\/pi-cross-repo-contract\.test\.ts|test|build)\b/;
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
