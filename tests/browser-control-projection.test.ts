import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext } from "../src/adapters/types.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

/**
 * T10 RED — Browser Control obligatorio en OpenCode v2.
 *
 * Contrato (Spec T10): el contexto interno `browserControlInvocation` solo lo
 * llena el lifecycle con un launcher `active` verificado; NO autoriza un
 * PATH/global arbitrario. El adapter lo traduce a un MCP local
 * `mcp.servers['browser-control']` con `command: [command, ...args, 'mcp']`.
 * Sin invocación disponible se diagnostica Browser Control pendiente, nunca un
 * MCP roto apuntando a bytes ausentes. OpenCode v2 no expone selector Playwright
 * y los demás runtimes conservan su contrato (Context7 incluido).
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-control-"));
  tempDirs.push(dir);
  return dir;
}

const BROWSER_CONTROL_SERVER = "browser-control";

/** Launcher `active` verificado: la proyección local es `[command, ...args, "mcp"]`. */
const VERIFIED_LAUNCHER = {
  command: "/verified/browser-control/launcher",
  args: ["--relay-socket", "/run/jorgex/browser-control.sock"] as readonly string[],
};

/** Contexto del seam: `browserControlInvocation` ya forma parte de `InstallContext` (T11). */
type BrowserControlContext = InstallContext;

function baseContext(configDir: string): BrowserControlContext {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.opencode,
    warnings: [],
  };
}

/** Archivo principal efectivo por runtime (mismo contrato que las suites actuales). */
function mainConfigFile(adapter: Adapter, configDir: string): string {
  if (adapter === opencodeAdapter) return path.join(configDir, "opencode.json");
  if (adapter === codexAdapter) return path.join(configDir, "config.toml");
  return path.join(path.dirname(configDir), `${path.basename(configDir)}.json`);
}

function plannedContent(adapter: Adapter, ctx: BrowserControlContext): string {
  const target = mainConfigFile(adapter, ctx.configDir);
  const action = adapter
    .planMainConfig(loadCanonicalMcp(stackRoot()), ctx)
    .find((candidate) => candidate.kind === "write" && candidate.target === target);
  expect(action, `el plan debe escribir la config principal de ${adapter.id} en ${target}`).toBeDefined();
  return (action as { content: string }).content;
}

describe("Browser Control obligatorio en OpenCode v2 [T10-RED]", () => {
  it("proyecta mcp.servers['browser-control'] local desde la invocación verificada en config fresca", () => {
    const configDir = path.join(tempDir(), "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const ctx: BrowserControlContext = {
      ...baseContext(configDir),
      browserControlInvocation: VERIFIED_LAUNCHER,
    };

    const content = plannedContent(opencodeAdapter, ctx);
    const parsed = JSON.parse(content) as { mcp?: { servers?: Record<string, unknown> } };

    // Context7 sigue siendo obligatorio y se proyecta en el mismo plan.
    expect(parsed.mcp?.servers?.context7).toBeDefined();

    // RED: hoy el adapter ignora `browserControlInvocation`, así que OpenCode v2
    // queda sin Browser Control y esta proyección local falta.
    expect(parsed.mcp?.servers?.[BROWSER_CONTROL_SERVER]).toMatchObject({
      type: "local",
      command: [VERIFIED_LAUNCHER.command, ...VERIFIED_LAUNCHER.args, "mcp"],
    });
  });

  it("control: no filtra Browser Control a otros runtimes y conserva su Context7", () => {
    const root = tempDir();
    const cases: Array<{ adapter: Adapter; configDir: string }> = [
      { adapter: claudeCodeAdapter, configDir: path.join(root, ".claude") },
      { adapter: codexAdapter, configDir: path.join(root, "codex") },
    ];

    for (const { adapter, configDir } of cases) {
      fs.mkdirSync(configDir, { recursive: true });
      const ctx: BrowserControlContext = {
        ...baseContext(configDir),
        browserControlInvocation: VERIFIED_LAUNCHER,
      };
      const content = plannedContent(adapter, ctx);
      expect(content, `${adapter.id} conserva Context7`).toContain("context7");
      expect(content, `${adapter.id} no recibe Browser Control`).not.toContain(BROWSER_CONTROL_SERVER);
    }
  });
});

/**
 * MCP manual de Browser Control (Spec T10/T11): una entrada nativa
 * (`mcp.servers.browser-control`) o legacy (`mcp.browser-control`) equivalente a
 * la invocación gestionada se preserva sin reclamarla; una incompatible se
 * conserva en disco y produce un conflicto accionable, sin shadow y sin volcar
 * la config cruda ni secretos del usuario.
 */
