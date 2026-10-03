import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
  runBoundedProcess,
  type BoundedProcessResult,
  type CliResult,
} from "./helpers/bounded-process.js";
import { prepareRepoBuildRun, removeTemporaryRoots } from "./helpers/pnpm-tooling.js";
import { activateManagedBrowserTree } from "../src/lib/browser-managed.js";
import { browserTreeSha256 } from "../src/lib/browser-stage.js";

/**
 * Ejecución `browser control` — despacho al runtime gestionado verificado.
 *
 * Contrato: el subcomando `jorgex-stack browser control <args>` debe reenviar
 * EXACTAMENTE los argumentos del proveedor (flags documentados del CLI Browser
 * Control incluidos) al runtime activo verificado mediante
 * `planManagedBrowserInvocation(stateDir, "@opencode-ai/browser-control", args)`.
 * No debe inventar un `mcp`, no debe resolver por PATH, no debe caer a un
 * candidato y no debe adquirir nada.
 *
 * Seam black-box: se compila el CLI real una vez y se ejecuta con el bounded
 * runner sobre HOME/XDG/target privados. El runtime gestionado se siembra con
 * la API pública real (`activateManagedBrowserTree` + `browserTreeSha256`): el
 * bin del paquete testigo es un script que SOLO imprime `JSON(argv)`; no hay
 * relay ni Chrome. El SRI y el árbol del testigo son sintéticos: acreditan el
 * contrato de Stack, no el paquete oficial publicado.
 *
 * RED: hoy `browser` solo acepta `playwright` y rechaza `control` con el uso
 * de Playwright, sin ejecutar el proveedor; la aserción positiva falla por
 * comportamiento ausente, no por setup inválido.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");
const CLI_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 60_000;
const PNPM_VERSION_CHECK_TIMEOUT_MS = 10_000;

const BC_PACKAGE = "@opencode-ai/browser-control" as const;
const BC_SERVER = "browser-control";
const BC_VERSION = "9.9.30";
const BC_TARBALL_URL =
  `https://registry.npmjs.org/${BC_PACKAGE}/-/browser-control-${BC_VERSION}.tgz`;

/** Cuerpo sintético del entry testigo; solo imprime argv. */
const BC_ENTRY_SOURCE =
  'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n';

/**
 * Flags documentados del CLI Browser Control. `--help` no debe interpretarse
 * como ayuda global de Stack y las comillas del código deben sobrevivir.
 */
const PROVIDER_ARGS = [
  "execute",
  "--session",
  "docs",
  "--json",
  "--file",
  "script.js",
  "--help",
  "return page.getByText('Continue').click()",
] as const;

