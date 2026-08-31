import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PI_RUNTIME_CANDIDATE } from "./fixtures/pi-runtime.js";

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
 * This is intentionally only the line-oriented subset used by this workflow.
 * It is not a YAML parser: the test must inspect the real job and expressions,
 * without adding a parser dependency or pretending to emulate Actions.
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

/** Evaluate only the boolean/string expression grammar used by FULL. */
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
    expect(workflow).toContain("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
    expect(workflow).toContain("pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
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

    const onIndex = workflow.indexOf("on:\n");
    const jobsIndex = workflow.indexOf("\njobs:", onIndex);
    expect(onIndex).toBeGreaterThan(-1);
    const triggerBlock = workflow.slice(onIndex, jobsIndex < 0 ? workflow.length : jobsIndex);
    expect(triggerBlock).toContain("pull_request:");
    for (const event of ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"]) {
      expect(triggerBlock, `Falta el evento pull_request.${event}.`).toContain(event);
    }
    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).not.toMatch(/\binputs:/);
    expect(triggerBlock).not.toMatch(/^    paths(?:-ignore)?:/m);

    expect(workflow).toMatch(/^concurrency:\n  group:[^\n]*(?:github\.event\.pull_request\.number|github\.ref)[^\n]*(?:github\.event\.pull_request\.number|github\.ref)/m);
    expect(workflow).toMatch(/^  cancel-in-progress:\s*true\s*$/m);
    expect(job).toBeDefined();
    expect(workflow).toMatch(/^    timeout-minutes:\s*10\s*$/m);
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(/^\s+continue-on-error:\s*true\s*$/m);
    expect(workflow).not.toContain("GITHUB_ENV");

    expect(workflow).toContain("git rev-parse HEAD");
    expect(workflow).toContain("github.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event_name");
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    const identityStep = (job?.steps ?? []).find((step) => step.raw.includes("git rev-parse HEAD"));
    expect(identityStep, "Falta el step de identidad del SHA probado.").toBeDefined();
    expect(identityStep?.raw).toContain("GITHUB_STEP_SUMMARY");
    expect(identityStep?.raw).toContain("github.sha");
    expect(identityStep?.raw).toContain("github.event_name");
    expect(identityStep?.raw).toContain("github.event.pull_request.head.sha");
    expect(identityStep?.raw).toContain("github.event.pull_request.base.sha");
    expect(workflow).not.toMatch(/\btoJSON\s*\(\s*github\s*\)|\bsecrets\./i);
  });
});
