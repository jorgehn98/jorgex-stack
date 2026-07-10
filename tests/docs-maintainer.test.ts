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
});
