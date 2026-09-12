import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { piAdapter } from "../src/adapters/pi.js";
import type { FileAction, InstallContext, SharedProjectionAdapter } from "../src/adapters/types.js";
import { planSystemPrompt } from "../src/components/system-prompt.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { readWritingStyle, resolveWritingStyleFile } from "../src/lib/writing-style.js";

type WritingStyleSnapshot = {
  sourcePath: string;
  content: string | null;
};

type WritingStyleContext = {
  writingStyle?: WritingStyleSnapshot;
};

const SYNTHETIC_STYLE = [
  "Escribe con frases conectadas y explica el porqué cuando ayude a decidir.",
  "Mantén un tono directo y humano; respeta siempre el formato técnico solicitado.",
].join("\n");

const RUNTIMES: [string, SharedProjectionAdapter][] = [
  ["Claude Code", claudeCodeAdapter],
  ["Codex", codexAdapter],
  ["OpenCode", opencodeAdapter],
];

const ALL_RUNTIMES: [string, SharedProjectionAdapter][] = [
  ...RUNTIMES,
  ["Pi", piAdapter],
];

const tempRoots: string[] = [];

function tempRoot(prefix = "jx-writing-style-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function context(
  adapter: SharedProjectionAdapter,
  configDir: string,
  mode: "human" | "programmatic" = "human",
  writingStyle?: WritingStyleSnapshot,
): InstallContext {
  return {
    stackDir: stackRoot(),
    configDir,
    mode,
    subagentConcurrency: mode === "programmatic" ? "serial" : undefined,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.codex,
    warnings: [],
    ...(writingStyle === undefined ? {} : { writingStyle }),
  } as InstallContext & WritingStyleContext;
}

function plannedPrompt(adapter: SharedProjectionAdapter, ctx: InstallContext): string {
  const [action] = planSystemPrompt(adapter, ctx);
  expect(action?.kind).toBe("write");
  if (action?.kind !== "write") throw new Error(`No se planificó el prompt de ${adapter.id}`);
  return action.content;
}

function styleSection(content: string): string | null {
  return /<!-- jorgex:writing-style -->\n([\s\S]*?)\n<!-- \/jorgex:writing-style -->/.exec(content)?.[1] ?? null;
}

function managedPromptAction(adapter: SharedProjectionAdapter, content: string, configDir: string): FileAction {
  const prompt = adapter.paths(configDir).systemPromptFile;
  fs.mkdirSync(path.dirname(prompt), { recursive: true });
  fs.writeFileSync(prompt, content);
  const actions = "planUnmerge" in adapter
    ? (adapter as typeof claudeCodeAdapter).planUnmerge(
        { servers: {} },
        { hooks: {} },
        context(adapter, configDir, "human"),
      )
    : [];
  const action = actions.find((candidate) => candidate.target === prompt);
  expect(action, `No se planificó la retirada de ${prompt}`).toBeDefined();
  if (action === undefined) throw new Error(`No se planificó la retirada de ${prompt}`);
  return action;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lector de estilo global", () => {
  it("trata fuente ausente y archivo vacío como desactivados sin inventar contenido", () => {
    const root = tempRoot();
    const source = path.join(root, "writing-style.md");

    expect(readWritingStyle(source)).toEqual({ sourcePath: source, content: null });

    fs.writeFileSync(source, " \r\n\t\n");
    expect(readWritingStyle(source)).toEqual({ sourcePath: source, content: null });
  });

  it("lee el texto válido completo, normaliza CRLF y conserva el contenido interior", () => {
    const root = tempRoot();
    const source = path.join(root, "writing-style.md");
    fs.writeFileSync(source, `\r\n  ${SYNTHETIC_STYLE.replaceAll("\n", "\r\n")}  \r\n`);

    expect(readWritingStyle(source)).toEqual({
      sourcePath: source,
      content: SYNTHETIC_STYLE,
    });
  });

  it.each([
    ["un archivo de directorio", (root: string) => root, /archivo|file|directorio|directory/i],
    ["UTF-8 inválido", (root: string) => path.join(root, "invalid.md"), /utf.?8|codific/i],
    ["marcadores gestionados", (root: string) => path.join(root, "managed.md"), /jorgex:|marcador|marker/i],
  ] as const)("rechaza %s con un error antes de aceptar la fuente", (_name, fileForCase, errorPattern) => {
    const root = tempRoot();
    const source = fileForCase(root);
    if (source !== root) {
      const bytes = source.endsWith("invalid.md")
        ? Buffer.from([0xc3, 0x28])
        : Buffer.from("<!-- jorgex:system-prompt -->\ncontenido\n<!-- /jorgex:system-prompt -->\n", "utf8");
      fs.writeFileSync(source, bytes);
    }

    expect(() => readWritingStyle(source)).toThrow(errorPattern);
  });

  it("resuelve la fuente de target-dir dentro del destino y permite probarla sin consultar el estado real", () => {
    const root = tempRoot();
    const stateDir = path.join(root, "real-state");
    const targetDir = path.join(root, "target");
    const realSource = path.join(stateDir, "writing-style.md");
    const targetSource = path.join(targetDir, "writing-style.md");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(realSource, "ESTILO REAL QUE NO DEBE LEERSE\n");
    fs.writeFileSync(targetSource, SYNTHETIC_STYLE);

    expect(resolveWritingStyleFile({ stateDir, targetDir })).toBe(targetSource);
    expect(readWritingStyle(targetSource, { rootDir: targetDir })).toEqual({
      sourcePath: targetSource,
      content: SYNTHETIC_STYLE,
    });
    expect(readWritingStyle(realSource, { rootDir: stateDir }).content).toContain("ESTILO REAL");
  });

  it("rechaza una fuente de target-dir que sigue un enlace fuera del destino", (ctx) => {
    const root = tempRoot();
    const targetDir = path.join(root, "target");
    const outsideDir = path.join(root, "outside");
    const source = path.join(targetDir, "writing-style.md");
    const outside = path.join(outsideDir, "writing-style.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outside, SYNTHETIC_STYLE);
    try {
      fs.symlinkSync(outside, source);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
        ctx.skip();
        return;
      }
      throw error;
    }

    expect(() => readWritingStyle(source, { rootDir: targetDir })).toThrow(/destino|scope|outside|fuera|symlink|enlace/i);
  });
});

