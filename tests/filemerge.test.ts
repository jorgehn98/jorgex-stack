import { describe, expect, it } from "vitest";
import { stripLeadingHtmlComments, upsertJson, upsertMarkdownSection } from "../src/lib/filemerge.js";
import { parseCanonicalAgent } from "../src/lib/canonical.js";

describe("upsertMarkdownSection", () => {
  it("crea el bloque cuando el archivo no existe", () => {
    const out = upsertMarkdownSection(null, "demo", "hola");
    expect(out).toBe("<!-- jorgex:demo -->\nhola\n<!-- /jorgex:demo -->\n");
  });

  it("añade la sección al final preservando el contenido del usuario", () => {
    const out = upsertMarkdownSection("# Mis notas\n", "demo", "hola");
    expect(out.startsWith("# Mis notas\n")).toBe(true);
    expect(out).toContain("<!-- jorgex:demo -->\nhola\n<!-- /jorgex:demo -->");
  });

  it("reemplaza solo el interior de la sección existente", () => {
    const v1 = upsertMarkdownSection("# Arriba\n", "demo", "version 1");
    const withUserEdit = v1 + "\n# Abajo (del usuario)\n";
    const v2 = upsertMarkdownSection(withUserEdit, "demo", "version 2");
    expect(v2).toContain("version 2");
    expect(v2).not.toContain("version 1");
    expect(v2).toContain("# Arriba");
    expect(v2).toContain("# Abajo (del usuario)");
  });

  it("es idempotente: re-aplicar no cambia nada", () => {
    const once = upsertMarkdownSection("# Doc\n", "demo", "contenido");
    const twice = upsertMarkdownSection(once, "demo", "contenido");
    expect(twice).toBe(once);
  });

  it("gestiona varias secciones sin pisarse", () => {
    let doc = upsertMarkdownSection(null, "a", "AAA");
    doc = upsertMarkdownSection(doc, "b", "BBB");
    const updated = upsertMarkdownSection(doc, "a", "AAA2");
    expect(updated).toContain("AAA2");
    expect(updated).toContain("BBB");
    expect(updated).not.toContain("AAA\n");
  });
});

describe("upsertJson", () => {
  it("crea el objeto desde cero", () => {
    const out = upsertJson(null, (root) => {
      root["mcp"] = { engram: { type: "local" } };
    });
    expect(JSON.parse(out)).toEqual({ mcp: { engram: { type: "local" } } });
  });

  it("preserva claves ajenas y solo toca las gestionadas", () => {
    const existing = JSON.stringify({ theme: "dark", mcp: { propio: { url: "x" } } });
    const out = upsertJson(existing, (root) => {
      const mcp = root["mcp"] as Record<string, unknown>;
      mcp["engram"] = { type: "local" };
    });
    const parsed = JSON.parse(out);
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcp.propio).toEqual({ url: "x" });
    expect(parsed.mcp.engram).toEqual({ type: "local" });
  });

  it("es idempotente", () => {
    const mutate = (root: Record<string, unknown>): void => {
      root["x"] = 1;
    };
    const once = upsertJson(null, mutate);
    const twice = upsertJson(once, mutate);
    expect(twice).toBe(once);
  });
});

describe("stripLeadingHtmlComments", () => {
  it("quita los comentarios meta iniciales y conserva el resto", () => {
    const md = "<!-- nota interna -->\n\n# Título\n\n<!-- comentario en medio -->\n";
    const out = stripLeadingHtmlComments(md);
    expect(out.startsWith("# Título")).toBe(true);
    expect(out).toContain("<!-- comentario en medio -->");
  });
});

describe("parseCanonicalAgent", () => {
  const SRC = `---
name: demo-agent
description: Does demo things. Not for: production.
mode: subagent
tier: strong
readonly: true
bash: git-read
spawn: false
---

# Demo

Body text.
`;

  it("parsea el frontmatter canónico completo", () => {
    const agent = parseCanonicalAgent(SRC, "demo.md");
    expect(agent.name).toBe("demo-agent");
    expect(agent.description).toContain("Not for: production.");
    expect(agent.mode).toBe("subagent");
    expect(agent.tier).toBe("strong");
    expect(agent.readonly).toBe(true);
    expect(agent.bash).toBe("git-read");
    expect(agent.spawn).toBe(false);
    expect(agent.body).toContain("# Demo");
  });

  it("aplica defaults: bash=full, spawn=true, readonly=false", () => {
    const minimal = `---\nname: x\ndescription: d\nmode: primary\ntier: cheap\n---\nbody`;
    const agent = parseCanonicalAgent(minimal, "x.md");
    expect(agent.bash).toBe("full");
    expect(agent.spawn).toBe(true);
    expect(agent.readonly).toBe(false);
  });

  it("falla claramente si falta un campo requerido", () => {
    expect(() => parseCanonicalAgent("---\nname: x\n---\nbody", "x.md")).toThrow(/falta/);
  });
});
