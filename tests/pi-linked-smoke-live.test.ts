import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { stageVerifiedPiTarball } from "../src/lib/pi-release-stage.js";
import { materializeStagedPiRuntimeDependencies } from "../src/lib/pi-staged-lock.js";
import { smokeLinkedPiRuntime } from "../src/lib/pi-stage-smoke.js";
import { runPiStageProcess } from "../src/lib/pi-stage-process.js";
import { resolveLatestNpmPackageRelease } from "../src/lib/npm-provider.js";
import { stagePiProviderPackages } from "../src/lib/pi-provider-stage.js";
import { smokePiProviderRuntime } from "../src/lib/pi-provider-smoke.js";
import { installMissingEngram } from "../src/lib/engram-install.js";

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const sha512Hex = (bytes: Buffer): string => createHash("sha512").update(bytes).digest("hex");

// One compact JSON line per live RPC phase so CI shows which boot timed out
// without dumping the isolated environment. Only label, elapsed ms and outcome.
function logPhase(label: string, startedAt: number, outcome: "ok" | "error"): void {
  console.log(JSON.stringify({ phase: label, ms: Math.round(performance.now() - startedAt), outcome }));
}

async function phase<T>(label: string, run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    logPhase(label, startedAt, "ok");
    return result;
  } catch (error) {
    logPhase(label, startedAt, "error");
    throw error;
  }
}

