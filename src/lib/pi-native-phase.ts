import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNamedPiSource } from "../adapters/pi.js";
import { resolveLatestNpmPackageRelease } from "./npm-provider.js";
import { stagePiProviderPackages } from "./pi-provider-stage.js";
import type { StageRun } from "./pi-release-stage.js";
import { activatePiProviderPackages, type PiProviderPackage } from "./pi-provider-activation.js";
import { piProviderReceiptPath, verifyPiProviderReceipt } from "./pi-provider-receipt.js";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";
import { trustedDevtoolsHandoff, type PiProjectionMcpNativeAuthority } from "./pi-projection-lifecycle.js";
import {
  buildNativeMcpAuthority,
  digestNativeMcpDefinition,
  nativeWholeEntrySha256,
  parseNativeMcpAuthorityStrict,
  planNativeContext7Entry,
  planNativeEngramEntry,
  readNativeMcpContract,
  readNativeMcpSnapshot,
  resolveNativeDevtoolsDefinition,
  restoreOwnedWrite,
  writeNativeMcpConfig,
  type NativeMcpOwnedEntry,
  type NativeMcpOwnershipResult,
  type NativeMcpServerName,
  type NativeMcpSnapshot,
} from "./pi-native-mcp.js";
import { createBackup } from "./backup.js";
import { writeText } from "./fsx.js";
import { resolveActivePiEntry } from "./pi-private-release.js";

/**
 * Native transport provider/config phase for the Stack consumer of the Pi
 * `mcp-native-v1` contract.
 *
 * All readonly validation runs before any effect. It never runs the legacy
 * official Engram setup and never installs the adapter.
 */

export interface NativePiMcpPhaseInput {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly engramBin: string;
  readonly piExecutable: string;
  readonly stageDir: string;
  readonly fresh: boolean;
  readonly devtoolsManagedStateDir?: string;
  readonly backupRoot?: string;
  readonly fetchImpl?: typeof fetch;
  /** Deterministic stage process seam (production default preserved). */
  readonly run?: StageRun;
  /** Injected already-verified provider stage (target-dir keeps the network off). */
  readonly providerStage?: { readonly stageDir: string; readonly packages: readonly PiProviderPackage[] };
  /**
   * Explicit caller-provided isolation scope for a native target-dir. It is a
   * containment boundary only — never transport authority. When present it must
   * resolve to the exact canonical relation `homeDir = <root>/home` and
   * `agentDir = <root>/pi-agent`, and the validated root (not the canonical
   * home) becomes the boundary for provider promotion so `<root>/pi-agent`
   * stays a strict child. Real installs leave it absent and keep the actual
   * HOME containment unchanged.
   */
  readonly targetDir?: string;
  /** Bootstrap absent agentDir/npm/node_modules/settings for a truly fresh install. */
  readonly bootstrapDirs?: boolean;
  /**
   * Deliberate compat opt-in for the bounded #1567 derived provider artifact.
   * Only honored on a real install/update; the public flag forbids target-dir
   * and the value is type-validated before any network or write.
   */
  readonly engramTypeboxCompat?: boolean;
}

export interface NativeMcpPreparedWrite {
  readonly agentDir: string;
  readonly created: readonly NativeMcpOwnedEntry[];
  readonly removals: readonly NativeMcpServerName[];
  readonly snapshot: NativeMcpSnapshot;
  readonly backupRoot?: string;
}

export type NativePiMcpPhaseResult =
  | {
      readonly kind: "ready";
      readonly authority: PiProjectionMcpNativeAuthority;
      readonly gentleVersion: string;
      readonly prepared: NativeMcpPreparedWrite;
    }
  | { readonly kind: "blocked"; readonly reason: string; readonly remedy: string };

