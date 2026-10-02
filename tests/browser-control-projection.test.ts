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

/**
 * Campo en validación por T10: el tipo del contexto aún no lo declara porque el
 * RED precede al writer. La intersección mantiene el typecheck verde durante el
 * RED y sigue siendo válida cuando T11 lo añada a `InstallContext`.
 */
type BrowserControlContext = InstallContext & {
  browserControlInvocation?: { command: string; args: readonly string[] };
};

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
