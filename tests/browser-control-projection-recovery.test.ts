import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedResourcesOrThrow,
  registerOwnedResourceCleanup,
} from "./helpers/bounded-process.js";
import { writeOpenCodeBinary } from "./helpers/opencode-binary.js";
import {
  createOwnedVerificationHome,
  removeTemporaryRoots,
  resolveVerificationDiskBase,
} from "./helpers/pnpm-tooling.js";
import type { BrowserControlPreviousProjection, BrowserControlRuntimeResult } from "../src/lib/browser-control-runtime.js";
import type { ManagedBrowserReceipt } from "../src/lib/browser-managed.js";
import type { StageVerifiedBrowserTreeResult } from "../src/lib/browser-stage.js";

/**
 * RED — recuperación del caller `runInstall` ante fallos de FS DESPUÉS de
 * promover una release B verificada.
 *
 * Contrato (Spec T12/T13, cierre causal de review, líneas 48 y 27): tras
 * promover B, un fallo de backup ANTES de la primera escritura debe invocar el
 * rollback disponible y conservar A/config A/skill A/claims; un fallo DESPUÉS de
 * escrituras parciales debe preservar evidencia A autenticada para reintentar y
 * completar B, sin dejar active B/config A ni skill A sin ruta de recuperación.
 * `runInstall` es la API pública y no debe dejar una excepción sin control.
 *
 * Frontera del doble (estrecha y deliberada): el gate de adquisición/relay del
 * controlador NO se prueba aquí (lo cubre `browser-control-runtime.test.ts`).
 * Se sustituye solo `prepareBrowserControlRuntime` por un doble cuyos
 * `stateDir`/root/`previous`/`rollback` se derivan del pipeline gestionado REAL
 * (`activateManagedBrowserTree`, `loadVerifiedManagedBrowserReceipt`,
 * `planManagedBrowserInvocation`, `browserControlSkillPath`,
 * `rollbackManagedBrowserActivation`): nada de receipts fabricados ni autoridad
 * sembrada. El resto del pipeline (adapter, backup, manifest, permisos) corre
 * real.
 *
 * Cada test inyecta un único fallo EIO acotado en su frontera de FS exacta
 * (`fs.copyFileSync` de la copia de backup del config / de la copia proyectada
 * de la skill B) y restaura el spy antes del teardown.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BC_PACKAGE = "@opencode-ai/browser-control";
const BROWSER_CONTROL_SERVER = "browser-control";
const MANAGED_ROOT = ".browser-managed";

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
  },
}));

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    intro: prompts.intro,
    outro: prompts.outro,
    confirm: prompts.confirm,
    log: { ...actual.log, ...prompts.log },
  };
});

/**
 * Guardia del borde de proceso: los spies delegan en las funciones reales (el
 * gate OpenCode v2 ejecuta `--version` de verdad) y solo registran llamadas, de
 * modo que el reintento puede demostrar que no ejecutó relay/manager/navegador
 * ni un binario global. Mismo patrón que `browser-control-service.test.ts`.
 */
const childProcessSpies = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessSpies.spawn.mockImplementation(actual.spawn);
  childProcessSpies.spawnSync.mockImplementation(actual.spawnSync);
  childProcessSpies.execFile.mockImplementation(actual.execFile);
  childProcessSpies.execFileSync.mockImplementation(actual.execFileSync);
  return {
    ...actual,
    spawn: childProcessSpies.spawn,
    spawnSync: childProcessSpies.spawnSync,
    execFile: childProcessSpies.execFile,
    execFileSync: childProcessSpies.execFileSync,
  };
});

const PROCESS_DELEGATES = [
  childProcessSpies.spawn,
  childProcessSpies.spawnSync,
  childProcessSpies.execFile,
  childProcessSpies.execFileSync,
] as const;

function processCallCounts(): number[] {
  return PROCESS_DELEGATES.map((delegate) => delegate.mock.calls.length);
}

/** Argumentos string de las llamadas nuevas desde `before`, aplanados. */
function newProcessCallStrings(before: readonly number[]): string[] {
  const out: string[] = [];
  PROCESS_DELEGATES.forEach((delegate, index) => {
    for (const call of delegate.mock.calls.slice(before[index] ?? 0)) {
      for (const arg of call) {
        if (typeof arg === "string") out.push(arg);
        else if (Array.isArray(arg)) out.push(...arg.filter((item): item is string => typeof item === "string"));
      }
    }
  });
  return out;
}

