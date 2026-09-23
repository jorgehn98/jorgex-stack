// T05 RED T07 old receipt migration (tests only, no prod change).
//
// Desired contract (GREEN to implement in src/lib/pi-package-lifecycle.ts):
// - Export pure+read-only `preparePiLegacyMigration({ receiptJson,
//   settingsJson, codingAgentDir, engramBin, scopeKind, acceptedCandidates })`
//   returning `{ previousSource: string; receipt: PiPackageReceipt }` on success
//   or `{ kind: "blocked"; reason: string }` on any mismatch. No writes,
//   no runner, no network; only lstat/read of the legacy package root.
// - Authenticates a schemaVersion 1 LEGACY receipt WITHOUT managedPackage:
//   receipt.candidate { package, tarball, provenance } matches exactly one
//   accepted HISTORICAL recovery anchor (0.8.24 exact from immutable Stack
//   v1.9.51, or old .29), state installed, scope kind + exact codingAgentDir,
//   Engram bin exact, settings has exactly one Pi entry as the exact managed
//   object `{ source, skills: [], prompts: [] }` (bare string, edited object,
//   or duplicate rejected), package root `agentDir/npm/node_modules/jorgex-pi`
//   is lstat regular dir (no symlink) with installed package.json
//   name/version matching the historical candidate.
// - Registry accepted historical object comes from prod
//   src/lib/pi-runtime-history.json; never a future-selection pin.
// - Positive temp sandbox (old .24 receipt + settings + manifest) returns
//   previousSource; tampered hash / manual string / edited / duplicate /
//   symlink / foreign version / missing receipt block and leave files
//   byte-stable. Temp sandboxes under os.tmpdir only; no real HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import history from "../src/lib/pi-runtime-history.json" with { type: "json" };

type AcceptedCandidate = {
  readonly package: { readonly name: string; readonly version: string; readonly source: string };
  readonly provenance: { readonly commit: string };
  readonly tarball: { readonly bytes: number; readonly sha256: string; readonly sha512: string };
  readonly contract: {
    readonly runner: {
      readonly bin: string;
      readonly commands: readonly string[];
      readonly schemaVersion: number;
      readonly maxStdoutBytes: number;
    };
  };
};

type LegacyInput = {
  readonly receiptJson: string | null;
  readonly settingsJson: string;
  readonly codingAgentDir: string;
  readonly engramBin: string;
  readonly scopeKind: "real" | "target-dir";
  readonly acceptedCandidates: readonly AcceptedCandidate[];
};

type LegacySuccess = { readonly previousSource: string; readonly receipt: unknown };
type LegacyBlocked = { readonly kind: "blocked"; readonly reason: string };
type LegacyResult = LegacySuccess | LegacyBlocked;

type PrepareFn = (input: LegacyInput) => LegacyResult | Promise<LegacyResult>;

async function loadPrepare(): Promise<PrepareFn> {
  const mod = (await import("../src/lib/pi-package-lifecycle.js")) as Record<string, unknown>;
  expect(typeof mod["preparePiLegacyMigration"], "falta preparePiLegacyMigration puro T07").toBe("function");
  return mod["preparePiLegacyMigration"] as PrepareFn;
}

function historyCandidates(): readonly AcceptedCandidate[] {
  const parsed = history as unknown as { readonly acceptedCandidates?: unknown };
  const list = parsed.acceptedCandidates;
  expect(Array.isArray(list), "prod pi-runtime-history.json debe exponer acceptedCandidates").toBe(true);
  return list as readonly AcceptedCandidate[];
}