const temporaryRoots: string[] = [];
let releaseBuildRootsCleanup: (() => void) | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildDist(): Promise<void> {
  // Owned-resource owner armed before the first root is created.
  releaseBuildRootsCleanup = registerOwnedResourceCleanup("browser-control-cli-dispatch-roots", () =>
    removeTemporaryRoots(temporaryRoots),
  );
  const prepared = await prepareRepoBuildRun({
    repoRoot: REPO_ROOT,
    env: process.env,
    runProcess: runBoundedProcess,
    versionCheckTimeoutMs: PNPM_VERSION_CHECK_TIMEOUT_MS,
    registerTempRoot: (root) => temporaryRoots.push(root),
  });
  let result: BoundedProcessResult;
  try {
    result = await runBoundedProcess(prepared.invocation, {
      cwd: REPO_ROOT,
      env: prepared.env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`pnpm build failed to start: ${errorMessage(error)}`);
  }

  if (result.error === undefined && !result.timedOut && result.status === 0) return;

  const details = [
    result.timedOut ? `timeout after ${BUILD_TIMEOUT_MS}ms` : undefined,
    result.error?.message,
    result.status === null ? undefined : `exit status: ${result.status}`,
    result.signal === null ? undefined : `signal: ${result.signal}`,
    result.stdout,
    result.stderr,
  ].filter((value): value is string => value !== undefined && value !== "");
  throw new Error(`pnpm build failed${details.length === 0 ? "" : `:\n${details.join("\n")}`}`);
}

type Layout = {
  root: string;
  cwd: string;
  home: string;
  xdgConfigHome: string;
  temp: string;
  bin: string;
  /** Raíz que el CLI resuelve como `dataDir()` con este HOME privado. */
  stateDir: string;
};

function createLayout(): Layout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-browser-control-cli-"));
  temporaryRoots.push(root);
  const home = path.join(root, "home");
  const layout: Layout = {
    root,
    cwd: path.join(root, "cwd"),
    home,
    xdgConfigHome: path.join(root, "xdg-config"),
    temp: path.join(root, "tmp"),
    bin: path.join(root, "bin"),
    stateDir: path.join(home, ".jorgex-stack"),
  };
  for (const directory of [
    layout.cwd,
    layout.home,
    layout.xdgConfigHome,
    layout.temp,
    layout.bin,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return layout;
}

function isolatedEnvironment(layout: Layout): Record<string, string> {
  return {
    HOME: layout.home,
    USERPROFILE: layout.home,
    XDG_CONFIG_HOME: layout.xdgConfigHome,
    TMPDIR: layout.temp,
    TMP: layout.temp,
    TEMP: layout.temp,
    // Un `browser-control` ajeno en PATH nunca es fallback: el marcador lo delata.
    PATH: `${layout.bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

/** Paquete testigo: bin `browser-control` que solo imprime argv. */
function writeBrowserControlWitness(root: string): {
  stageDir: string;
  nodeModulesPath: string;
  treePath: string;
  entryPath: string;
} {
  const stageDir = path.join(root, "witness-stage");
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treePath = path.join(nodeModulesPath, "@opencode-ai", "browser-control");
  const entryPath = path.join(treePath, "dist", "cli.js");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(treePath, "package.json"),
    `${JSON.stringify(
      {
        name: BC_PACKAGE,
        version: BC_VERSION,
        type: "module",
        bin: { [BC_SERVER]: "dist/cli.js" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, BC_ENTRY_SOURCE);
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

/**
 * Siembra el runtime activo con la API pública real, bajo el `dataDir()` que el
 * CLI hijo resuelve con su HOME privado.
 */
async function seedActiveRuntime(layout: Layout): Promise<{ entryPath: string; launcherPath: string }> {
  const witness = writeBrowserControlWitness(layout.root);
  const rootBytes = Buffer.from(BC_ENTRY_SOURCE, "utf8");
  const integrity = `sha512-${createHash("sha512").update(rootBytes).digest("base64")}`;
  const receipt = await activateManagedBrowserTree({
    stateDir: layout.stateDir,
    packageName: BC_PACKAGE,
    release: { version: BC_VERSION, tarballUrl: BC_TARBALL_URL, integrity },
    staged: {
      treePath: witness.treePath,
      nodeModulesPath: witness.nodeModulesPath,
      treeSha256: browserTreeSha256(witness.nodeModulesPath, witness.stageDir),
      closure: [{ name: BC_PACKAGE, version: BC_VERSION, integrity }],
    },
    entryPath: witness.entryPath,
  });
  return { entryPath: receipt.entryPath, launcherPath: receipt.launcherPath };
}

async function runCli(layout: Layout, args: string[]): Promise<CliResult> {
  const result = await runBoundedProcess(
    { command: process.execPath, args: [CLI_PATH, ...args] },
    { cwd: layout.cwd, env: isolatedEnvironment(layout), timeoutMs: CLI_TIMEOUT_MS },
  );
  if (result.error !== undefined) {
    const details = [result.error.message, result.stdout, result.stderr]
      .filter((value) => value !== "")
      .join("\n");
    throw new Error(`CLI failed to start${details === "" ? "" : `:\n${details}`}`);
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  cleanupOwnedResourcesOrThrow();
});

afterAll(() => {
  cleanupOwnedResourcesOrThrow();
  releaseBuildRootsCleanup?.();
  releaseBuildRootsCleanup = undefined;
});

describe("browser control dispatch to the verified managed runtime [RED]", () => {
  beforeAll(async () => {
    await buildDist();
  }, 120_000);

  it("reenvía exactamente los args del proveedor al runtime activo verificado", async () => {
    const layout = createLayout();
    await seedActiveRuntime(layout);

    const result = await runCli(layout, ["browser", "control", ...PROVIDER_ARGS]);
    const diagnostic = `${result.stdout}\n${result.stderr}`;

    expect(result.signal).toBeNull();
    expect(result.status, `esperado despacho exitoso; salida:\n${diagnostic}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([...PROVIDER_ARGS]);
  });

  it("falla cerrado sin runtime activo, sin fallback por PATH y sin adquirir", async () => {
    const layout = createLayout();
    // Un `browser-control` global/ajeno en PATH debe permanecer sin ejecutarse.
    const marker = path.join(layout.root, "path-fallback.marker");
    fs.writeFileSync(
      path.join(layout.bin, BC_SERVER),
      `#!/bin/sh\nprintf 'PATH_FALLBACK_RAN\\n' > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );

    const result = await runCli(layout, ["browser", "control", ...PROVIDER_ARGS]);
    const diagnostic = `${result.stdout}\n${result.stderr}`;

    expect(result.status, `esperado fallo cerrado; salida:\n${diagnostic}`).not.toBe(0);
    expect(result.signal).toBeNull();
    // El subcomando debe reconocerse: el diagnóstico no puede ser el uso Playwright.
    expect(diagnostic).not.toMatch(/Uso: jorgex-stack browser playwright/i);
    // El proveedor nunca corre y no se adquiere ni se cae a PATH/candidato.
    expect(result.stdout).not.toContain(PROVIDER_ARGS[0]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(layout.stateDir, ".browser-managed"))).toBe(false);
  });

  it("bloquea un runtime manipulado antes de que corra el proveedor", async () => {
    const layout = createLayout();
    const seeded = await seedActiveRuntime(layout);
    fs.appendFileSync(seeded.entryPath, "\n// manipulado tras la activación\n");

    const result = await runCli(layout, ["browser", "control", ...PROVIDER_ARGS]);
    const diagnostic = `${result.stdout}\n${result.stderr}`;

    expect(result.status, `esperado bloqueo por drift; salida:\n${diagnostic}`).not.toBe(0);
    expect(result.signal).toBeNull();
    // El guard bloquea antes de importar el entry: nunca imprime argv.
    expect(result.stdout.trim()).not.toBe(JSON.stringify([...PROVIDER_ARGS]));
    expect(diagnostic).not.toMatch(/Uso: jorgex-stack browser playwright/i);
  });
});