afterEach(() => {
  // Los tests restauran su propio spy de FS en `finally`; aquí solo se limpia la
  // historia de llamadas sin borrar la delegación real de los spies de proceso.
  cleanupOwnedResourcesOrThrow();
  vi.doUnmock("../src/lib/browser-control-runtime.js");
  vi.clearAllMocks();
});

interface ReleaseFixture {
  readonly version: string;
  readonly rootBytes: Buffer;
  readonly skillBytes: Buffer;
  readonly integrity: string;
}

function makeRelease(version: string): ReleaseFixture {
  const rootBytes = Buffer.from(`browser-control-root-${version}\n`);
  const skillBytes = Buffer.from(
    [
      "---",
      "name: browser-control",
      `description: fixture payload ${version}, not the published skill`,
      "---",
      "",
      `# Browser Control (fixture ${version})`,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    version,
    rootBytes,
    skillBytes,
    integrity: `sha512-${createHash("sha512").update(rootBytes).digest("base64")}`,
  };
}

const RELEASE_A = makeRelease("9.9.30");
const RELEASE_B = makeRelease("9.9.31");

interface Witness {
  readonly stageDir: string;
  readonly nodeModulesPath: string;
  readonly treePath: string;
  readonly entryPath: string;
}

/** Witness de una release: árbol real en disco consumible por el activador real. */
function writeWitnessTree(root: string, release: ReleaseFixture): Witness {
  const stageDir = path.join(root, `witness-${release.version}`);
  const nodeModulesPath = path.join(stageDir, "node_modules");
  const treePath = path.join(nodeModulesPath, "@opencode-ai", "browser-control");
  const entryPath = path.join(treePath, "dist", "cli.js");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(treePath, "package.json"),
    `${JSON.stringify(
      {
        name: BC_PACKAGE,
        version: release.version,
        bin: { [BROWSER_CONTROL_SERVER]: "dist/cli.js" },
        engines: { node: ">=22.19.0" },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(entryPath, release.rootBytes);
  const skillPath = path.join(treePath, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(skillPath, release.skillBytes);
  return { stageDir, nodeModulesPath, treePath, entryPath };
}

function stagedWitness(
  witness: Witness,
  release: ReleaseFixture,
  digest: (nodeModulesPath: string, stageDir: string) => string,
): StageVerifiedBrowserTreeResult {
  return {
    treePath: witness.treePath,
    nodeModulesPath: witness.nodeModulesPath,
    treeSha256: digest(witness.nodeModulesPath, witness.stageDir),
    closure: [{ name: BC_PACKAGE, version: release.version, integrity: release.integrity }],
  };
}

/** Relay de grabación: solo registra peticiones; nunca se ejecuta un relay real. */
async function startRecordingRelay(): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ name: BC_PACKAGE, version: "0.8.3" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port, requests };
}

async function closeRelay(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

const ISOLATED_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "BROWSER_CONTROL_PORT",
  "OPENCODE_CONFIG_DIR",
] as const;

async function withIsolatedEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ISOLATED_KEYS) {
    saved.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    vi.resetModules();
    return await run();
  } finally {
    for (const key of ISOLATED_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

interface ScenarioContext {
  readonly stateDir: string;
  readonly configPath: string;
  readonly skillTarget: string;
  /** Prefijo físico del namespace managed del active operativo. */
  readonly managedPrefix: string;
  readonly target: { value: "A" | "B" };
  readonly releaseA: ReleaseFixture;
  readonly releaseB: ReleaseFixture;
  readonly relayRequests: string[];
  runInstall(): Promise<number>;
}

async function withScenario(body: (ctx: ScenarioContext) => Promise<void>): Promise<void> {
  const ownedRoots: string[] = [];
  const releaseRoots = registerOwnedResourceCleanup("browser-control-projection-recovery-roots", () =>
    removeTemporaryRoots(ownedRoots),
  );
  let relay: Server | undefined;
  try {
    const base = resolveVerificationDiskBase({
      repoRoot: REPO_ROOT,
      env: { ...process.env, JORGEX_VERIFICATION_DISK_ROOT: "/var/tmp" },
    });
    const owned = createOwnedVerificationHome({
      base,
      prefix: ".jorgex-bc-projection-recovery-",
      register: (root) => ownedRoots.push(root),
    });
    const recording = await startRecordingRelay();
    relay = recording.server;

    await withIsolatedEnv(
      { ...process.env, ...owned.env, BROWSER_CONTROL_PORT: String(recording.port) },
      async () => {
        const witnessA = writeWitnessTree(owned.root, RELEASE_A);
        const witnessB = writeWitnessTree(owned.root, RELEASE_B);
        const opencodeBin = writeOpenCodeBinary(path.join(owned.root, "bin"), {
          output: "opencode v2.0.20",
        });
        const configDir = path.join(owned.env.XDG_CONFIG_HOME!, "opencode");
        const configPath = path.join(configDir, "opencode.json");
        const skillTarget = path.join(configDir, "skills", BROWSER_CONTROL_SERVER, "SKILL.md");
        const target: { value: "A" | "B" } = { value: "A" };

        const stage = await import("../src/lib/browser-stage.js");
        const stagedA = stagedWitness(witnessA, RELEASE_A, stage.browserTreeSha256);
        const stagedB = stagedWitness(witnessB, RELEASE_B, stage.browserTreeSha256);

        vi.doMock("../src/lib/browser-control-runtime.js", async () => {
          const actual = await vi.importActual<typeof import("../src/lib/browser-control-runtime.js")>(
            "../src/lib/browser-control-runtime.js",
          );
          const managed = await vi.importActual<typeof import("../src/lib/browser-managed.js")>(
            "../src/lib/browser-managed.js",
          );
          const readyFrom = (
            stateDir: string,
            receipt: ManagedBrowserReceipt,
            previous?: BrowserControlPreviousProjection,
            rollback?: () => Promise<void>,
          ): BrowserControlRuntimeResult => ({
            kind: "ready",
            version: receipt.version,
            invocation: managed.planManagedBrowserInvocation(stateDir, BC_PACKAGE, ["mcp"]),
            skillSource: actual.browserControlSkillPath(receipt),
            ...(previous === undefined ? {} : { previous }),
            ...(rollback === undefined ? {} : { rollback }),
          });
          const prepare = async (options: { stateDir: string }): Promise<BrowserControlRuntimeResult> => {
            const stateDir = options.stateDir;
            const active = managed.loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE);
            const wanted = target.value === "B"
              ? { witness: witnessB, staged: stagedB, release: RELEASE_B }
              : { witness: witnessA, staged: stagedA, release: RELEASE_A };
            // Reuse idempotente del active que ya coincide: sin previous ni
            // rollback, igual que la rama de reutilización del controlador real.
            if (
              active !== null &&
              active.version === wanted.release.version &&
              active.integrity === wanted.release.integrity
            ) {
              return readyFrom(stateDir, active);
            }
            let previous: BrowserControlPreviousProjection | undefined;
            if (active !== null) {
              previous = {
                version: active.version,
                invocation: managed.planManagedBrowserInvocation(stateDir, BC_PACKAGE, ["mcp"]),
                skillSource: actual.browserControlSkillPath(active),
              };
            }
            const promoted = await managed.activateManagedBrowserTree({
              stateDir,
              packageName: BC_PACKAGE,
              release: {
                version: wanted.release.version,
                tarballUrl: `https://registry.npmjs.org/${BC_PACKAGE}/-/${wanted.release.version}.tgz`,
                integrity: wanted.release.integrity,
              },
              staged: wanted.staged,
              entryPath: wanted.witness.entryPath,
            });
            return readyFrom(stateDir, promoted, previous, async () => {
              await managed.rollbackManagedBrowserActivation(stateDir, BC_PACKAGE, promoted, active);
            });
          };
          return { ...actual, prepareBrowserControlRuntime: prepare };
        });

        const install = await import("../src/install.js");
        const { dataDir } = await import("../src/lib/paths.js");
        const opencode = install.ADAPTERS.opencode!;
        const originalDetect = opencode.detect;
        opencode.detect = () => ({
          id: "opencode",
          name: "OpenCode",
          installed: true,
          binPath: opencodeBin,
          configDir,
        });
        try {
          const stateDir = dataDir();
          await body({
            stateDir,
            configPath,
            skillTarget,
            managedPrefix: path.join(stateDir, MANAGED_ROOT, BROWSER_CONTROL_SERVER),
            target,
            releaseA: RELEASE_A,
            releaseB: RELEASE_B,
            relayRequests: recording.requests,
            runInstall: () =>
              install.runInstall({
                runtimes: ["opencode"],
                command: "install",
                dryRun: false,
                yes: true,
                mode: { mode: "human", subagentConcurrency: "serial" },
                engramBin: null,
              }),
          });
        } finally {
          opencode.detect = originalDetect;
        }
      },
    );
  } finally {
    await closeRelay(relay);
    cleanupOwnedResourcesOrThrow();
    releaseRoots();
  }
}

