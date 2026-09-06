import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCanonicalAgent } from "../src/lib/canonical.js";

const source = readFileSync(
  fileURLToPath(new URL("../stack/agents/docs-maintainer.md", import.meta.url)),
  "utf8",
);
const agent = parseCanonicalAgent(source, "docs-maintainer.md");

describe("docs-maintainer canonical contract", () => {
  it("keeps the current cheap tier and relies on factual guardrails", () => {
    expect(agent.tier).toBe("cheap");
  });

  it("requires location and source-to-claim verification before reporting success", () => {
    expect(agent.body).toMatch(/allowed write root/i);
    expect(agent.body).toContain("git rev-parse --show-toplevel");
    expect(agent.body).toMatch(/source-to-claim/i);
    expect(agent.body).toMatch(/never invent/i);
    expect(agent.body).toMatch(/names?.+paths?.+symbols?.+chronology.+snippets?/is);
    expect(agent.body).toMatch(/review the final documentation diff/i);
    expect(agent.body).toMatch(/partial.+blocked/is);
  });

  it("limits discovery to affected docs and treats plans as intent rather than evidence", () => {
    expect(agent.description).toMatch(/changed use, contracts or operations need explanation/i);
    expect(agent.description).toMatch(/not product logic or documentation for every edit/i);
    expect(agent.body).toMatch(/affected surfaces.+necessary references/i);
    expect(agent.body).toMatch(/when relevant to the change/i);
    expect(agent.body).toMatch(/reuse an existing.+source-to-claim.+when still valid/i);
    expect(agent.body).toMatch(/plan states intent, not proof of implemented or published behavior/i);
    expect(agent.body).toMatch(/consolidated pass.+reopen affected pages.+without restarting all documentation work/i);
  });
});
