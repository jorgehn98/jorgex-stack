import { describe, expect, it } from "vitest";
import {
  hasTomlRootKey,
  readTomlSection,
  removeTomlSection,
  stripLeadingHtmlComments,
  upsertJson,
  upsertMarkdownSection,
  upsertTomlSection,
} from "../src/lib/filemerge.js";
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

  it("repara un opener huérfano (closer borrado a mano) sin duplicar marcadores", () => {
    const broken = "# Notas\n\n<!-- jorgex:demo -->\ncontenido viejo\n\n# Más notas del usuario\n";
    const out = upsertMarkdownSection(broken, "demo", "contenido nuevo");
    expect(out).toContain("contenido nuevo");
    expect(out).toContain("# Más notas del usuario");
    // Exactamente un par de marcadores: el huérfano se eliminó.
    expect(out.split("<!-- jorgex:demo -->").length).toBe(2);
    expect(out.split("<!-- /jorgex:demo -->").length).toBe(2);
    // Re-aplicar sigue siendo idempotente tras la reparación.
    expect(upsertMarkdownSection(out, "demo", "contenido nuevo")).toBe(out);
  });

  it("repara un closer huérfano (opener borrado a mano)", () => {
    const broken = "contenido viejo\n<!-- /jorgex:demo -->\n# Del usuario\n";
    const out = upsertMarkdownSection(broken, "demo", "nuevo");
    expect(out).toContain("# Del usuario");
    expect(out.split("<!-- /jorgex:demo -->").length).toBe(2);
  });

  it("un opener INLINE sin closer no se traga el contenido del usuario en re-syncs", () => {
    // Escenario: el usuario dejó el marcador incrustado en una línea suya.
    const broken = "nota mía <!-- jorgex:demo -->\n\n# Sección importante del usuario\n";
    const once = upsertMarkdownSection(broken, "demo", "contenido stack");
    const twice = upsertMarkdownSection(once, "demo", "contenido stack");
    expect(twice).toBe(once);
    expect(twice).toContain("# Sección importante del usuario");
    expect(twice).toContain("nota mía");
  });
});

