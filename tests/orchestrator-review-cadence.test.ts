import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../stack/skills/orchestrator/SKILL.md", import.meta.url)),
  "utf8",
);
const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
const briefing = readFileSync(
  fileURLToPath(new URL("../AGENTS.md", import.meta.url)),
  "utf8",
);

const sectionBetween = (content: string, start: string, end: string) => {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
};

describe("orchestrator review cadence", () => {
  it("uses deterministic checks as the routine execution feedback loop", () => {
    expect(body).toMatch(/deterministic checks.+routine feedback loop/is);
    expect(body).toMatch(/tests.+lint.+typecheck/is);
    expect(body).toMatch(
      /do not launch.+code-reviewer.+code-simplifier.+test-analyzer.+silent-failure-hunter.+merely because a writer finished/is,
    );
    expect(body).toMatch(/test task completed/i);
    expect(body).toMatch(
      /normal handoffs between `implementer` and `tester` do not by themselves justify reviewers or analyzers/i,
    );
  });

  it("allows at most one early review for a concrete high-risk section", () => {
    expect(body).toMatch(/early review.+exception/is);
    expect(body).toMatch(/concrete risk.+deterministic checks cannot cover/is);
    expect(body).toMatch(/at most one early review per bounded critical section/is);
    expect(body).toMatch(/use the single most relevant specialist/i);
    expect(body).toMatch(
      /do not load the `xreview` skill or run a generic multi-agent panel during EXECUTE/i,
    );
    expect(body).toMatch(
      /file count, writer completion, commit, push, or draft PR creation are not early-review triggers/i,
    );
  });

  it("revalida la cobertura aplicable al devolver un draft standard desde ready", () => {
    const reference = readFileSync(
      fileURLToPath(new URL("../stack/skills/orchestrator/references/standard-workflow.md", import.meta.url)),
      "utf8",
    );
    const draftCadence = sectionBetween(reference, "### Draft PR cadence", "### Handoff rule");

    expect(draftCadence).toContain("gh pr ready --undo <number>");
    expect(draftCadence).toMatch(/repeat VERIFY and the applicable review revalidation from the common coverage rule/i);
    expect(draftCadence).not.toContain("repeat VERIFY and the final review before readying it again");
  });

  it("carga xreview para cobertura final que falta y conserva el scope del candidato", () => {
    const finalReview = sectionBetween(body, "### Final review and PR lifecycle", "## Closing rule");

    expect(finalReview).toContain("final candidate SHA while the PR is still draft");
    expect(finalReview).toContain("immediately before `gh pr ready`");
    expect(finalReview).toMatch(/xreview.+scoped review adds value and reliable coverage is missing/is);
    expect(finalReview).toMatch(/Freeze base\/head and merge-base.+primary responsibility.+necessary support/is);
    expect(finalReview).toMatch(/fix-check.+delta-review.+full review/is);
    expect(finalReview).toMatch(/material change.+not automatically rerunning the same panel/is);
    expect(finalReview).toMatch(/Previously clean roles reopen.+dependencies or assumptions change/is);
    expect(finalReview).toMatch(/base or integration context even when head is unchanged/is);
  });

  it("does not retain the mechanical review triggers", () => {
    expect(body).not.toContain("Touching 2+ non-trivial files");
    expect(body).not.toContain("Commit, push or PR after code changes");
    expect(body).not.toMatch(/fresh `code-reviewer` pass before closing/i);
  });

  it("SHIP standard remite a la revisión común y revalida sólo la cobertura afectada", () => {
    const reference = readFileSync(
      fileURLToPath(new URL("../stack/skills/orchestrator/references/standard-workflow.md", import.meta.url)),
      "utf8",
    );
    const ship = sectionBetween(reference, "## 7. SHIP", "## 8. CLOSE");
    const reviewStep = sectionBetween(ship, "2. ", "3. ");

    expect(reviewStep, "SHIP debe aplicar la política común de la entrada").toContain("SKILL.md");
    expect(reviewStep).toMatch(/Final review and PR lifecycle/i);
    expect(reviewStep).not.toMatch(/^2\. Load and run the portable `xreview` skill/m);
    expect(ship, "una revisión ya completada debe conservar su evidencia").toMatch(/(?:retain|reuse|preserve)[^\n.]*\b(?:prior|existing|previous|completed)\b[^\n.]*\b(?:review|evidence)\b/i);
    expect(ship).toMatch(/fix-check, delta-review or full review.+affected contracts and evidence.+not another full panel by default/is);
    expect(ship).toMatch(/Preserve justified clean coverage.+reopen it when dependencies or assumptions change/is);
    expect(ship).toMatch(/Do not backlog rejected findings or discard valid findings merely because they are new/is);
    expect(ship).toMatch(/recheck the effective base and integration context as well/i);
  });

  it("mantiene Git y la cadencia de review como guardas compartidas por short y standard", () => {
    const sharedGuards = sectionBetween(body, "## Shared guards", "## Work state");

    expect(sharedGuards).toContain("Both routes preserve");
    expect(sharedGuards).toContain("Git/worktree discipline");
    expect(sharedGuards).toContain("final-draft review");
    expect(sharedGuards).toContain("configured gates");
    expect(sharedGuards).toContain("explicit user approval for merge");
  });

  it("documents the operational cadence in the repository briefing", () => {
    expect(briefing).toMatch(/Cadencia de review del orquestador/);
    expect(briefing).toMatch(/no dispara reviewers/);
    expect(briefing).toMatch(/una vez por PR/);
  });
});
