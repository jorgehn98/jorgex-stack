import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
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
          matcher: "Bash|PowerShell",
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

  it("upsert migra el matcher en sitio sin duplicar cuando cambia de Bash a Bash|PowerShell", () => {
    // Simula settings del usuario con la entrada vieja (matcher "Bash").
    const CANONICAL_OLD: CanonicalHooks = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: 'node "{{SCRIPTS_DIR}}/post-pr-review.cjs"', timeout: 30 }],
          },
        ],
      },
    };
    const withOld = upsertNativeHooks(null, CANONICAL_OLD, "C:/x/scripts");

    // Ahora el canónico es "Bash|PowerShell": el upsert debe REEMPLAZAR la entrada.
    const migrated = upsertNativeHooks(withOld, CANONICAL, "C:/x/scripts");
    const parsed = JSON.parse(migrated);
    const entries: Array<{ matcher?: string }> = parsed.hooks?.PostToolUse ?? [];

    // Sigue siendo UNA sola entrada (no duplicada).
    expect(entries).toHaveLength(1);
    // El matcher queda actualizado al canónico nuevo.
    expect(entries[0]!.matcher).toBe("Bash|PowerShell");
  });
});

describe("uninstall preserva Engram por defecto (D7)", () => {
  const HOOKS = { hooks: {} } as CanonicalHooks;
  const MCP_SIN_ENGRAM = { servers: { context7: { transport: "http" as const, url: "https://mcp.context7.com/mcp" } } };

  it("planUnmerge de opencode con preserveEngram conserva mcp.engram y limpia registros file:// nuestros", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-engram-"));
    const pluginsDir = path.join(tmp, "plugins");
    const urls = ["engram.ts", "hooks.ts", "worktree.ts"].map((f) => pathToFileURL(path.join(pluginsDir, f)).href);
    fs.writeFileSync(
      path.join(tmp, "opencode.json"),
      JSON.stringify({
        mcp: {
          engram: { type: "local", command: ["engram", "mcp"] },
          context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
        },
        plugin: ["@usuario/su-plugin-npm", ...urls],
      }),
    );

    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: null,
      models: DEFAULT_MODEL_MAP.opencode,
      warnings: [],
      preserveEngram: true,
    };
    const actions = opencodeAdapter.planUnmerge(MCP_SIN_ENGRAM, HOOKS, ctx);
    const configAction = actions.find((a) => a.target.endsWith("opencode.json"))!;
    const result = JSON.parse((configAction as { content: string }).content);

    expect(result.mcp.engram).toBeDefined();
    expect(result.mcp.context7).toBeUndefined();
    // Los registros file:// se quitan siempre (los locales se auto-cargan del
    // dir; el ARCHIVO engram.ts lo protege preserveEngram en deleteTargets).
    expect(result.plugin).toEqual(["@usuario/su-plugin-npm"]);

    fs.rmSync(tmp, { recursive: true, force: true });
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