describe("proyección de estilo en el prompt compartido", () => {
  it.each(ALL_RUNTIMES)("añade exactamente un bloque aditivo en %s y conserva las instrucciones ajenas", (_name, adapter) => {
    const root = tempRoot();
    const configDir = path.join(root, adapter.id);
    const promptFile = adapter.paths(configDir).systemPromptFile;
    const userPrompt = "# Instrucción del usuario\n\nConserva esta regla.\n";
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, userPrompt);

    const content = plannedPrompt(adapter, context(adapter, configDir, "human", {
      sourcePath: path.join(root, "writing-style.md"),
      content: SYNTHETIC_STYLE,
    }));
    const section = styleSection(content);

    expect(content).toContain("Conserva esta regla.");
    expect(content).toContain("<!-- jorgex:system-prompt -->");
    expect(section).toContain(SYNTHETIC_STYLE);
    expect(section).toMatch(/prosa|estilo|formato|encargo/i);
    expect(content.match(/<!-- jorgex:writing-style -->/g)).toHaveLength(1);
    expect(content.match(/<!-- \/jorgex:writing-style -->/g)).toHaveLength(1);

    fs.writeFileSync(promptFile, content);
    const second = plannedPrompt(adapter, context(adapter, configDir, "human", {
      sourcePath: path.join(root, "writing-style.md"),
      content: SYNTHETIC_STYLE,
    }));
    expect(second).toBe(content);
  });

  it("actualiza la sección, retira el contenido obsoleto y deja un solo bloque", () => {
    const root = tempRoot();
    const configDir = path.join(root, "codex");
    const promptFile = codexAdapter.paths(configDir).systemPromptFile;
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    const first = plannedPrompt(codexAdapter, context(codexAdapter, configDir, "human", {
      sourcePath: path.join(root, "writing-style.md"),
      content: "Primera versión sintética.",
    }));
    fs.writeFileSync(promptFile, first);

    const updated = plannedPrompt(codexAdapter, context(codexAdapter, configDir, "human", {
      sourcePath: path.join(root, "writing-style.md"),
      content: "Segunda versión sintética.",
    }));
    expect(updated).toContain("Segunda versión sintética.");
    expect(updated).not.toContain("Primera versión sintética.");
    expect(updated.match(/<!-- jorgex:writing-style -->/g)).toHaveLength(1);

    fs.writeFileSync(promptFile, updated);
    const disabled = plannedPrompt(codexAdapter, context(codexAdapter, configDir, "human", {
      sourcePath: path.join(root, "writing-style.md"),
      content: null,
    }));
    expect(styleSection(disabled)).toBeNull();
    expect(disabled).toContain("<!-- jorgex:system-prompt -->");
  });

  it.each(ALL_RUNTIMES)("no proyecta el estilo en modo programmatic y conserva su contrato de salida en %s", (_name, adapter) => {
    const root = tempRoot();
    const configDir = path.join(root, adapter.id);
    const content = plannedPrompt(adapter, context(adapter, configDir, "programmatic", {
      sourcePath: path.join(root, "writing-style.md"),
      content: SYNTHETIC_STYLE,
    }));

    expect(styleSection(content)).toBeNull();
    expect(content).toContain("PROGRAMMATIC MODE");
    expect(content).toContain("strict JSON object");
  });

  it.each(RUNTIMES)("uninstall retira solo la sección de estilo en %s y preserva contenido ajeno", (_name, adapter) => {
    const root = tempRoot();
    const configDir = path.join(root, adapter.id);
    const promptFile = adapter.paths(configDir).systemPromptFile;
    const seeded = [
      "# Instrucción ajena",
      "",
      "Conserva esta línea.",
      "",
      "<!-- jorgex:writing-style -->",
      "Estilo gestionado sintético.",
      "<!-- /jorgex:writing-style -->",
      "",
      "<!-- jorgex:system-prompt -->",
      "Sistema gestionado.",
      "<!-- /jorgex:system-prompt -->",
      "",
    ].join("\n");
    const action = managedPromptAction(adapter, seeded, configDir);
    expect(action.kind).toBe("write");
    if (action.kind !== "write") throw new Error("La retirada esperaba una acción de escritura");

    expect(styleSection(action.content)).toBeNull();
    expect(action.content).toContain("Conserva esta línea.");
    expect(action.content).not.toContain("Sistema gestionado.");
  });
});