function blocked(reason: string, remedy: string): NativePiMcpPhaseResult {
  return { kind: "blocked", reason, remedy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRawOrNull(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isStrictChild(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Validates the explicit native target isolation scope: exact canonical
 * relation to the resolved target root and a clean real path with no symlink
 * escape. Throws with a precise reason (the caller maps it to a blocked result
 * before any effect).
 */
function assertCleanTargetScope(targetRoot: string, homeDir: string, agentDir: string): void {
  const rootStat = fs.lstatSync(targetRoot);
  if (rootStat.isSymbolicLink()) throw new Error("el target root es un enlace simbólico");
  if (!rootStat.isDirectory()) throw new Error("el target root no es un directorio real");
  if (fs.realpathSync(targetRoot) !== targetRoot) {
    throw new Error("el target root resuelve a través de un enlace simbólico");
  }
  const home = path.join(targetRoot, "home");
  const agent = path.join(targetRoot, "pi-agent");
  if (homeDir !== home || agentDir !== agent) {
    throw new Error("el scope no respeta la relación canónica <target>/home y <target>/pi-agent");
  }
  for (const [label, dir] of [["home", homeDir], ["pi-agent", agentDir]] as const) {
    const stat = lstatOrNull(dir);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) throw new Error(`el ${label} canónico es un enlace simbólico`);
    if (!stat.isDirectory()) throw new Error(`el ${label} canónico no es un directorio real`);
    if (!isStrictChild(dir, targetRoot)) throw new Error(`el ${label} canónico escapa del target root`);
  }
}

/**
 * The injected provider stage is only accepted for a validated target scope and
 * must stay inside that boundary; the native transport promotes exactly the
 * gentle-engram provider. SRI/tree evidence is re-validated by activation.
 */
function assertInjectedProviderStage(
  stage: { stageDir: string; packages: readonly PiProviderPackage[] },
  isolationRoot: string,
): void {
  const stageDir = path.resolve(stage.stageDir);
  const stat = lstatOrNull(stageDir);
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("el stage de provider inyectado no es un directorio real");
  }
  if (!isStrictChild(stageDir, isolationRoot)) {
    throw new Error("el stage de provider inyectado escapa del target validado");
  }
  if (stage.packages.length !== 1 || stage.packages[0]?.name !== "gentle-engram") {
    throw new Error("el stage nativo inyectado debe contener exactamente gentle-engram");
  }
}

function mainReceiptPath(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "pi-receipt.json");
}

function projectionReceiptPath(homeDir: string): string {
  return path.join(homeDir, ".jorgex-stack", "pi-projection-receipt.json");
}

function dataEnv(homeDir: string, agentDir: string): Record<string, string> {
  // Whitelist: the Pi exports only read HOME/USERPROFILE/PI_CODING_AGENT_DIR.
  return { HOME: homeDir, USERPROFILE: homeDir, PI_CODING_AGENT_DIR: agentDir };
}

/**
 * Strictly validates the projection receipt scope and returns the previous
 * granular authority. Absent = no authority; present-but-malformed throws so the
 * caller blocks instead of inventing absence and re-claiming foreign entries.
 */
function previousAuthorityFromReceipt(
  raw: string | null,
  homeDir: string,
  agentDir: string,
  expectedKind: "real" | "target-dir",
  expectedReceiptFile: string,
): PiProjectionMcpNativeAuthority | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("native projection authority is invalid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) throw new Error("native projection authority has an unsupported shape");
  if (!Object.keys(parsed).every((key) => PROJECTION_ENVELOPE_KEYS.has(key))) {
    throw new Error("native projection authority has an incoherent envelope");
  }
  const scope = parsed.scope;
  if (!isRecord(scope)
    || Object.keys(scope).length !== 4
    || !["kind", "home", "codingAgentDir", "receiptFile"].every((key) => Object.hasOwn(scope, key))
    || scope.kind !== expectedKind
    || scope.home !== homeDir
    || scope.codingAgentDir !== agentDir
    || scope.receiptFile !== expectedReceiptFile) {
    throw new Error("native projection authority has an incoherent scope");
  }
  if (!Array.isArray(parsed.owned)) throw new Error("native projection authority has an invalid owned list");
  return parseNativeMcpAuthorityStrict(parsed.mcpNative) ?? undefined;
}

/** Light but real authentication of the managed package receipt before any claim. */
function assertManagedReceipt(raw: string, agentDir: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("managed Pi receipt is invalid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.state !== "installed") {
    throw new Error("managed Pi receipt has an unsupported shape");
  }
  const candidate = parsed.candidate;
  const scope = parsed.scope;
  if (!isRecord(candidate) || !isRecord(candidate.package)
    || typeof candidate.package.source !== "string"
    || !/^npm:jorgex-pi@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.package.source)
    || !isRecord(parsed.managedPackage)) {
    throw new Error("managed Pi receipt is incomplete");
  }
  if (!isRecord(scope) || scope.codingAgentDir !== agentDir) {
    throw new Error("managed Pi receipt scope does not match the agent directory");
  }
}

