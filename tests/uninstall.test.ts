import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeMarkdownSection, removeTomlSection, upsertMarkdownSection, upsertTomlSection } from "../src/lib/filemerge.js";
import { removeNativeHooks, upsertNativeHooks } from "../src/lib/hooks-format.js";
import { loadCanonicalAgents, type CanonicalHooks } from "../src/lib/canonical.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

describe("removeMarkdownSection", () => {
  it("install → uninstall deja el contenido del usuario intacto", () => {
    const user = "# Mis notas\n\nContenido propio.\n";
    let doc = upsertMarkdownSection(user, "system-prompt", "PROMPT DEL STACK");
    doc = upsertMarkdownSection(doc, "engram-protocol", "PROTOCOLO");
    let out = removeMarkdownSection(doc, "system-prompt");
    out = removeMarkdownSection(out, "engram-protocol");
    expect(out).toContain("Contenido propio.");
    expect(out).not.toContain("PROMPT DEL STACK");
    expect(out).not.toContain("jorgex:");
  });

  it("devuelve vacío si el archivo solo contenía nuestras secciones", () => {
    const doc = upsertMarkdownSection(null, "system-prompt", "X");
    expect(removeMarkdownSection(doc, "system-prompt")).toBe("");
  });

  it("no-op si la sección no existe", () => {
    expect(removeMarkdownSection("# Doc\n", "nope")).toBe("# Doc\n");
  });
});

describe("removeTomlSection", () => {
  it("install → uninstall preserva la config del usuario", () => {
    const user = '# mi config\nmodel = "gpt-5.4"\n\n[mcp_servers.propio]\ncommand = "x"\n';
    let doc = upsertTomlSection(user, "mcp_servers.engram", 'command = "engram"');
    doc = upsertTomlSection(doc, "mcp_servers.context7", 'url = "u"');
    let out = removeTomlSection(doc, "mcp_servers.engram");
    out = removeTomlSection(out, "mcp_servers.context7");
    expect(out).toContain("# mi config");
    expect(out).toContain("[mcp_servers.propio]");
    expect(out).not.toContain("engram");
    expect(out).not.toContain("context7");
  });
});

describe("removeNativeHooks", () => {
  const CANONICAL: CanonicalHooks = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: 'node "{{SCRIPTS_DIR}}/post-pr-review.cjs"', timeout: 30 }],
        },
      ],
    },
  };

  it("quita solo nuestras entradas y limpia claves vacías", () => {
    const withUserHook = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "echo user" }] },
        ],
      },
      model: "opus",
    });
    const installed = upsertNativeHooks(withUserHook, CANONICAL, "C:/x/scripts");
    const removed = removeNativeHooks(installed, CANONICAL)!;
    const parsed = JSON.parse(removed);
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Write");
  });

  it("elimina la clave hooks si queda vacía", () => {
    const installed = upsertNativeHooks(null, CANONICAL, "C:/x/scripts");
    const removed = removeNativeHooks(installed, CANONICAL)!;
    expect(JSON.parse(removed)).toEqual({});
  });
});

describe("paridad entre adapters (los 15 agentes canónicos reales)", () => {
  const agents = loadCanonicalAgents(path.join(stackRoot(), "agents"));

  it("hay 15 agentes canónicos (1 primary + 14 subagentes)", () => {
    expect(agents).toHaveLength(15);
    expect(agents.filter((a) => a.mode === "primary")).toHaveLength(1);
  });

  it.each([
    ["opencode", opencodeAdapter],
    ["claude-code", claudeCodeAdapter],
    ["codex", codexAdapter],
  ] as const)("%s renderiza todos los agentes con el body íntegro", (id, adapter) => {
    const models = DEFAULT_MODEL_MAP[id]!;
    for (const agent of agents) {
      const rendered = adapter.renderAgent(agent, models);
      expect(rendered.length).toBeGreaterThan(0);
      // El contenido canónico viaja a todos los runtimes (test de paridad).
      const marker = agent.body.trim().split("\n")[0]!;
      for (const artifact of rendered) {
        expect(artifact.content).toContain(marker.replace(/^#+\s*/, ""));
      }
    }
  });

  it("el orchestrator nunca es un subagente: agent solo en opencode, modo principal en el resto", () => {
    const orchestrator = agents.find((a) => a.mode === "primary")!;
    const oc = opencodeAdapter.renderAgent(orchestrator, DEFAULT_MODEL_MAP.opencode);
    expect(oc.map((o) => o.kind)).toEqual(["agent"]);
    const cc = claudeCodeAdapter.renderAgent(orchestrator, DEFAULT_MODEL_MAP["claude-code"]);
    expect(cc.map((o) => o.kind).sort()).toEqual(["output-style", "skill"]);
    const cx = codexAdapter.renderAgent(orchestrator, DEFAULT_MODEL_MAP.codex);
    expect(cx.map((o) => o.kind).sort()).toEqual(["profile", "skill"]);
  });
});