function eio(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "EIO";
  return error;
}

async function loadActive(stateDir: string): Promise<ManagedBrowserReceipt | null> {
  const { loadVerifiedManagedBrowserReceipt } = await import("../src/lib/browser-managed.js");
  return loadVerifiedManagedBrowserReceipt(stateDir, BC_PACKAGE);
}

function readConfig(configPath: string): {
  mcp?: { servers?: Record<string, Record<string, unknown>> };
  [key: string]: unknown;
} {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcp?: { servers?: Record<string, Record<string, unknown>> };
    [key: string]: unknown;
  };
}

describe.skipIf(process.platform !== "linux")(
  "[T12-RED] install caller recovery after Browser Control B promotion",
  () => {
    /**
     * Fallo de BACKUP antes de la primera escritura. El backup del config
     * (`createBackup`, copia `fs.copyFileSync(configPath, stored)`) falla con
     * EIO después de que el controlador ya promovió B. Hoy `createBackup` no
     * está guardado: la excepción escapa y deja active B/config A sin rollback.
     * El contrato exige fallo controlado, active A restaurado, A/config/skill/
     * claims byte-consistentes y reintento seguro.
     */
    it("restaura el active A y no escapa sin control cuando falla el backup antes de la primera escritura", async () => {
      await withScenario(async (ctx) => {
        // 1) Install real de A: active, config, skill y claims reales.
        await ctx.runInstall();
        const activeA = await loadActive(ctx.stateDir);
        expect(activeA, "el primer install debe publicar el active A").not.toBeNull();
        expect(activeA?.version).toBe(ctx.releaseA.version);
        const configA = fs.readFileSync(ctx.configPath);
        const skillA = fs.readFileSync(ctx.skillTarget);
        expect(skillA).toEqual(ctx.releaseA.skillBytes);

        const { readManifest } = await import("../src/lib/manifest.js");
        const { devtoolsMcpPreferenceFile, loadDevtoolsMcpOwnership } = await import(
          "../src/lib/tool-preferences.js"
        );
        const ownershipA = loadDevtoolsMcpOwnership(
          devtoolsMcpPreferenceFile(),
          "opencode",
          BROWSER_CONTROL_SERVER,
        );
        expect(ownershipA, "el MCP gestionado A debe quedar reclamado").toBe(true);
        const ownedA = readManifest().runtimes.opencode?.owned ?? [];
        expect(
          ownedA.some((file) => path.resolve(file) === path.resolve(ctx.skillTarget)),
          "la skill A debe quedar owned",
        ).toBe(true);

        // 2) Nueva latest B; fallo acotado en la copia de backup del config.
        ctx.target.value = "B";
        const originalCopyFileSync = fs.copyFileSync;
        let faulted = false;
        const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(((
          source: fs.PathLike,
          destination: fs.PathLike,
          mode?: number,
        ) => {
          if (!faulted && typeof source === "string" && source === ctx.configPath) {
            faulted = true;
            throw eio("EIO: simulated backup copy failure before the first write");
          }
          return originalCopyFileSync(source, destination, mode as never);
        }) as typeof fs.copyFileSync);

        let exitCode: number | undefined;
        let thrown: unknown;
        try {
          exitCode = await ctx.runInstall();
        } catch (error) {
          thrown = error;
        } finally {
          copySpy.mockRestore();
        }

        expect(faulted, "el fallo debe ocurrir en la copia de backup del config").toBe(true);
        expect(thrown, "un fallo de backup no debe escapar como excepción no controlada").toBeUndefined();
        expect(exitCode, "el install debe reportar fallo controlado").toBe(1);

        // 3) Active A restaurado; config/skill/claims intactos.
        const restored = await loadActive(ctx.stateDir);
        expect(restored?.version, "el active debe volver a A").toBe(ctx.releaseA.version);
        expect(
          (await loadActive(ctx.stateDir))?.integrity,
          "el active restaurado debe conservar el SRI de A",
        ).toBe(ctx.releaseA.integrity);
        expect(fs.readFileSync(ctx.configPath), "el config A no debe cambiar").toEqual(configA);
        expect(fs.readFileSync(ctx.skillTarget), "la skill A no debe cambiar").toEqual(skillA);
        expect(
          loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
          "el claim del MCP gestionado debe conservarse",
        ).toBe(ownershipA);
        expect(
          (readManifest().runtimes.opencode?.owned ?? []).some(
            (file) => path.resolve(file) === path.resolve(ctx.skillTarget),
          ),
          "el ownership de la skill debe conservarse",
        ).toBe(true);

        // 4) Reintento seguro: sin fallo, completa B end-to-end.
        await ctx.runInstall();
        const activeB = await loadActive(ctx.stateDir);
        expect(activeB?.version, "el reintento debe completar B").toBe(ctx.releaseB.version);
        expect(fs.readFileSync(ctx.skillTarget), "la skill debe avanzar a B").toEqual(ctx.releaseB.skillBytes);
        const { planManagedBrowserInvocation } = await import("../src/lib/browser-managed.js");
        const plannerB = planManagedBrowserInvocation(ctx.stateDir, BC_PACKAGE, ["mcp"]);
        expect(
          readConfig(ctx.configPath).mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["command"],
          "el MCP debe re-proyectarse a la invocación B",
        ).toEqual([plannerB.command, ...plannerB.args]);
      });
    });

    /**
     * Fallo de la COPIA de la skill B DESPUÉS de que el config con el comando B
     * ya se escribió. Estado al fallo: active B, config B, skill A intacta,
     * receipts/hash/activación reales y sin autoridad sembrada. El reintento con
     * el MISMO estado verificado B debe recuperarse con evidencia A autenticada
     * o recuperación acotada de recursos propios, completando skill/MCP/
     * ownership de B y preservando config ajena. Hoy la rama de reutilización de
     * B no lleva `previousSkillSource`, así que la skill owned A se clasifica
     * como "modificada" y el reintento queda bloqueado.
     */
    it("recupera en el reintento la proyección parcial (config B escrita, skill A intacta) sin ejecutar relay/manager/browser/global", async () => {
      await withScenario(async (ctx) => {
        // 1) Install real de A y config ajena del usuario.
        await ctx.runInstall();
        const skillA = fs.readFileSync(ctx.skillTarget);
        const seed = readConfig(ctx.configPath);
        seed.mcp!.servers![BROWSER_CONTROL_SERVER]!["x-user-note"] = "keep-me";
        seed.mcp!.servers!["user-custom"] = { type: "local", command: ["/usr/bin/true"] };
        seed["user-top-level"] = { keep: true };
        fs.writeFileSync(ctx.configPath, `${JSON.stringify(seed, null, 2)}\n`);

        // 2) Nueva latest B; fallo acotado SOLO en la copia de la skill B
        //    proyectada (no en el backup del config ni en el MCP).
        const { planManagedBrowserInvocation, loadVerifiedManagedBrowserReceipt } = await import(
          "../src/lib/browser-managed.js"
        );
        ctx.target.value = "B";
        const atFault: {
          configBytes?: Buffer;
          activeVersion?: string | null;
          invocation?: ReturnType<typeof planManagedBrowserInvocation>;
        } = {};
        const originalCopyFileSync = fs.copyFileSync;
        let faulted = false;
        const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(((
          source: fs.PathLike,
          destination: fs.PathLike,
          mode?: number,
        ) => {
          if (
            !faulted &&
            typeof source === "string" &&
            typeof destination === "string" &&
            path.basename(source) === "SKILL.md" &&
            path.dirname(destination) === path.dirname(ctx.skillTarget) &&
            source.startsWith(ctx.managedPrefix)
          ) {
            faulted = true;
            // Captura el estado observable EN EL FALLO, antes de cualquier
            // recuperación: config B ya escrita y active B promovido.
            atFault.configBytes = fs.readFileSync(ctx.configPath);
            atFault.activeVersion = loadVerifiedManagedBrowserReceipt(ctx.stateDir, BC_PACKAGE)?.version ?? null;
            atFault.invocation = planManagedBrowserInvocation(ctx.stateDir, BC_PACKAGE, ["mcp"]);
            throw eio("EIO: simulated projected skill B copy failure after the config write");
          }
          return originalCopyFileSync(source, destination, mode as never);
        }) as typeof fs.copyFileSync);

        try {
          await ctx.runInstall();
        } catch {
          // El primer intento puede reportar el fallo de forma controlada o
          // lanzarlo; lo que se protege aquí es el estado y la recuperación.
        } finally {
          copySpy.mockRestore();
        }
        expect(faulted, "el fallo debe ocurrir en la copia de la skill B proyectada").toBe(true);

        // 3) Estado observado EN EL FALLO: config B YA escrita, active B y skill
        //    A intacta. El contrato no exige que B persista tras la recuperación
        //    acotada; esta restaura A para que el reintento vuelva a promover B
        //    con evidencia A auténtica.
        expect(atFault.activeVersion, "el active promovido B debe ser real al fallo").toBe(ctx.releaseB.version);
        const atFaultInvocation = atFault.invocation;
        expect(atFaultInvocation, "la invocación B real debe capturarse al fallo").toBeDefined();
        const atFaultConfig = JSON.parse((atFault.configBytes ?? Buffer.from("{}")).toString("utf8")) as {
          mcp?: { servers?: Record<string, Record<string, unknown>> };
        };
        expect(
          atFaultConfig.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["command"],
          "al fallo, el config ya debe apuntar a la invocación B",
        ).toEqual([atFaultInvocation!.command, ...atFaultInvocation!.args]);
        expect(fs.readFileSync(ctx.skillTarget), "la skill A debe seguir intacta al fallo").toEqual(skillA);
        expect(
          (await loadActive(ctx.stateDir))?.version,
          "la recuperación acotada debe restaurar el active A antes del reintento",
        ).toBe(ctx.releaseA.version);

        // 4) Reintento con el mismo estado verificado B: debe recuperarse.
        const relayBefore = ctx.relayRequests.length;
        const processBefore = processCallCounts();
        await ctx.runInstall();

        expect(
          fs.readFileSync(ctx.skillTarget),
          "el reintento debe completar la skill B byte-identical",
        ).toEqual(ctx.releaseB.skillBytes);
        const configAfter = readConfig(ctx.configPath);
        // La re-promoción usa una release nueva: la invocación B se planifica
        // contra el active final, no contra el capturado al fallo.
        const plannerB = planManagedBrowserInvocation(ctx.stateDir, BC_PACKAGE, ["mcp"]);
        expect(
          configAfter.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["command"],
          "el MCP gestionado debe quedar en la invocación B",
        ).toEqual([plannerB.command, ...plannerB.args]);
        expect(configAfter.mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["x-user-note"]).toBe("keep-me");
        expect(configAfter.mcp?.servers?.["user-custom"]).toEqual({ type: "local", command: ["/usr/bin/true"] });
        expect(configAfter["user-top-level"]).toEqual({ keep: true });

        const { devtoolsMcpPreferenceFile, loadDevtoolsMcpOwnership } = await import(
          "../src/lib/tool-preferences.js"
        );
        expect(
          loadDevtoolsMcpOwnership(devtoolsMcpPreferenceFile(), "opencode", BROWSER_CONTROL_SERVER),
          "el ownership del MCP gestionado debe quedar coherente con B",
        ).toBe(true);
        const { readManifest } = await import("../src/lib/manifest.js");
        expect(
          (readManifest().runtimes.opencode?.owned ?? []).some(
            (file) => path.resolve(file) === path.resolve(ctx.skillTarget),
          ),
          "la skill B debe quedar owned",
        ).toBe(true);

        // 5) El reintento no sondea ni ejecuta el relay/manager/global.
        expect(
          ctx.relayRequests.slice(relayBefore),
          "el reintento no debe sondear/ejecutar el relay",
        ).toEqual([]);
        const forbiddenExecutions = newProcessCallStrings(processBefore).filter((value) =>
          /browser-control|relay|systemctl|playwright|chrome/i.test(value),
        );
        expect(
          forbiddenExecutions,
          "el reintento no debe ejecutar relay/manager/navegador ni un binario global",
        ).toEqual([]);
      });
    });

    /**
     * Fix-check del riesgo introducido por la recuperación acotada: `snapshotOwnershipLedgers`
     * captura los ledgers antes de escribir y `restoreOwnershipLedgers` los
     * restaura en bloque sin comparar los bytes actuales. Una EDICIÓN AJENA
     * válida del ledger (p.ej. `enabled.codex`) que llegue entre el snapshot y la
     * recuperación se pierde al reescribir el snapshot completo. Este caso
     * reutiliza la frontera del fixture 2: el fallo EIO de la copia de la skill B
     * se usa para insertar la edición ajena DESPUÉS del snapshot y del claim
     * propio de B. Se exige preservar el valor ajeno real y mantener coherencia
     * config/active bajo la recuperación elegida, sin prescribir el mecanismo
     * (merge selectivo o recuperación reportada como incompleta).
     */
    it("preserva una edición ajena del ledger de ownership durante el fallo EIO de la copia de skill B", async () => {
      await withScenario(async (ctx) => {
        // 1) Install real de A: ledger y config reales.
        await ctx.runInstall();
        const commandA = readConfig(ctx.configPath).mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["command"];

        const { devtoolsMcpPreferenceFile, loadDevtoolsMcpPreference, saveDevtoolsMcpPreference } =
          await import("../src/lib/tool-preferences.js");
        const ledgerFile = devtoolsMcpPreferenceFile();
        // Precondición real (schema del módulo, no adivinado): la preferencia
        // ajena de codex parte desactivada.
        const foreignBefore = loadDevtoolsMcpPreference(ledgerFile, "codex");
        expect(foreignBefore, "la preferencia ajena debe partir desactivada").toBe(false);

        // 2) Run B con fallo en la copia de la skill; dentro del fallo se edita un
        //    campo ajeno válido del ledger con el shape real de tool-preferences.
        ctx.target.value = "B";
        const originalCopyFileSync = fs.copyFileSync;
        let faulted = false;
        let foreignAtFault = false;
        const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(((
          source: fs.PathLike,
          destination: fs.PathLike,
          mode?: number,
        ) => {
          if (
            !faulted &&
            typeof source === "string" &&
            typeof destination === "string" &&
            path.basename(source) === "SKILL.md" &&
            path.dirname(destination) === path.dirname(ctx.skillTarget) &&
            source.startsWith(ctx.managedPrefix)
          ) {
            faulted = true;
            // Edición ajena posterior al snapshot y al claim propio de B.
            saveDevtoolsMcpPreference(ledgerFile, "codex", true);
            foreignAtFault = loadDevtoolsMcpPreference(ledgerFile, "codex");
            throw eio("EIO: simulated projected skill B copy failure with a foreign ledger edit");
          }
          return originalCopyFileSync(source, destination, mode as never);
        }) as typeof fs.copyFileSync);

        try {
          await ctx.runInstall();
        } catch {
          // Fallo controlado o lanzado; se protege el estado observado.
        } finally {
          copySpy.mockRestore();
        }
        expect(faulted, "el fallo debe ocurrir en la copia de la skill B").toBe(true);
        expect(foreignAtFault, "la edición ajena debe existir en el punto de fallo").toBe(true);

        // 3) La edición ajena debe sobrevivir a la recuperación: nunca se
        //    sobrescribe el ledger con el snapshot previo completo.
        expect(
          loadDevtoolsMcpPreference(ledgerFile, "codex"),
          "la edición ajena del ledger no debe perderse al recuperar la proyección",
        ).toBe(true);

        // 4) Coherencia config/active bajo la recuperación acotada elegida.
        const { loadVerifiedManagedBrowserReceipt, planManagedBrowserInvocation } = await import(
          "../src/lib/browser-managed.js"
        );
        const active = loadVerifiedManagedBrowserReceipt(ctx.stateDir, BC_PACKAGE);
        expect(active, "debe existir un active gestionado coherente").not.toBeNull();
        const configCommand = readConfig(ctx.configPath).mcp?.servers?.[BROWSER_CONTROL_SERVER]?.["command"];
        if (active?.version === ctx.releaseA.version) {
          expect(configCommand, "active A exige config A").toEqual(commandA);
        } else {
          expect(active?.version, "el active debe ser A o B").toBe(ctx.releaseB.version);
          const plannerB = planManagedBrowserInvocation(ctx.stateDir, BC_PACKAGE, ["mcp"]);
          expect(configCommand, "active B exige config B").toEqual([plannerB.command, ...plannerB.args]);
        }
      });
    });
  },
);