describe("secciones TOML: variantes de header y strings multilínea", () => {
  it("reconoce el header aunque el usuario le añada un comentario, en las tres operaciones", () => {
    const doc = '[mcp_servers.context7] # mi cuenta\nurl = "u"\nhttp_headers = { "CONTEXT7_API_KEY" = "mi-key" }\n';
    expect(readTomlSection(doc, "mcp_servers.context7")).toContain("mi-key");
    const updated = upsertTomlSection(doc, "mcp_servers.context7", 'url = "u2"');
    expect(updated).toContain("u2");
    expect(updated.split("[mcp_servers.context7]").length).toBe(2); // sin tabla duplicada
    expect(removeTomlSection(doc, "mcp_servers.context7")).toBe("");
  });

  it("no confunde una línea [x] dentro de un string multilínea con un header", () => {
    const doc = "[profiles.mio]\ninstructions = '''\n# \"\"\" y [checklist] siguen dentro del string\n[checklist]\n- item\n'''\n\n[otra]\nx = 1\n";
    // La sección del usuario llega hasta [otra]; [checklist] es texto.
    const removed = removeTomlSection(doc, "profiles.mio");
    expect(removed).not.toContain("[checklist]");
    expect(removed).toContain("[otra]");
    // Y un upsert ajeno no parte el string multilínea.
    const upserted = upsertTomlSection(doc, "mcp_servers.engram", 'command = "engram"');
    expect(upserted).toContain("[checklist]");
    expect(upserted.indexOf("[mcp_servers.engram]")).toBeGreaterThan(upserted.indexOf("[otra]"));
  });

  it("reconoce el cierre tras un # dentro de una multilínea en la misma línea", () => {
    const doc = [
      "instructions = '''",
      "[profiles.fake]",
      "root_inside = 1",
      "# el cierre está después del hash '''",
      "root_after = 2",
      "[foreign.settings]",
      'keep = "yes"',
    ].join("\n");

    expect(hasTomlRootKey(doc, "root_inside")).toBe(false);
    expect(hasTomlRootKey(doc, "root_after")).toBe(true);
    expect(readTomlSection(doc, "profiles.fake")).toBeNull();
    expect(readTomlSection(doc, "foreign.settings")).toContain('keep = "yes"');
  });

  it.each([
    { name: "literal 3/3", quote: "'", opener: 3, closer: 3 },
    { name: "literal 4/4", quote: "'", opener: 4, closer: 4 },
    { name: "literal 5/5", quote: "'", opener: 5, closer: 5 },
    { name: "basic 3/3", quote: '"', opener: 3, closer: 3 },
    { name: "basic 4/4", quote: '"', opener: 4, closer: 4 },
    { name: "basic 5/5", quote: '"', opener: 5, closer: 5 },
  ])("consume el opener y las últimas tres comillas del cierre ($name)", ({ quote, opener, closer }) => {
    const doc = [
      `value = ${quote.repeat(opener)}`,
      "[profiles.fake]",
      "contenido",
      `${quote.repeat(closer)} # comentario con ''' y \"\"\"`,
      "root_after = 1",
      "[foreign.settings]",
      'keep = "yes"',
    ].join("\n");

    expect(hasTomlRootKey(doc, "root_after")).toBe(true);
    expect(readTomlSection(doc, "profiles.fake")).toBeNull();
    expect(readTomlSection(doc, "foreign.settings")).toContain('keep = "yes"');
  });

  it("no abre una literal multilínea por comillas triples dentro de una basic string corta", () => {
    const doc = [
      "[profiles.mio]",
      String.raw`message = "texto \" ''' # sigue dentro de la string"`,
      "[foreign.settings]",
      'keep = "yes"',
    ].join("\n");

    expect(readTomlSection(doc, "foreign.settings")).toContain('keep = "yes"');
  });

  it("mantiene dentro de una basic multilínea un delimitador aparente escapado", () => {
    const doc = [
      'instructions = """',
      String.raw`escaped = \"""`,
      "[profiles.fake]",
      "contenido",
      '"""',
      "root_after = 1",
      "[foreign.settings]",
      'keep = "yes"',
    ].join("\n");

    expect(hasTomlRootKey(doc, "root_after")).toBe(true);
    expect(readTomlSection(doc, "profiles.fake")).toBeNull();
    expect(readTomlSection(doc, "foreign.settings")).toContain('keep = "yes"');
  });

  it.each([
    { name: "comentario completo con triplecomilla simple", rootLines: ["# comentario '''", "root_value = 0"] },
    { name: "comentario completo con triplecomilla doble", rootLines: ['# comentario """', "root_value = 0"] },
    { name: "comentario inline con triplecomilla simple", rootLines: ["root_value = 0 # comentario '''"] },
    { name: "comentario inline con triplecomilla doble", rootLines: ['root_value = 0 # comentario """'] },
    { name: "string básica con # y triplecomilla simple", rootLines: ['root_value = "texto # \'\'\'"'] },
    { name: "string literal con # y triplecomilla doble", rootLines: [`root_value = 'texto # """'`] },
  ])("trata $name como texto TOML, no como string multilínea", ({ rootLines }) => {
    const existing = [
      ...rootLines,
      "",
      "[mcp_servers.own]",
      'owned = "keep"',
      "",
      "[foreign.settings]",
      'foreign = "keep"',
    ].join("\n");
    const body = 'command = "new"';

    expect(hasTomlRootKey(existing, "root_value")).toBe(true);

    const once = upsertTomlSection(existing, "mcp_servers.target", body);
    expect(readTomlSection(once, "mcp_servers.target")).toBe(`${body}\n`);
    expect(once.match(/^\[mcp_servers\.target\]$/gm)).toHaveLength(1);

    const twice = upsertTomlSection(once, "mcp_servers.target", body);
    expect(twice).toBe(once);

    const removed = removeTomlSection(once, "mcp_servers.target");
    expect(removed).not.toContain("[mcp_servers.target]");
    expect(removed).toContain("[foreign.settings]");
    expect(removed).toContain('foreign = "keep"');
  });

  it("normaliza variantes válidas del mismo header ([ x ], dotted quoted)", () => {
    const doc = '[ mcp_servers."engram" ]\ncommand = "viejo"\n';
    const updated = upsertTomlSection(doc, "mcp_servers.engram", 'command = "nuevo"');
    expect(updated).toContain("nuevo");
    expect(updated).not.toContain("viejo");
    expect(updated.split("mcp_servers").length).toBe(2); // una sola tabla
  });

  it("es idempotente al añadir una sección ausente a un documento TOML CRLF", () => {
    const existing = [
      "# config del usuario",
      "root_value = 0",
      "",
      "[mcp_servers.own]",
      "key_0 = false",
      "",
      "",
      "[foreign.settings]",
      'note = ""',
      "details = '''",
      "[foreign.fake]",
      "",
      "'''",
      "",
    ].join("\r\n");
    const foreign = [
      "[foreign.settings]",
      'note = ""',
      "details = '''",
      "[foreign.fake]",
      "",
      "'''",
      "",
    ].join("\r\n");

    const once = upsertTomlSection(existing, "mcp_servers.target", "key_0 = false");
    expect(once).toContain("[mcp_servers.target]\nkey_0 = false\n");
    expect(once).toContain(foreign);

    const twice = upsertTomlSection(once, "mcp_servers.target", "key_0 = false");
    expect(twice).toBe(once);
  });

  it("preserva el EOF ajeno sin newline al reemplazar una sección", () => {
    const existing = ["# usuario", "root = 0", "", "[mcp_servers.target]", "old = 1", "[foreign.settings]", "keep = 2"].join("\r\n");
    const prefix = ["# usuario", "root = 0", "", ""].join("\r\n");
    const expected = `${prefix}[mcp_servers.target]\nnew = 3\n[foreign.settings]\r\nkeep = 2`;
    const once = upsertTomlSection(existing, "mcp_servers.target", "new = 3");
    expect(once).toBe(expected);
    expect(upsertTomlSection(once, "mcp_servers.target", "new = 3")).toBe(once);
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