const PLACEMENTS = ["native", "legacy"] as const;
type ManualPlacement = (typeof PLACEMENTS)[number];

const SECRET_SENTINEL = "SENTINEL-SECRET-SHOULD-NOT-LEAK";

function managedCommand(): string[] {
  return [VERIFIED_LAUNCHER.command, ...VERIFIED_LAUNCHER.args, "mcp"];
}

type ManualEntry = {
  type: "local";
  command: string[];
  user_marker: { source: string };
  user_secret_token: string;
};

function manualEntry(command: string[]): ManualEntry {
  return {
    type: "local",
    command,
    user_marker: { source: "manual" },
    user_secret_token: SECRET_SENTINEL,
  };
}

function manualConfig(placement: ManualPlacement, entry: ManualEntry): string {
  const document = placement === "native"
    ? { mcp: { servers: { [BROWSER_CONTROL_SERVER]: entry } } }
    : { mcp: { [BROWSER_CONTROL_SERVER]: entry } };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function seedManualConfig(
  configDir: string,
  placement: ManualPlacement,
  entry: ManualEntry,
): { file: string; raw: string } {
  fs.mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, "opencode.json");
  const raw = manualConfig(placement, entry);
  fs.writeFileSync(file, raw);
  return { file, raw };
}

function preservedManualEntry(placement: ManualPlacement, content: string): unknown {
  const parsed = JSON.parse(content) as { mcp: Record<string, unknown> };
  if (placement === "native") {
    return (parsed.mcp["servers"] as Record<string, unknown>)[BROWSER_CONTROL_SERVER];
  }
  return parsed.mcp[BROWSER_CONTROL_SERVER];
}

describe("Browser Control MCP manual nativo/legacy [T10-RED]", () => {
  it.each(PLACEMENTS)(
    "control: una entrada manual %s equivalente a la invocación gestionada se preserva con sus campos desconocidos y sin claim",
    (placement) => {
      const configDir = path.join(tempDir(), "opencode");
      const { file, raw } = seedManualConfig(configDir, placement, manualEntry(managedCommand()));
      const ctx: BrowserControlContext = {
        ...baseContext(configDir),
        browserControlInvocation: VERIFIED_LAUNCHER,
      };

      const action = opencodeAdapter
        .planMainConfig(loadCanonicalMcp(stackRoot()), ctx)
        .find((candidate) => candidate.kind === "write" && candidate.target === file);
      expect(action, "el plan escribe la config principal").toBeDefined();
      const content = (action as { content: string }).content;

      expect(preservedManualEntry(placement, content)).toMatchObject({
        type: "local",
        command: managedCommand(),
        user_marker: { source: "manual" },
        user_secret_token: SECRET_SENTINEL,
      });

      const ownership = (action as { mcpOwnership?: Array<{ server: string; owned: boolean }> }).mcpOwnership ?? [];
      expect(ownership).not.toContainEqual({ server: BROWSER_CONTROL_SERVER, owned: true });
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
    },
  );

  it.each(PLACEMENTS)(
    "conflicto: una entrada manual %s incompatible se conserva y produce diagnóstico accionable sin filtrar config ni secretos",
    (placement) => {
      const configDir = path.join(tempDir(), "opencode");
      const { file, raw } = seedManualConfig(configDir, placement, manualEntry(["/opt/custom/browser-mcp", "--legacy"]));
      const ctx: BrowserControlContext = {
        ...baseContext(configDir),
        browserControlInvocation: VERIFIED_LAUNCHER,
      };

      let caught: unknown;
      try {
        opencodeAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
      } catch (error) {
        caught = error;
      }

      // RED: hoy se preserva en silencio; falta el conflicto accionable.
      expect(caught, "un MCP manual incompatible debe producir conflicto, no un falso éxito").toBeInstanceOf(Error);
      if (!(caught instanceof Error)) return;

      const message = caught.message;
      expect(message).toMatch(/browser-control/i);
      expect(message).toMatch(/incompatible|conflicto/i);
      expect(message).toMatch(/revisa|retira|corrige/i);
      expect(message).not.toContain(SECRET_SENTINEL);

      // Ni shadow ni mutación: los bytes en disco siguen intactos.
      expect(fs.readFileSync(file, "utf8")).toBe(raw);
    },
  );
});
