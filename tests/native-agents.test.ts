import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { planAgents } from "../src/components/agents.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { piAdapter } from "../src/adapters/pi.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { loadCanonicalAgents, parseCanonicalAgent } from "../src/lib/canonical.js";
import { TEST_MODEL_MAP as DEFAULT_MODEL_MAP } from "./fixtures/model-map.js";

const agents = () => loadCanonicalAgents(path.resolve("stack/agents"));

describe("native six-agent canon", () => {
  it("loads six roles without tiers and rejects policies that would widen reader permissions", () => {
    expect(agents().map((agent) => agent.name).sort()).toEqual([
      "analyst", "generalist", "implementer", "reviewer", "security-auditor", "simplifier",
    ]);
    expect(() => parseCanonicalAgent("---\nname: unsafe\ndescription: unsafe\nmode: subagent\nreadonly: true\nbash: full\nspawn: false\n---\n", "unsafe.md")).toThrow();
  });

  it("inherits models and denies shell/edit/spawn for readers in Claude and OpenCode", () => {
    for (const agent of agents()) {
      const claude = claudeCodeAdapter.renderAgent(agent, DEFAULT_MODEL_MAP["claude-code"])[0]!.content;
      const opencode = opencodeAdapter.renderAgent(agent, DEFAULT_MODEL_MAP.opencode)[0]!.content;
      expect(claude).not.toMatch(/^model:/m);
      expect(opencode).not.toMatch(/^model:/m);
      expect(opencode).toContain('"action":"subagent","resource":"*","effect":"deny"');
      if (agent.readonly) {
        expect(claude).toContain("tools: Read, Grep, Glob, Skill");
        expect(claude).not.toContain("Bash");
        expect(opencode).toContain('"action":"shell","resource":"*","effect":"deny"');
        expect(opencode).toContain('"action":"edit","resource":"*","effect":"deny"');
      } else {
        expect(claude).toContain("disallowedTools: Agent");
      }
    }
  });

  it("uses native Pi tool allowlists instead of inheriting the writable builtin reviewer", () => {
    for (const agent of agents()) {
      const content = piAdapter.renderAgent(agent, DEFAULT_MODEL_MAP.codex)[0]!.content;
      expect(content).toContain("allowedAgents:\nallowNestedSubagents: false");
      expect(content).not.toMatch(/^(model|thinking):/m);
      if (agent.readonly) expect(content).toContain("tools: read, grep, find, ls\n");
      else expect(content).toContain("tools: read, grep, find, ls, bash, edit, write\n");
    }
  });

  it("renders an explicitly selected per-agent model, safely quoted", () => {
    const agent = agents().find((agent) => agent.name === "implementer")!;
    const models = { ...DEFAULT_MODEL_MAP.opencode, overrides: { implementer: { model: "user/model", variant: "high" } } };
    expect(opencodeAdapter.renderAgent(agent, models)[0]!.content).toContain('model: "user/model#high"');
  });
  it("quotes a selected model without injecting frontmatter", () => {
    const agent = agents().find((agent) => agent.name === "implementer")!;
    const model = 'user/model"\nmode: primary\n---';
    const variant = "high\npermissions: allow";
    const models = { ...DEFAULT_MODEL_MAP.opencode, overrides: { implementer: { model, variant } } };
    const content = opencodeAdapter.renderAgent(agent, models)[0]!.content;
    expect(content.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(content).toContain(`model: ${JSON.stringify(`${model}#${variant}`)}`);
    expect(content).not.toMatch(/^mode: primary/m);
  });

  it("Codex inherits the session sandbox rather than advertising per-role enforcement", () => {
    for (const agent of agents()) {
      const content = codexAdapter.renderAgent(agent, DEFAULT_MODEL_MAP.codex)[0]!.content;
      expect(content).not.toMatch(/^(model|model_reasoning_effort|sandbox_mode) =/m);
      expect(content).toContain(agent.body);
    }
  });

  it("plans six native bodies without an overlay", () => {
    const context = {
      stackDir: path.resolve("stack"), configDir: "/synthetic/pi-agent", engramBin: null,
      models: DEFAULT_MODEL_MAP.codex, warnings: [],
    };
    const normal = planAgents(piAdapter, context);
    expect(normal).toHaveLength(6);
    for (const action of normal) {
      expect(action.kind).toBe("write");
      if (action.kind === "write") expect(action.content).not.toContain("<!-- jorgex:programmatic-mode -->");
    }
  });

});