interface ResolvedDevtools {
  readonly entry: Record<string, unknown>;
  readonly handoffRaw: string;
}

/**
 * Resolves the trusted v3 DevTools definition from the materialized handoff
 * without touching the active tree: the handoff bytes are written only into a
 * private temporary agent dir that is removed on every exit.
 */
async function resolveTrustedDevtools(
  stagePackageRoot: string,
  managedStateDir: string,
  homeDir: string,
): Promise<ResolvedDevtools> {
  const handoffRaw = `${JSON.stringify(trustedDevtoolsHandoff(managedStateDir), null, 2)}\n`;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jx-native-devtools-"));
  try {
    const tmpAgent = path.join(tmpRoot, "agent");
    fs.mkdirSync(path.join(tmpAgent, "jorgex-pi"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmpAgent, "jorgex-pi", "devtools.v1.json"), handoffRaw, { mode: 0o600 });
    const definition = await resolveNativeDevtoolsDefinition(stagePackageRoot, {
      env: dataEnv(homeDir, tmpAgent),
      platform: process.platform,
    });
    if (definition === undefined) throw new Error("trusted DevTools handoff did not resolve a native definition");
    return { entry: { command: definition.command, args: [...definition.args] }, handoffRaw };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

interface BootstrapResult {
  readonly createdSettings: boolean;
  readonly settingsPath: string;
}

/** Exclusive creation of absent fresh dirs/settings, then a real-directory recheck. */
function bootstrapFreshNativeDirs(agentDir: string): BootstrapResult {
  const dirs = [agentDir, path.join(agentDir, "npm"), path.join(agentDir, "npm", "node_modules")];
  for (const dir of dirs) {
    const stat = lstatOrNull(dir);
    if (stat === null) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`fresh native path is not a real directory: ${dir}`);
  }
  const settingsPath = path.join(agentDir, "settings.json");
  let createdSettings = false;
  if (lstatOrNull(settingsPath) === null) {
    writeText(settingsPath, '{"packages":[]}\n', 0o600);
    createdSettings = true;
  } else {
    const stat = fs.lstatSync(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("fresh native settings.json is not a regular file");
  }
  // Recheck: every path must now be a real directory and settings readable.
  for (const dir of dirs) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`fresh native path is not a real directory: ${dir}`);
  }
  if (readRawOrNull(settingsPath) === null) throw new Error("fresh native settings.json was not created");
  return { createdSettings, settingsPath };
}

function rollbackBootstrap(bootstrap: BootstrapResult): void {
  // Only remove the blank settings file while it still holds our own write.
  if (bootstrap.createdSettings && readRawOrNull(bootstrap.settingsPath) === '{"packages":[]}\n') {
    fs.rmSync(bootstrap.settingsPath, { force: true });
  }
}

const PROJECTION_ENVELOPE_KEYS = new Set(["schemaVersion", "scope", "owned", "mcpNative", "playwright", "devtools"]);

/**
 * Reconciles the granular authority after a native uninstall: removes the
 * claims of entries Stack deleted and releases (drops the cleanup stamp of)
 * entries retained because the user personalized them. The projection receipt
 * itself is only rewritten while it still holds the bytes read here.
 */