const piExecutable = process.env.JORGEX_PI_BIN ?? (process.env.PI_TEST_HOST
  ? path.join(process.env.PI_TEST_HOST, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi")
  : undefined);
const artifactPath = process.env.JORGEX_PI_LIVE_ARTIFACT;
const version: string | undefined = process.env.JORGEX_PI_LIVE_VERSION ?? (process.env.PI_TEST_CANDIDATE
  ? JSON.parse(fs.readFileSync(process.env.PI_TEST_CANDIDATE, "utf8")).version as string
  : undefined);

it.skipIf(!piExecutable || !artifactPath || !version)("real Pi loads the promoted-link topology only with its verified local runtime copies", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-layout-live-"));
  let failed = false;
  try {
    const agentDir = path.join(homeDir, "agent");
    fs.mkdirSync(agentDir);
    const bytes = fs.readFileSync(artifactPath!);
    const artifact = {
      path: path.resolve(artifactPath!), bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
    const release = { version: version!, tarballUrl: `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const staged = await stageVerifiedPiTarball(
      { homeDir, agentDir, piExecutable: piExecutable!, artifact, release },
      runPiStageProcess,
    );
    const packageRoot = path.join(staged.stageDir, "npm", "node_modules", "jorgex-pi");
    // Restore the old topology to prove the same real loader goes RED.
    fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true });
    const smoke = { piExecutable: piExecutable!, packageRoot, scratchRoot: path.dirname(staged.stageDir) };
    await phase("linked-negative-old-topology", () => expect(smokeLinkedPiRuntime(smoke)).rejects.toThrow(/permission load failure|Cannot find module/));
    materializeStagedPiRuntimeDependencies({ stageDir: staged.stageDir, tarballPath: artifact.path, release });
    const ready = await phase("linked-positive-repaired-topology", () => smokeLinkedPiRuntime(smoke));
    expect(ready.commands).toEqual(expect.arrayContaining(["permission-system", "subagents", "goal", "websearch"]));
    const engramTypeboxCompat = process.env.JORGEX_PI_ENGRAM_TYPEBOX_COMPAT === "1";
    const gentleRelease = await resolveLatestNpmPackageRelease("gentle-engram", fetch);
    const adapterRelease = await resolveLatestNpmPackageRelease("pi-mcp-adapter", fetch);
    const providers = await stagePiProviderPackages({
      homeDir, agentDir, piExecutable: piExecutable!,
      releases: { "gentle-engram": gentleRelease, "pi-mcp-adapter": adapterRelease },
      engramTypeboxCompat,
    });
    const roots = Object.fromEntries(providers.packages.map((provider) => [provider.name, provider.packageRoot])) as Record<"gentle-engram" | "pi-mcp-adapter", string>;
    const gentle = providers.packages.find((provider) => provider.name === "gentle-engram")!;
    const adapter = providers.packages.find((provider) => provider.name === "pi-mcp-adapter")!;
    // The registry SRI resolved from latest stays the source of truth: the
    // evidence never downgrades it to the effective (possibly derived) SRI.
    expect(gentle.integrity).toBe(gentleRelease.integrity);
    expect(adapter.integrity).toBe(adapterRelease.integrity);
    // Only the opted-in gentle-engram transform may carry provenance.
    expect(adapter.provenance).toBeUndefined();

    if (engramTypeboxCompat) {
      const provenance = gentle.provenance;
      if (provenance === undefined) throw new Error("compat opt-in must record gentle-engram provenance");
      expect(provenance.packageName).toBe("gentle-engram");
      expect(provenance.version).toBe(gentleRelease.version);
      expect(provenance.original.integrity).toBe(gentleRelease.integrity);
      expect(provenance.original.integrity).toBe(`sha512-${Buffer.from(provenance.original.sha512, "hex").toString("base64")}`);

      // Bind the recorded source digests to the real official bytes the stage
      // acquired, not to the mutable release metadata alone.
      const officialBytes = fs.readFileSync(
        path.join(providers.stageDir, "gentle-engram", "downloads", `gentle-engram-${gentleRelease.version}.tgz`),
      );
      expect(sha256Hex(officialBytes)).toBe(provenance.original.sha256);
      expect(sha512Hex(officialBytes)).toBe(provenance.original.sha512);

      const installedManifest = fs.readFileSync(path.join(gentle.packageRoot, "package.json"));
      const installedManifestSha256 = sha256Hex(installedManifest);
      const lock = JSON.parse(fs.readFileSync(
        path.join(path.dirname(path.dirname(gentle.packageRoot)), "package-lock.json"), "utf8",
      )) as { packages: Record<string, { integrity?: string }> };

      if (provenance.origin === "registry") {
        // An official release already carrying the #1567 delta is installed
        // untouched; no unpublished release is fabricated for it.
        expect(provenance.derived).toBeUndefined();
        expect(installedManifestSha256).toBe(provenance.original.manifestSha256);
        expect(lock.packages["node_modules/gentle-engram"]?.integrity).toBe(gentleRelease.integrity);
      } else {
        const derived = provenance.derived;
        expect(derived.integrity).not.toBe(gentleRelease.integrity);
        const derivedBytes = fs.readFileSync(derived.path);
        expect(sha256Hex(derivedBytes)).toBe(derived.sha256);
        expect(sha512Hex(derivedBytes)).toBe(derived.sha512);
        expect(installedManifestSha256).toBe(derived.manifestSha256);
        const manifest = JSON.parse(installedManifest.toString("utf8")) as {
          dependencies?: Record<string, unknown>;
          peerDependencies?: Record<string, unknown>;
        };
        // The installed variant must rely on the host TypeBox, not its own.
        expect(manifest.dependencies?.typebox).toBeUndefined();
        expect(manifest.peerDependencies?.typebox).toBe("*");
        expect(fs.existsSync(path.join(gentle.packageRoot, "node_modules", "typebox"))).toBe(false);
        expect(lock.packages["node_modules/gentle-engram/node_modules/typebox"]).toBeUndefined();
        expect(lock.packages["node_modules/gentle-engram"]?.integrity).toBe(derived.integrity);
      }
    } else {
      expect(gentle.provenance).toBeUndefined();
    }
    // The adapter may initialize its lazy MCP transport during startup. Use
    // the official verified binary, not Node pretending to be an MCP server.
    const engram = await installMissingEngram({ homeDir });
    if (!engram.ok) throw new Error(engram.reason);
    const providerSmoke = await phase("providers-complete", () => smokePiProviderRuntime({ piExecutable: piExecutable!, jorgexPackageRoot: packageRoot,
      providerRoots: roots, engramBin: engram.bin, scratchRoot: providers.stageDir }));
    expect(providerSmoke.commands).toEqual(expect.arrayContaining(["mcp", "mcp-adapter", "permission-system"]));

  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      // Always remove our own isolated home, even after a failure: only the
      // compact diagnostic path is kept, never the whole environment.
      fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (failed) console.error(`Pi live stage failed; own isolated home removed: ${homeDir}`);
    } catch (cleanupError) {
      // A successful removal is the only thing that prints "removed"; the
      // original failure still propagates when cleanup cannot finish.
      if (!failed) throw cleanupError;
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`Pi live stage cleanup failed; own isolated home retained at ${homeDir}: ${detail}`);
    }
  }
}, process.platform === "win32" ? 960_000 : 480_000);
