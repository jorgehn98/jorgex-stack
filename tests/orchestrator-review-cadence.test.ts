import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCanonicalAgent } from "../src/lib/canonical.js";

const source = readFileSync(
  fileURLToPath(new URL("../stack/agents/orchestrator.md", import.meta.url)),
  "utf8",
);
const agent = parseCanonicalAgent(source, "orchestrator.md");
const briefing = readFileSync(
  fileURLToPath(new URL("../AGENTS.md", import.meta.url)),
  "utf8",
);

describe("orchestrator review cadence", () => {
  it("uses deterministic checks as the routine execution feedback loop", () => {
    expect(agent.body).toMatch(/deterministic checks.+routine feedback loop/is);
    expect(agent.body).toMatch(/tests.+lint.+typecheck/is);
    expect(agent.body).toMatch(
      /do not launch.+code-reviewer.+code-simplifier.+test-analyzer.+silent-failure-hunter.+merely because a writer finished/is,
    );
  });

  it("allows at most one early review for a concrete high-risk section", () => {
    expect(agent.body).toMatch(/early review.+exception/is);
    expect(agent.body).toMatch(/concrete risk.+deterministic checks cannot cover/is);
    expect(agent.body).toMatch(/at most one early review per bounded critical section/is);
    expect(agent.body).toMatch(
      /file count, writer completion, commit, push, or PR creation are not early-review triggers/i,
    );
  });

  it("keeps the multi-agent review at the PR boundary", () => {
    expect(agent.body).toMatch(/one multi-agent review per PR/i);
    expect(agent.body).toMatch(/re-run.+only if.+materially different risk/is);
  });

  it("does not retain the mechanical review triggers", () => {
    expect(agent.body).not.toContain("Touching 2+ non-trivial files");
    expect(agent.body).not.toContain("Commit, push or PR after code changes");
    expect(agent.body).not.toMatch(/fresh `code-reviewer` pass before closing/i);
  });

  it("documents the operational cadence in the repository briefing", () => {
    expect(briefing).toMatch(/Cadencia de review del orquestador/);
    expect(briefing).toMatch(/no dispara reviewers/);
    expect(briefing).toMatch(/una vez por PR/);
  });
});
