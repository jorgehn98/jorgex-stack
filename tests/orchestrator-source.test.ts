import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext } from "../src/adapters/types.js";
import { buildPlan } from "../src/install.js";
import { loadCanonicalAgents } from "../src/lib/canonical.js";
import { stackRoot } from "../src/lib/paths.js";
import { testModelsForRuntime } from "./fixtures/model-map.js";

const RUNTIMES = [
  ["OpenCode", opencodeAdapter],
  ["Codex", codexAdapter],
  ["Claude Code", claudeCodeAdapter],
] as const;

const stackDir = stackRoot();

function makeContext(
  adapter: Adapter,
  configDir: string,
  mode: "human" | "programmatic",
): InstallContext {
  return {
    stackDir,
    configDir,
    mode,
    subagentConcurrency: "serial",
    engramBin: path.join(configDir, "engram"),
    models: testModelsForRuntime(adapter.id),
    warnings: [],
  };
}

function plannedContent(plan: ReturnType<typeof buildPlan>, target: string): string {
  const actions = plan.filter((action) => action.target === target);
  expect(actions).toHaveLength(1);
  const action = actions[0]!;
  return action.kind === "write" ? action.content : fs.readFileSync(action.source, "utf8");
}

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

function standardWorkflowReferencePath(): string {
  return path.join(stackDir, "skills", "orchestrator", "references", "standard-workflow.md");
}

function readStandardWorkflowReference(): string {
  const reference = standardWorkflowReferencePath();
  expect(fs.existsSync(reference), "falta la referencia standard canónica").toBe(true);
  return fs.readFileSync(reference, "utf8");
}

function plannedAgentContent(
  plan: ReturnType<typeof buildPlan>,
  adapter: Adapter,
  ctx: InstallContext,
  name: string,
): string {
  const agent = loadCanonicalAgents(path.join(stackDir, "agents")).find((candidate) => candidate.name === name);
  expect(agent, `falta el agente canónico ${name}`).toBeDefined();

  const rendered = adapter.renderAgent(agent!, ctx.models);
  expect(rendered, `${name}: debe producir un único artefacto nativo`).toHaveLength(1);
  const artifact = rendered[0]!;
  expect(artifact.kind, `${name}: debe seguir siendo un subagente nativo`).toBe("agent");
  return plannedContent(plan, path.join(adapter.paths(ctx.configDir).agentsDir, artifact.file));
}