export function reconcileNativeAuthorityAfterCleanup(input: {
  readonly homeDir: string;
  readonly agentDir: string;
  readonly scopeKind?: "real" | "target-dir";
  readonly removable: readonly NativeMcpServerName[];
  readonly ownership: NativeMcpOwnershipResult;
  readonly backupRoot?: string;
  /**
   * Authority bytes captured BEFORE the checker. When supplied, the receipt must
   * still hold exactly these bytes after cleanup, before the backup, and before
   * the write; an absent receipt with claims to remove blocks instead of dropping
   * the guard.
   */
  readonly expectedAuthorityRaw?: string | null;
}): void {
  const receiptFile = projectionReceiptPath(input.homeDir);
  const raw = readRawOrNull(receiptFile);
  if (raw === null) {
    const claimsExpected = input.removable.some((name) => {
      const server = input.ownership.servers[name];
      return server !== undefined && server.state === "managed" && server.cleanupEligible === true;
    });
    if (claimsExpected || (input.expectedAuthorityRaw !== undefined && input.expectedAuthorityRaw !== null)) {
      throw new Error("native projection authority is missing but managed claims were expected");
    }
    return;
  }
  if (input.expectedAuthorityRaw !== undefined && input.expectedAuthorityRaw !== raw) {
    throw new Error("native projection authority changed since it was captured before the checker");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("native projection authority is invalid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("native projection authority has an unsupported shape");
  }
  if (!Object.keys(parsed).every((key) => PROJECTION_ENVELOPE_KEYS.has(key))) {
    throw new Error("native projection authority has an incoherent envelope");
  }
  const scope = parsed.scope;
  if (!isRecord(scope)
    || Object.keys(scope).length !== 4
    || !["kind", "home", "codingAgentDir", "receiptFile"].every((key) => Object.hasOwn(scope, key))
    || (input.scopeKind !== undefined
      ? scope.kind !== input.scopeKind
      : (scope.kind !== "real" && scope.kind !== "target-dir"))
    || scope.home !== input.homeDir
    || scope.codingAgentDir !== input.agentDir
    || scope.receiptFile !== receiptFile
    || !Array.isArray(parsed.owned)) {
    throw new Error("native projection authority has an incoherent envelope");
  }
  const authority = parseNativeMcpAuthorityStrict(parsed.mcpNative);
  if (authority === null) return;
  const entries: Record<string, { definitionSha256: string; cleanupSha256?: string }> = { ...authority.entries };
  for (const name of input.removable) delete entries[name];
  for (const name of Object.keys(entries)) {
    const server = input.ownership.servers[name as NativeMcpServerName];
    if (server === undefined || server.state !== "managed" || server.cleanupEligible !== true) {
      // Retained personalized/conflicting entry: keep the definition claim but
      // never renew the cleanup stamp.
      entries[name] = { definitionSha256: entries[name]!.definitionSha256 };
    }
  }
  const next = { ...parsed, mcpNative: { schemaVersion: 1, entries } };
  const nextRaw = `${JSON.stringify(next, null, 2)}\n`;
  if (readRawOrNull(receiptFile) !== raw) {
    throw new Error("native projection authority changed before the cleanup backup");
  }
  createBackup([receiptFile], "pi-native-authority-cleanup", input.backupRoot);
  if (readRawOrNull(receiptFile) !== raw) {
    throw new Error("native projection authority changed after the cleanup backup");
  }
  writeText(receiptFile, nextRaw, 0o600);
  if (readRawOrNull(receiptFile) !== nextRaw) {
    const restored = restoreOwnedWrite(receiptFile, nextRaw, raw);
    throw new Error(restored
      ? "native authority readback mismatch; previous receipt restored"
      : "native authority readback mismatch and previous receipt could not be restored");
  }
}

export async function runNativePiMcpPhase(input: NativePiMcpPhaseInput): Promise<NativePiMcpPhaseResult> {
  const homeDir = path.resolve(input.homeDir);
  const agentDir = path.resolve(input.agentDir);
  const stagePackageRoot = path.join(path.resolve(input.stageDir), "npm", "node_modules", "jorgex-pi");

  if (input.engramTypeboxCompat !== undefined && typeof input.engramTypeboxCompat !== "boolean") {
    return blocked("native-compat-invalid", "El opt-in de compatibilidad de Engram debe ser booleano; no se modificó nada.");
  }

  // --- Isolation scope (read-only): real installs keep actual HOME containment
  // unchanged; a native target must prove the exact canonical relation before
  // any effect. The validated target root becomes the provider-promotion
  // boundary, while the canonical home stays the env/receipt/cache scope. ---
  let isolationRoot = homeDir;
  if (input.targetDir !== undefined) {
    const targetRoot = path.resolve(input.targetDir);
    if (homeDir !== path.join(targetRoot, "home") || agentDir !== path.join(targetRoot, "pi-agent")) {
      return blocked("native-target-scope-mismatch", "El scope nativo no respeta la relación canónica <target>/home y <target>/pi-agent; no se modificó nada.");
    }
    try {
      assertCleanTargetScope(targetRoot, homeDir, agentDir);
    } catch (error) {
      return blocked("native-target-scope-invalid", `${error instanceof Error ? error.message : String(error)}; no se modificó nada.`);
    }
    isolationRoot = targetRoot;
    if (input.backupRoot !== undefined) {
      const backupRoot = path.resolve(input.backupRoot);
      const rel = path.relative(targetRoot, backupRoot);
      if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        return blocked("native-target-backup-invalid", "El backupRoot nativo del target sale de la raíz validada; no se modificó nada.");
      }
    }
    if (input.providerStage === undefined) {
      return blocked("native-target-provider-required", "El target nativo exige el stage de provider ya verificado inyectado; no se descarga en el target.");
    }
  } else if (input.providerStage !== undefined) {
    return blocked("native-provider-stage-requires-target", "El stage de provider inyectado solo se acepta con un scope de target validado; no se modificó nada.");
  }
  if (input.providerStage !== undefined) {
    try {
      assertInjectedProviderStage(input.providerStage, isolationRoot);
    } catch (error) {
      return blocked("native-provider-stage-invalid", `${error instanceof Error ? error.message : String(error)}; no se modificó nada.`);
    }
  }

  try {
    readNativeMcpContract(stagePackageRoot);
  } catch (error) {
    return blocked("native-contract-invalid", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
  }

  // --- Read-only provider-receipt binding before any active write. ---
  // A real install/update binds the separate provenance receipt to the canonical
  // home so a derived recipe is preserved and an existing managed receipt is
  // never silently coerced to native. A target-dir keeps its injected baseline:
  // its agentDir is a sibling of the canonical home and the public opt-in
  // forbids target, so no receipt is claimed there.
  let effectiveEngramTypeboxCompat = input.engramTypeboxCompat === true;
  let providerReceiptSnapshot: string | null | undefined;
  if (input.targetDir === undefined) {
    const receiptFile = piProviderReceiptPath(homeDir);
    let receiptExists = false;
    try {
      receiptExists = fs.lstatSync(receiptFile, { throwIfNoEntry: false }) !== undefined;
    } catch (error) {
      return blocked("native-provider-receipt-invalid", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
    }
    if (!receiptExists) {
      providerReceiptSnapshot = input.engramTypeboxCompat === true ? null : undefined;
    } else {
      try {
        const prior = verifyPiProviderReceipt({ homeDir, agentDir });
        if (prior.receipt !== null && prior.receipt.mcpTransport !== "native") {
          return blocked("native-provider-receipt-transport", "El recibo gestionado de providers declara transporte legacy y no se reclama como native. Pi no quedó activado.");
        }
        providerReceiptSnapshot = fs.readFileSync(receiptFile, "utf8");
        if (prior.kind === "derived") effectiveEngramTypeboxCompat = true;
      } catch (error) {
        return blocked("native-provider-receipt-invalid", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
      }
    }
  } else if (input.engramTypeboxCompat === true) {
    return blocked("native-compat-target-unsupported", "El opt-in de compatibilidad de Engram no se admite en un target-dir aislado; no se modificó nada.");
  }

  // --- Read-only: every snapshot and preflight before any active write. ---
  const devtoolsEnabled = input.devtoolsManagedStateDir !== undefined;
  const settingsPath = path.join(agentDir, "settings.json");
  let mcpSnapshot;
  let previous: PiProjectionMcpNativeAuthority | undefined;
  let settingsJson: string;
  try {
    mcpSnapshot = readNativeMcpSnapshot(agentDir);
    previous = previousAuthorityFromReceipt(
      readRawOrNull(projectionReceiptPath(homeDir)),
      homeDir,
      agentDir,
      input.targetDir === undefined ? "real" : "target-dir",
      projectionReceiptPath(homeDir),
    );
    settingsJson = readRawOrNull(settingsPath) ?? '{"packages":[]}';
    if (input.fresh) {
      if (readRawOrNull(mainReceiptPath(homeDir)) !== null) {
        return blocked("native-fresh-conflict", "El install native fresco encontró un receipt gestionado previo; usa update. Pi no quedó activado.");
      }
    } else {
      const receiptRaw = readRawOrNull(mainReceiptPath(homeDir));
      if (receiptRaw === null) {
        return blocked("native-update-unauthenticated", "El update native exige el receipt gestionado autenticado; Pi no quedó activado.");
      }
      assertManagedReceipt(receiptRaw, agentDir);
    }
  } catch (error) {
    return blocked("native-state-invalid", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
  }

  // --- Plan the protected servers (digest/shape/ownership) before effects. ---
  // On update, the active checker must confirm the old native claims are not in
  // conflict before any write; a scope/source match alone is not authority.
  // Previous-claim checker validation runs after the read-only planning loop
  // (below), so a claimed-but-absent entry keeps its precise block while a
  // surviving claim still requires an authenticated active entry.

  const planned: { name: NativeMcpServerName; entry: Record<string, unknown> }[] = [
    { name: "engram", entry: planNativeEngramEntry(input.engramBin) },
    { name: "context7", entry: planNativeContext7Entry(mcpSnapshot.servers.context7) },
  ];
  if (devtoolsEnabled) {
    try {
      const resolved = await resolveTrustedDevtools(stagePackageRoot, input.devtoolsManagedStateDir!, homeDir);
      planned.push({ name: "chrome-devtools", entry: resolved.entry });
    } catch (error) {
      return blocked("native-devtools-definition-failed", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
    }
  }

  const owned: NativeMcpOwnedEntry[] = [];
  for (const server of planned) {
    const existing = mcpSnapshot.servers[server.name];
    const claim = previous?.entries[server.name];
    if (existing === undefined) {
      if (claim !== undefined) {
        return blocked("native-claimed-absent", `La entrada nativa reclamada ${server.name} falta de mcp.json; se bloquea en lugar de recrearla. Pi no quedó activado.`);
      }
      owned.push({ name: server.name, entry: server.entry, created: true });
      continue;
    }
    if (!isRecord(existing)) {
      return blocked("native-config-conflict", `La entrada nativa ${server.name} existente no es válida; consérvala y resuélvela manualmente. Pi no quedó activado.`);
    }
    if (claim === undefined) {
      // Engram official-direct may stay unowned when it already matches. Any
      // other unowned protected server needs authority and would fail the
      // internal runner later, so it blocks now instead of after publication.
      if (server.name === "engram" && JSON.stringify(existing) === JSON.stringify(server.entry)) continue;
      return blocked("native-config-conflict", `La entrada nativa ${server.name} existe sin autoridad de Stack; no se adopta. Resuélvela manualmente. Pi no quedó activado.`);
    }
    let existingDigest: string;
    try {
      existingDigest = await digestNativeMcpDefinition(stagePackageRoot, server.name, existing);
    } catch (error) {
      return blocked("native-config-conflict", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
    }
    if (existingDigest !== claim.definitionSha256) {
      return blocked("native-config-conflict", `La definición protegida de ${server.name} cambió fuera de Stack; no se renueva la reclamación. Pi no quedó activado.`);
    }
    // Refresh protected fields while preserving user preferences and the raw
    // protected cwd/env (and opaque Context7 headers) that this phase does not clear.
    const merged: Record<string, unknown> = { ...server.entry };
    for (const key of ["exposure", "toolExposure", "enabled"]) {
      if (Object.hasOwn(existing, key)) merged[key] = existing[key];
    }
    if (server.name === "context7") {
      if (isRecord(existing.headers)) merged.headers = existing.headers;
    } else {
      if (Object.hasOwn(existing, "cwd")) merged.cwd = existing.cwd;
      if (Object.hasOwn(existing, "env")) merged.env = existing.env;
    }
    const previousWhole = nativeWholeEntrySha256(existing);
    owned.push({
      name: server.name,
      entry: merged,
      created: false,
      previousEntry: existing,
      ...(claim.cleanupSha256 !== undefined && previousWhole === claim.cleanupSha256
        ? { previousCleanupSha256: claim.cleanupSha256 }
        : {}),
    });
  }

  // Previous-claim enforcement for an update runs in the operational checker
  // (managed-runtime beforeInitialization), which authenticates the active
  // package and requires every claim managed/verified; the phase itself stays a
  // read-only planner plus bounded writer.

  // --- Active writes: bootstrap (fresh), promote gentle, commit config. ---
  let bootstrap: BootstrapResult | null = null;
  if (input.fresh && input.bootstrapDirs === true) {
    try {
      bootstrap = bootstrapFreshNativeDirs(agentDir);
    } catch (error) {
      return blocked("native-bootstrap-failed", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
    }
  }

  let gentleVersion: string;
  try {
    let providerStage: { stageDir: string; packages: readonly PiProviderPackage[] };
    if (input.providerStage !== undefined) {
      providerStage = input.providerStage;
    } else {
      const release = await resolveLatestNpmPackageRelease("gentle-engram", input.fetchImpl ?? fetch);
      const staged = await stagePiProviderPackages(
        {
          homeDir: isolationRoot, agentDir, piExecutable: input.piExecutable, mcpTransport: "native",
          engramTypeboxCompat: effectiveEngramTypeboxCompat,
          releases: { "gentle-engram": release },
        },
        { fetchImpl: input.fetchImpl ?? fetch, ...(input.run === undefined ? {} : { run: input.run }) },
      );
      providerStage = staged;
    }
    gentleVersion = providerStage.packages.find((entry) => entry.name === "gentle-engram")?.version ?? "unknown";
    const settingsBytes = readRawOrNull(settingsPath) ?? settingsJson;
    await activatePiProviderPackages({
      // Boundary only: the validated target root for a target, the real HOME
      // otherwise. Canonical paths keep coming from the canonical agentDir.
      homeDir: isolationRoot,
      agentDir,
      stageDir: providerStage.stageDir,
      packages: providerStage.packages,
      mcpTransport: "native",
      registrationPolicy: input.fresh ? "create-if-absent" : "existing",
      settingsJson: settingsBytes,
      ...(providerReceiptSnapshot === undefined ? {} : { providerReceiptSnapshot }),
      verify: async () => {
        const readback = readRawOrNull(settingsPath);
        if (readback === null) throw new Error("settings.json disappeared during provider activation");
        const parsed: unknown = JSON.parse(readback);
        const packages = isRecord(parsed) && Array.isArray(parsed.packages) ? parsed.packages : [];
        const gentle = packages.filter((entry) => {
          const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : null;
          return source !== null && isNamedPiSource(source, "gentle-engram");
        });
        if (gentle.length !== 1) throw new Error("gentle-engram registration was not published exactly once");
        for (const pkg of providerStage.packages) {
          const activeRoot = path.join(agentDir, "npm", "node_modules", pkg.name);
          if (inventoryTreeSha256(activeRoot) !== pkg.treeSha256) {
            throw new Error(`promoted provider tree does not match the verified stage: ${pkg.name}`);
          }
        }
      },
    });
  } catch (error) {
    if (bootstrap !== null) rollbackBootstrap(bootstrap);
    return blocked("native-provider-failed", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
  }

  // Explicit opt-out: when DevTools is disabled but a prior claim exists, the
  // computed authority omits the chrome-devtools claim (explicit withdrawal,
  // never by silent omission). The persistent mcpServers entry is removed only
  // when it is still the exact full-stamp artifact Stack wrote; a personalized
  // managed entry (cleanup false) is preserved and only its claim is withdrawn.
  const removals: NativeMcpServerName[] = [];
  if (!devtoolsEnabled && previous?.entries["chrome-devtools"] !== undefined) {
    const existing = mcpSnapshot.servers["chrome-devtools"];
    const priorCleanup = previous.entries["chrome-devtools"].cleanupSha256;
    if (isRecord(existing) && priorCleanup !== undefined && nativeWholeEntrySha256(existing) === priorCleanup) {
      removals.push("chrome-devtools");
    }
  }

  let authority: PiProjectionMcpNativeAuthority;
  try {
    authority = owned.length === 0
      ? { schemaVersion: 1, entries: {} }
      : await buildNativeMcpAuthority(stagePackageRoot, owned);
  } catch (error) {
    if (bootstrap !== null) rollbackBootstrap(bootstrap);
    return blocked("native-authority-failed", `${error instanceof Error ? error.message : String(error)}; Pi no quedó activado.`);
  }

  // The active handoff and mcp.json are written by the existing projection
  // lifecycle (pendingNativeConfigWrite) after the handoff is applied/readback
  // and before the final receipt/authority publish; the phase never prewrites
  // the active handoff.
  return {
    kind: "ready",
    authority,
    gentleVersion,
    prepared: {
      agentDir,
      created: owned,
      removals,
      snapshot: mcpSnapshot,
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    },
  };
}
