import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { DESTRUCTIVE_GIT_DENY } from "../src/lib/git-guard.js";
import type { CanonicalAgent } from "../src/lib/canonical.js";
import type { RuntimeModelMap } from "../src/lib/model-map.js";

const MODELS: RuntimeModelMap = {
  strong: { model: "fable" },
  standard: { model: "sonnet" },
  cheap: { model: "haiku" },
};

function agent(overrides: Partial<CanonicalAgent>): CanonicalAgent {
  return {
    name: "demo",
    description: "Demo agent",
    mode: "subagent",
    tier: "standard",
    readonly: false,
    bash: "full",
    spawn: true,
    body: "\n# Demo\n\nBody.\n",
    ...overrides,
  };
}

describe("opencodeAdapter.renderAgent: barrera de git destructivo", () => {
  it("full-bash: '*' allow primero y luego los deny (última regla gana en OpenCode)", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ bash: "full" }), MODELS);
    const content = out!.content;
    expect(content).toContain('"*": allow');
    for (const pattern of DESTRUCTIVE_GIT_DENY) {
      expect(content).toContain(`"${pattern}": deny`);
    }
    // El catch-all debe ir ANTES que el primer deny (orden = precedencia).
    expect(content.indexOf('"*": allow')).toBeLessThan(content.indexOf(`"${DESTRUCTIVE_GIT_DENY[0]}": deny`));
  });

  it("git-read no cambia: solo git diff/log allow, sin barrera destructiva", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "git-read" }), MODELS);
    expect(out!.content).toContain('"git diff*": allow');
    expect(out!.content).toContain('"git log*": allow');
    expect(out!.content).not.toContain('"git reset*": deny');
  });

  it("none: bash denegado por completo", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ readonly: true, bash: "none" }), MODELS);
    expect(out!.content).toContain("bash: deny");
    expect(out!.content).not.toContain('"git reset*": deny');
  });

  it("primary no fija permisos (usa los defaults globales)", () => {
    const [out] = opencodeAdapter.renderAgent(agent({ name: "orchestrator", mode: "primary" }), MODELS);
    expect(out!.content).not.toContain("permission:");
    expect(out!.content).not.toContain('"git reset*": deny');
  });
});