describe("orchestrator canonical source", () => {
  it("la entrada canónica enruta el workflow y el agent canónico es solo un wrapper", () => {
    const skillFile = path.join(stackDir, "skills", "orchestrator", "SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);

    const skill = fs.readFileSync(skillFile, "utf8");
    const standardWorkflow = readStandardWorkflowReference();
    const wrapper = fs.readFileSync(path.join(stackDir, "agents", "orchestrator.md"), "utf8");

    expect(skill).toContain("name: orchestrator");
    expect(skill).toContain("references/standard-workflow.md");
    expect(standardWorkflow).toContain("INIT → EXPLORE → SPEC → PLAN → EXECUTE → VERIFY → SHIP → CLOSE");
    expect(wrapper).toContain("Load and follow the `orchestrator` skill");
    expect(wrapper).not.toContain("## Phases");
    expect(wrapper).not.toMatch(/^model:/m);
  });

  it("routea short/standard desde la entrada y mantiene el detalle standard en su referencia", () => {
    const skill = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const routing = sectionBetween(skill, "## Routing", "## Shared guards");
    const standardWorkflow = readStandardWorkflowReference();

    expect(routing).toContain("Choose **short**");
    expect(routing).toContain("Choose **standard**");
    expect(routing).toMatch(/scope, uncertainty, risk, or verification/i);
    expect(routing).toContain("references/standard-workflow.md");
    expect(standardWorkflow).toContain("formal SDD PRD and plan");
    expect(standardWorkflow).toContain("PRE before approval and POST before SHIP");
  });

  it("mantiene una sola regla de decisión compartida antes de la ejecución standard", () => {
    const skill = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const decision = sectionBetween(skill, "## Decision before delegation", "## Work state");
    const standardWorkflow = readStandardWorkflowReference();
    const explore = sectionBetween(standardWorkflow, "## 2. EXPLORE", "## 3. SPEC");
    const handoff = sectionBetween(standardWorkflow, "### Handoff rule", "### Testing decision");

    expect(decision).toContain("An analyst's recommendation is evidence for the coordinator");
    expect(explore).toContain("[Decision before delegation](../SKILL.md#decision-before-delegation)");
    expect(explore).not.toContain("Launch analysts according to scope:");
    expect(handoff).toContain("[Decision before delegation](../SKILL.md#decision-before-delegation)");
    expect(handoff).not.toMatch(/analyst's \*\*Recommendation\*\*[\s\S]{0,120}implementer/i);
  });

  it("mantiene el alcance semántico de PR en la guarda común", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const commonLifecycle = sectionBetween(entry, "### Worktree and PR lifecycle", "### Deterministic verification");
    const lifecycle = fs.readFileSync(path.join(stackDir, "skills", "work-lifecycle", "SKILL.md"), "utf8");
    const formalLifecycle = sectionBetween(lifecycle, "## Pull request lifecycle", "## HTML review view");

    expect(commonLifecycle).toMatch(/verifiable vertical slice[\s\S]{0,160}contract, coupling and risk/i);
    expect(formalLifecycle).toContain("[Worktree and PR lifecycle](../orchestrator/SKILL.md#worktree-and-pr-lifecycle)");
    expect(formalLifecycle).not.toContain("Keep one concrete objective per PR: a verifiable vertical slice");
  });

  it("permite short acotado y exige promoción antes de ampliar el riesgo o el alcance", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const routing = sectionBetween(entry, "## Routing", "## Shared guards");

    expect(routing).toContain("objective is clear");
    expect(routing).toContain("affected contract is understood");
    expect(routing).toContain("scope is bounded");
    expect(routing).toContain("sufficient verification");
    expect(routing).toContain("one primary responsible person");
    expect(routing).toContain("specialist only when it adds value");
    expect(routing).toContain("no mandatory analyst, PRE, or POST chain");
    expect(routing).toContain("does not create a PRD, plan, formal task spec, PRE, or POST");
    expect(routing).toContain("A small change is not automatically safe");
    expect(routing).toContain("promote it to standard **before** continuing");
  });

  it("hace explícitas las guardas comunes y la trazabilidad F1 también al elegir short", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const routing = sectionBetween(entry, "## Routing", "## Shared guards");
    const sharedGuards = sectionBetween(entry, "## Shared guards", "## Work state");
    const delegation = sectionBetween(entry, "## Delegation map", "### Worktree and PR lifecycle");
    const lifecycle = sectionBetween(entry, "### Worktree and PR lifecycle", "### Deterministic verification");
    const retries = sectionBetween(entry, "### Bounded retries", "### Final review and PR lifecycle");

    expect(sharedGuards).toContain("Both routes preserve mandatory memory/Engram saves");
    expect(sharedGuards).toContain("testing/TDD by risk");
    expect(sharedGuards).toContain("Git/worktree discipline");
    expect(sharedGuards).toContain("final-draft review");
    expect(sharedGuards).toContain("configured gates");
    expect(sharedGuards).toContain("explicit user approval for merge");
    expect(routing).toContain("active formal SDD work keeps its approved scope, Spec, plan row, ownership, and lifecycle");
    expect(delegation).toContain("If a subagent reports `blocked`");
    expect(delegation).toContain("ask the user for guidance before relaunching");
    expect(lifecycle).toContain("Both routes follow the project Git/worktree rules");
    expect(lifecycle).toContain("short is not an exception");
    expect(lifecycle).toContain("rules explicitly permit a trivial direct-main change, keep that exception");
    expect(retries).toContain("Both routes cap a failing task or criterion at three attempts");
    expect(retries).toContain("After the third failure, stop retrying");
  });

  it("activa documentación por necesidad y la consolida en cada checkpoint afectado", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const rule = sectionBetween(entry, "## Documentation when needed", "## Decision before delegation");
    const workflow = readStandardWorkflowReference();
    const specialDelegations = sectionBetween(workflow, "### Special delegations", "### Verification cadence");
    const ship = sectionBetween(workflow, "## 7. SHIP", "## 8. CLOSE");

    expect(rule).toMatch(/audience.+affected surfaces.+explanation of use, contract or operation.+existing claim incorrect/is);
    expect(rule).toMatch(/concrete reader or operational need.+internal refactor.+already-correct description.+does not require new prose/is);
    expect(rule).toMatch(/docs-maintainer.+outside the review panel/i);
    expect(rule).toMatch(/implementation and fixes are stable.+before ready.+checkpoint/i);
    expect(rule).toMatch(/Later contract changes reopen only affected pages.+contractual correction.+reassessing review coverage/is);
    expect(specialDelegations).toContain("[Documentation when needed](../SKILL.md#documentation-when-needed)");
    expect(specialDelegations).toMatch(/stable implementation.+not one dispatch per edit.+new review-panel member/i);
    expect(ship).toMatch(/necessary documentation under the common rule.+consolidated final diff.+required documentation missing/is);
  });

  it("no convierte contadores de ficheros ni delegación en condiciones del routing", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const routing = sectionBetween(entry, "## Routing", "## Shared guards");
    const standardWorkflow = readStandardWorkflowReference();

    for (const content of [entry, standardWorkflow]) {
      expect(content).not.toContain("Reading 4+ files");
      expect(content).not.toContain("touches ≤ 3 files");
      expect(content).not.toContain("Your priority is to delegate");
      expect(content).not.toContain("delegating stops being optional");
    }
    expect(routing).toContain("Do not use file counts");
    expect(routing).toContain("delegation mechanics as routing rules");
    expect(routing).toContain("The primary may implement or execute");
    expect(routing).toContain("handoff or delegation adds no value");
  });

  it("centraliza el handoff ready verificado y conserva sus límites en CLOSE", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const readyHandoff = sectionBetween(entry, "### Ready handoff", "## Closing rule");
    const close = sectionBetween(readStandardWorkflowReference(), "## 8. CLOSE", "## Task rule");

    expect(readyHandoff).toMatch(/verified ready checkpoint[\s\S]{0,200}URL\/number, candidate SHA, checks and relevant base\/dependencies/i);
    expect(readyHandoff).toMatch(/concrete changes and result[\s\S]{0,100}not merely the file list/i);
    expect(readyHandoff).toMatch(/what worked[\s\S]{0,120}material friction, retries or remaining limitation actually observed/i);
    expect(readyHandoff).toMatch(/do not invent[\s\S]{0,100}savings or problems/i);
    expect(readyHandoff).toMatch(/do not launch another agent or investigation just to write the summary/i);
    expect(readyHandoff).toMatch(/not merged, deployed or the end of a multi-PR roadmap/i);
    expect(readyHandoff).toMatch(/strict final JSON[\s\S]{0,120}existing keys\/types/i);
    expect(readyHandoff).toMatch(/changes and factual workflow feedback in `summary`[\s\S]{0,180}limitations in `risks`[\s\S]{0,120}pending actions in `next_steps`/i);
    expect(readyHandoff).toMatch(/Do not add keys, a `ready` status value, Markdown fences or prose outside that final JSON/i);
    expect(close).toContain("[Ready handoff](../SKILL.md#ready-handoff)");
    expect(close).toMatch(/Do not claim merge, deployment or overall roadmap completion from ready/i);
  });

  it("continúa tras ready sin ampliar la autorización de merge ni la capacidad de Goal Mode", () => {
    const entry = fs.readFileSync(path.join(stackDir, "skills", "orchestrator", "SKILL.md"), "utf8");
    const continuationRule = sectionBetween(entry, "### Continue after a ready checkpoint", "## Closing rule");
    const close = sectionBetween(readStandardWorkflowReference(), "## 8. CLOSE", "## Task rule");
    const continuation = fs.readFileSync(
      path.join(stackDir, "skills", "work-lifecycle", "references", "pr-continuation.md"),
      "utf8",
    );

    expect(close).toMatch(/continue approved safe work.+real blocker\/end of scope/is);
    expect(close).not.toContain("STOP here and hand control back to the user");
    expect(continuationRule).toMatch(
      /For multi-PR work or a dependency on an unmerged PR, read \[PR continuation\]\(\.\.\/work-lifecycle\/references\/pr-continuation\.md\)[\s\S]{0,180}if unavailable, report that boundary/i,
    );
    expect(continuation).toMatch(
      /Keep ready parents immutable[\s\S]{0,750}same head SHA does not prove[\s\S]{0,350}return it to draft/is,
    );
    expect(continuation).toMatch(
      /Merge only on an explicit user order[\s\S]{0,350}Plan approval[\s\S]{0,250}never authorizes future merges/is,
    );
    expect(continuation).toMatch(
      /Current capability limit:[\s\S]{0,300}Goal Mode[\s\S]{0,350}waiting_for_merge[\s\S]{0,300}Do not bypass/is,
    );
  });

  it("carga work-audit en modo PRE durante PLAN y en modo POST durante VERIFY", () => {
    const content = readStandardWorkflowReference();
    const planSection = sectionBetween(content, "## 4. PLAN", "## 5. EXECUTE");
    const verifySection = sectionBetween(content, "## 6. VERIFY", "## 7. SHIP");

    expect(planSection).toContain("Load and run the `work-audit` skill in **PRE** mode");
    expect(planSection).toContain("exact active `work/{name}` path");
    expect(verifySection).toContain("Load and run the `work-audit` skill in **POST** mode");
    expect(verifySection).toContain("exact active `work/{name}` path");
    expect(verifySection).toContain("checkpoint scope");
    expect(planSection).toMatch(/change-first/i);

    const preIndex = content.indexOf("Load and run the `work-audit` skill in **PRE** mode");
    const executeIndex = content.indexOf("## 5. EXECUTE");
    const postIndex = content.indexOf("Load and run the `work-audit` skill in **POST** mode");
    const markIndex = content.indexOf("mark the success criteria complete");
    expect(preIndex).toBeGreaterThanOrEqual(0);
    expect(executeIndex).toBeGreaterThan(preIndex);
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(markIndex).toBeGreaterThan(postIndex);
  });

  it("repite PRE cuando la revisión humana cambia artefactos aprobables", () => {
    const content = readStandardWorkflowReference();

    expect(content).toMatch(/human review[\s\S]{0,220}(?:changes|modifies)[\s\S]{0,220}rerun PRE/i);
  });

  it("ordena change-first antes de EXECUTE para cambios intencionales materiales de contrato", () => {
    const content = readStandardWorkflowReference();

    expect(content).toMatch(/change-first[\s\S]{0,120}intentional material contract changes?/i);
    expect(content).toMatch(/discovered in EXECUTE or VERIFY[\s\S]{0,160}return to SPEC before further implementation/i);
    expect(content).toMatch(/not bugfixes[\s\S]{0,120}restore the approved contract/i);
    expect(content).toMatch(
      /Update the PRD first[\s\S]{0,220}plan[\s\S]{0,220}task specs[\s\S]{0,220}SC-\*[\s\S]{0,220}testing decisions?[\s\S]{0,220}PRE[\s\S]{0,220}clean[\s\S]{0,220}human approval[\s\S]{0,220}delta[\s\S]{0,220}resume EXECUTE[\s\S]{0,220}repeat VERIFY/i,
    );
  });
});