function historical024(candidates: readonly AcceptedCandidate[]): AcceptedCandidate {
  const found = candidates.find((entry) => entry.package.version === "0.8.24");
  expect(found, "el ancla histórica 0.8.24 debe estar en pi-runtime-history.json").toBeDefined();
  if (found === undefined) throw new Error("historical 0.8.24 missing");
  // Immutable Stack v1.9.51 anchor: exact identity, never a next-install selector.
  expect(found.package).toEqual({ name: "jorgex-pi", version: "0.8.24", source: "npm:jorgex-pi@0.8.24" });
  expect(found.provenance).toEqual({ commit: "652d7e445e6f184c4543593c115026aa2f71e761" });
  expect(found.tarball).toEqual({
    bytes: 89140631,
    sha256: "6f67e546c86f21f9b5ff139f429551e696be4a8389ce4a6262e137dcce923a5f",
    sha512:
      "1ce4bfc316f1635c5e498af7134ae16f430a4f6a3d2c99c7aa6fc31b76ce18684759c6480f506b5de45aa5b5b682e03f68d10fc77c83ae1679006dab679d9aa4",
  });
  expect(found.contract.runner).toEqual({
    bin: "jorgex-pi",
    commands: ["status", "doctor", "models", "sync", "cleanup"],
    schemaVersion: 1,
    maxStdoutBytes: 65536,
  });
  return found;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type LegacySandbox = {
  readonly sandbox: string;
  readonly agentDir: string;
  readonly engramBin: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly historical: AcceptedCandidate;
  readonly scopeKind: "target-dir";
  receiptJson: string;
  settingsJson: string;
};

function setupValidLegacySandbox(): LegacySandbox {
  const candidates = historyCandidates();
  const historical = historical024(candidates);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "jx-t07-legacy-"));
  sandboxes.push(sandbox);
  const agentDir = path.join(sandbox, "agent");
  const packageRoot = path.join(agentDir, "npm", "node_modules", "jorgex-pi");
  fs.mkdirSync(packageRoot, { recursive: true });
  const manifestPath = path.join(packageRoot, "package.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ name: "jorgex-pi", version: historical.package.version }, null, 2)}\n`,
  );
  const engramBin = path.join(sandbox, "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\nexit 0\n");
  const receipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { ...historical.package },
      tarball: { ...historical.tarball },
      provenance: { ...historical.provenance },
    },
    scope: { kind: "target-dir", codingAgentDir: agentDir },
    engram: { binary: engramBin },
  };
  const receiptJson = JSON.stringify(receipt);
  const settingsJson = JSON.stringify({
    packages: [{ source: historical.package.source, skills: [], prompts: [] }],
  });
  return {
    sandbox,
    agentDir,
    engramBin,
    packageRoot,
    manifestPath,
    historical,
    scopeKind: "target-dir",
    receiptJson,
    settingsJson,
  };
}

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) {
          let target = "<unreadable>";
          try {
            target = fs.readlinkSync(full);
          } catch {
            target = "<unreadable>";
          }
          out[rel] = `symlink:${target}`;
        } else if (st.isDirectory()) {
          out[rel] = "dir";
          stack.push(full);
        } else if (st.isFile()) {
          const bytes = fs.readFileSync(full);
          out[rel] = `file:${createHash("sha256").update(bytes).digest("hex")}:${bytes.byteLength}`;
        } else {
          out[rel] = `other:${String(st.mode)}`;
        }
      } catch {
        out[rel] = "<lstat-failed>";
      }
    }
  }
  return out;
}

function legacyInputFor(sandbox: LegacySandbox, overrides: Partial<LegacyInput> = {}): LegacyInput {
  return {
    receiptJson: sandbox.receiptJson,
    settingsJson: sandbox.settingsJson,
    codingAgentDir: sandbox.agentDir,
    engramBin: sandbox.engramBin,
    scopeKind: sandbox.scopeKind,
    acceptedCandidates: historyCandidates(),
    ...overrides,
  };
}

