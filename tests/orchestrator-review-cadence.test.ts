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

  it("keeps the multi-agent review on the final draft SHA before ready", () => {
    expect(body).toMatch(/one multi-agent review per PR/i);
    expect(body).toMatch(/load and run the portable `xreview` skill/i);
    expect(body).toMatch(/while the PR is still draft/i);
    expect(body).toMatch(/before `gh pr ready`/i);
    expect(body).toMatch(/re-run.+only if.+materially different risk/is);
  });

  it("does not retain the mechanical review triggers", () => {
    expect(body).not.toContain("Touching 2+ non-trivial files");
    expect(body).not.toContain("Commit, push or PR after code changes");
    expect(body).not.toMatch(/fresh `code-reviewer` pass before closing/i);
  });

  it("documents the operational cadence in the repository briefing", () => {
    expect(briefing).toMatch(/Cadencia de review del orquestador/);
    expect(briefing).toMatch(/no dispara reviewers/);
    expect(briefing).toMatch(/una vez por PR/);
  });
});