describe.each(RUNTIMES)("%s orchestrator ownership", (_runtime, adapter) => {
  let tempRoot = "";

  afterEach(() => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  function plan(mode: "human" | "programmatic") {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-orchestrator-source-"));
    const ctx = makeContext(adapter, path.join(tempRoot, adapter.id), mode);
    return { ctx, actions: buildPlan(adapter, ctx) };
  }

  it.each(["human", "programmatic"] as const)("proyecta F1 y la aplicabilidad F2-A en el payload %s", (mode) => {
    const { ctx, actions } = plan(mode);
    const runtimePaths = adapter.paths(ctx.configDir);
    const prompt = plannedContent(actions, runtimePaths.systemPromptFile);
    const systemPrompt = sectionBetween(prompt, "<!-- jorgex:system-prompt -->", "<!-- /jorgex:system-prompt -->");
    const workState = sectionBetween(systemPrompt, "## Work State", "## Security");

    expect(workState).toMatch(/formal task[^\n]{0,100}one[^\n]{0,100}spec/i);
    expect(workState).toContain("work/{name}/task/{NN}");
    expect(workState).toContain("work/{name}/tasks/{NN}.md");
    expect(workState).toMatch(/identity\/access/i);
    expect(workState).toMatch(/auxiliary microassignments[^\n]{0,80}parent task/i);
    expect(workState).toMatch(/independent[^\n]{0,100}persist[^\n]{0,100}before continuing/i);
    expect(systemPrompt.includes("<!-- jorgex:programmatic-mode -->")).toBe(mode === "programmatic");

    expect(workState).toContain("single source of this flow for formal SDD work");
    expect(workState).toContain("canonical `orchestrator` routing decides whether work is short or standard");
    expect(workState).toContain("a standalone short route does not create PRD, plan, formal Specs, PRE, or POST");
    expect(workState).toContain("a short step inside active formal SDD work preserves its approved tracking and ownership");

    const git = sectionBetween(systemPrompt, "## Git", "## Terminal");
    expect(git).toMatch(/revalidate review coverage.+not automatically relaunching every reviewer/is);
    expect(git).toMatch(/effective base and integration context even when head is unchanged/i);
    expect(git).toMatch(
      /verified base appropriate to its dependencies[\s\S]{0,280}updated production[\s\S]{0,240}permitted stable parent candidate[\s\S]{0,420}Ready does not by itself stop approved safe work[\s\S]{0,180}runtime capabilities[\s\S]{0,180}Parents ready remain immutable[\s\S]{0,180}explicit user approval/i,
    );

    const lifecyclePayload = plannedContent(actions, path.join(runtimePaths.skillsDir, "work-lifecycle", "SKILL.md"));
    const applicability = sectionBetween(lifecyclePayload, "# Work Lifecycle", "## Identity");
    expect(applicability).toContain("canonical routing in the `orchestrator` skill selects **formal SDD** work");
    expect(applicability).toContain("A short standalone change stays outside this lifecycle");
    expect(applicability).toContain("does not create PRD, plan, formal task specs, PRE, or POST");
    expect(applicability).toContain("A bounded short step inside active formal SDD work preserves");
    expect(applicability).toContain("its approved Spec, plan row, ownership, and tracking");
    expect(applicability).toContain("Routing criteria live only in `orchestrator`");
    expect(applicability).toContain("do not copy them here");

    const lifecycle = sectionBetween(lifecyclePayload, "## Pull request lifecycle", "## HTML review view");
    expect(lifecycle).toMatch(/repeat preflight and review revalidation/i);
    expect(lifecycle).toMatch(/\[coverage revalidation\]\(\.\.\/xreview\/SKILL\.md#7-revalidate-coverage-and-stop\).+not an automatic repeated panel/is);
    expect(lifecycle).toMatch(/integration assumptions, including the effective base/i);

    const protocolPayload = adapter.id === "opencode"
      ? plannedContent(actions, path.join(runtimePaths.pluginsDir!, "engram.ts"))
      : sectionBetween(prompt, "<!-- jorgex:engram-protocol -->", "<!-- /jorgex:engram-protocol -->");
    expect(protocolPayload).toMatch(/Spec as read-only/i);
    expect(protocolPayload).toMatch(/separate outcome topic_key/i);
    expect(protocolPayload).toMatch(/Never[^\n]{0,180}mem_save[^\n]{0,180}mem_update[^\n]{0,180}Spec observation/i);
    expect(protocolPayload).toMatch(/no separate outcome destination[^\n]{0,120}return the result to the coordinator/i);
  });

  it.each(["human", "programmatic"] as const)("proyecta íntegro el contrato de análisis F2-B en el payload %s", (mode) => {
    const { ctx, actions } = plan(mode);

    for (const name of ["backend-analyst", "frontend-analyst"]) {
      const agent = loadCanonicalAgents(path.join(stackDir, "agents")).find((candidate) => candidate.name === name);
      expect(agent, `falta el agente canónico ${name}`).toBeDefined();
      const outputFormat = sectionBetween(agent!.body, "## Output format", "## Result contract").trim();

      expect(plannedAgentContent(actions, adapter, ctx, name)).toContain(outputFormat);
    }
  });

  it.each(["human", "programmatic"] as const)("proyecta el contrato F4 de docs-maintainer en el payload %s", (mode) => {
    const { ctx, actions } = plan(mode);
    const docsMaintainer = loadCanonicalAgents(path.join(stackDir, "agents")).find(
      (candidate) => candidate.name === "docs-maintainer",
    );
    expect(docsMaintainer, "falta el agente canónico docs-maintainer").toBeDefined();

    const scopeAndEvidence = [
      sectionBetween(docsMaintainer!.body, "## Targets", "## Before editing"),
      sectionBetween(docsMaintainer!.body, "## Factual accuracy", "## While editing"),
      sectionBetween(docsMaintainer!.body, "## Rules", "## Checklist"),
    ];
    const payload = plannedAgentContent(actions, adapter, ctx, "docs-maintainer");

    for (const contract of scopeAndEvidence) expect(payload).toContain(contract);
  });

  it("planSkills instala exactamente una entrada canónica", () => {
    const { ctx, actions } = plan("human");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "orchestrator", "SKILL.md");

    expect(actions.filter((action) => action.target === skillTarget)).toHaveLength(1);
    expect(plannedContent(actions, skillTarget)).toContain("references/standard-workflow.md");
  });

  it.each(["human", "programmatic"] as const)("proyecta las skills F2-B byte a byte en %s", (mode) => {
    const { ctx, actions } = plan(mode);
    const skillsDir = adapter.paths(ctx.configDir).skillsDir;
    const sources = [
      { relative: ["orchestrator", "SKILL.md"], source: path.join(stackDir, "skills", "orchestrator", "SKILL.md") },
      { relative: ["orchestrator", "references", "standard-workflow.md"], source: standardWorkflowReferencePath() },
      { relative: ["work-lifecycle", "SKILL.md"], source: path.join(stackDir, "skills", "work-lifecycle", "SKILL.md") },
      { relative: ["work-lifecycle", "references", "plan-template.md"], source: path.join(stackDir, "skills", "work-lifecycle", "references", "plan-template.md") },
      { relative: ["work-lifecycle", "references", "pr-continuation.md"], source: path.join(stackDir, "skills", "work-lifecycle", "references", "pr-continuation.md") },
      { relative: ["xreview", "SKILL.md"], source: path.join(stackDir, "skills", "xreview", "SKILL.md") },
    ];

    for (const { relative, source } of sources) {
      const target = path.join(skillsDir, ...relative);
      expect(actions.filter((action) => action.target === target)).toHaveLength(1);
      expect(plannedContent(actions, target)).toBe(fs.readFileSync(source, "utf8"));
    }
  });

  it("planSkills proyecta work-audit exactamente una vez desde el canon", () => {
    const canonicalSkill = path.join(stackDir, "skills", "work-audit", "SKILL.md");
    expect(fs.existsSync(canonicalSkill), "falta el canon stack/skills/work-audit/SKILL.md").toBe(true);
    if (!fs.existsSync(canonicalSkill)) return;

    const { ctx, actions } = plan("human");
    const skillTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "work-audit", "SKILL.md");

    expect(actions.filter((action) => action.target === skillTarget)).toHaveLength(1);
    expect(plannedContent(actions, skillTarget)).toBe(fs.readFileSync(canonicalSkill, "utf8"));
  });
});