describe("T07 RED preparePiLegacyMigration legacy 0.8.24 (pure, read-only)", () => {
  it("authenticates the legacy 0.8.24 receipt without managedPackage and returns previousSource with no writes", async () => {
    const prepare = await loadPrepare();
    const sandbox = setupValidLegacySandbox();
    // Registry anchor is the prod history object, never a future pin.
    expect(sandbox.historical.package.version).toBe("0.8.24");
    expect(sandbox.historical.package.source).toBe("npm:jorgex-pi@0.8.24");
    // Legacy shape: no managedPackage field on the wire.
    expect(sandbox.receiptJson).not.toContain("managedPackage");
    expect(JSON.parse(sandbox.settingsJson)).toEqual({
      packages: [{ source: "npm:jorgex-pi@0.8.24", skills: [], prompts: [] }],
    });
    expect(fs.lstatSync(sandbox.packageRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(sandbox.packageRoot).isSymbolicLink()).toBe(false);

    const before = snapshotTree(sandbox.sandbox);
    const holder = globalThis as unknown as { readonly fetch?: unknown };
    const originalFetch = holder.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = () => {
      throw new Error("network forbidden in pure legacy migration");
    };
    try {
      const result = await prepare(legacyInputFor(sandbox));
      expect(result).toMatchObject({ previousSource: "npm:jorgex-pi@0.8.24" });
      expect(result).toHaveProperty("receipt");
      const receipt = (result as LegacySuccess).receipt as Record<string, unknown>;
      expect(receipt["schemaVersion"]).toBe(1);
      expect(receipt["state"]).toBe("installed");
      expect(receipt).not.toHaveProperty("managedPackage");
      expect(JSON.stringify((receipt["candidate"] as { package: unknown }).package)).toBe(
        JSON.stringify(sandbox.historical.package),
      );
      expect(JSON.stringify((receipt["candidate"] as { tarball: unknown }).tarball)).toBe(
        JSON.stringify(sandbox.historical.tarball),
      );
      expect(JSON.stringify((receipt["candidate"] as { provenance: unknown }).provenance)).toBe(
        JSON.stringify(sandbox.historical.provenance),
      );
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    }
    // Pure + read-only: no writes, byte-stable files.
    expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    expect(fs.readFileSync(sandbox.manifestPath, "utf8")).toContain('"version": "0.8.24"');
  });

  it("blocks tampered/manual/symlink/foreign/missing receipts and leaves files byte-stable", async () => {
    const prepare = await loadPrepare();

    // Tampered tarball hash.
    {
      const sandbox = setupValidLegacySandbox();
      const parsed = JSON.parse(sandbox.receiptJson) as {
        candidate: { tarball: { sha256: string } };
      };
      parsed.candidate.tarball.sha256 = "0".repeat(64);
      const input = legacyInputFor(sandbox, { receiptJson: JSON.stringify(parsed) });
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect((result as LegacyBlocked).reason).toMatch(/.+/);
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }

    // Manual bare-string Pi entry (never owned).
    {
      const sandbox = setupValidLegacySandbox();
      const input = legacyInputFor(sandbox, {
        settingsJson: JSON.stringify({ packages: [sandbox.historical.package.source] }),
      });
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }

    // Edited managed object (non-empty skills).
    {
      const sandbox = setupValidLegacySandbox();
      const input = legacyInputFor(sandbox, {
        settingsJson: JSON.stringify({
          packages: [{ source: sandbox.historical.package.source, skills: ["tdd"], prompts: [] }],
        }),
      });
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }

    // Duplicate managed entries.
    {
      const sandbox = setupValidLegacySandbox();
      const managed = { source: sandbox.historical.package.source, skills: [], prompts: [] };
      const input = legacyInputFor(sandbox, {
        settingsJson: JSON.stringify({ packages: [managed, managed] }),
      });
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }

    // Symlinked package root (must be a regular dir).
    {
      const sandbox = setupValidLegacySandbox();
      const realTarget = path.join(sandbox.sandbox, "real-target");
      fs.mkdirSync(realTarget, { recursive: true });
      fs.writeFileSync(
        path.join(realTarget, "package.json"),
        `${JSON.stringify({ name: "jorgex-pi", version: sandbox.historical.package.version })}\n`,
      );
      fs.rmSync(sandbox.packageRoot, { recursive: true, force: true });
      fs.symlinkSync(realTarget, sandbox.packageRoot, "dir");
      expect(fs.lstatSync(sandbox.packageRoot).isSymbolicLink()).toBe(true);
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(legacyInputFor(sandbox));
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
      expect(fs.lstatSync(sandbox.packageRoot).isSymbolicLink()).toBe(true);
    }

    // Foreign version not in the historical recovery anchors.
    {
      const sandbox = setupValidLegacySandbox();
      const foreignSource = "npm:jorgex-pi@0.8.99";
      const foreignReceipt = {
        schemaVersion: 1,
        state: "installed",
        candidate: {
          package: { name: "jorgex-pi", version: "0.8.99", source: foreignSource },
          tarball: {
            bytes: 1234567,
            sha256: "a".repeat(64),
            sha512: "b".repeat(128),
          },
          provenance: { commit: "c".repeat(40) },
        },
        scope: { kind: "target-dir", codingAgentDir: sandbox.agentDir },
        engram: { binary: sandbox.engramBin },
      };
      const input = legacyInputFor(sandbox, {
        receiptJson: JSON.stringify(foreignReceipt),
        settingsJson: JSON.stringify({ packages: [{ source: foreignSource, skills: [], prompts: [] }] }),
      });
      expect(foreignSource).not.toBe(sandbox.historical.package.source);
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }

    // Missing receipt.
    {
      const sandbox = setupValidLegacySandbox();
      const input = legacyInputFor(sandbox, { receiptJson: null });
      const before = snapshotTree(sandbox.sandbox);
      const result = await prepare(input);
      expect(result).toMatchObject({ kind: "blocked" });
      expect(snapshotTree(sandbox.sandbox)).toEqual(before);
    }
  });
});
