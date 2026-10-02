import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiProviderReceiptReport } from "../src/adapters/pi.js";
import { resolveProviderManifestRecipe } from "../src/lib/pi-provider-artifact.js";
import {
  buildPiProviderReceipt,
  piProviderReceiptPath,
  serializePiProviderReceipt,
  type PiProviderReceiptEntry,
} from "../src/lib/pi-provider-receipt.js";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";

/**
 * Distinct contract of the read-only provider receipt report consumed by the
 * doctor and the official setup: null when the separate receipt is absent,
 * registry/derived classification with a human detail, and a hard failure on
 * drift or on a receipt that does not describe the active agent directory.
 * Everything runs on owned temp fixtures with the real filesystem boundary;
 * the heavy derived artifact/retirement crypto lives in its core fixtures.
 */

const UPSTREAM_COMMIT = "5455dc245044589445e7d7a83fdff8c84dfb9689";
const VERSION = "0.1.17";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeFixture(): { homeDir: string; agentDir: string; activeRoot: string; settingsPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-provider-report-"));
  roots.push(homeDir);
  const agentDir = path.join(homeDir, ".pi", "agent");
  const activeRoot = path.join(agentDir, "npm", "node_modules", "gentle-engram");
  fs.mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(activeRoot, "package.json"),
    `${JSON.stringify({ name: "gentle-engram", version: VERSION, bin: { "pi-engram": "cli.js" } })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(activeRoot, "cli.js"), "// registry cli\n", { mode: 0o700 });
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify({ packages: [`npm:gentle-engram@${VERSION}`] })}\n`, { mode: 0o600 });
  return { homeDir, agentDir, activeRoot, settingsPath };
}

function registryEntry(activeRoot: string): PiProviderReceiptEntry {
  const manifestBytes = fs.readFileSync(path.join(activeRoot, "package.json"));
  return {
    name: "gentle-engram",
    version: VERSION,
    source: `npm:gentle-engram@${VERSION}`,
    packageRoot: "npm/node_modules/gentle-engram",
    integrity: `sha512-${Buffer.alloc(64, 5).toString("base64")}`,
    treeSha256: inventoryTreeSha256(activeRoot),
    manifestSha256: sha256(manifestBytes),
    bins: { "pi-engram": "cli.js" },
  };
}

function writeReceipt(homeDir: string, entry: PiProviderReceiptEntry): string {
  const text = serializePiProviderReceipt(buildPiProviderReceipt({
    agentDir: path.join(homeDir, ".pi", "agent"),
    mcpTransport: "native",
    providers: [entry],
  }));
  const target = piProviderReceiptPath(homeDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, text, { mode: 0o600 });
  return text;
}

function derivedEntry(activeRoot: string): PiProviderReceiptEntry {
  const originalManifest = Buffer.from(`${JSON.stringify({
    name: "gentle-engram",
    version: VERSION,
    type: "module",
    bin: { "pi-engram": "cli.js" },
    dependencies: { typebox: "^1.1.38" },
  }, null, 2)}\n`);
  const recipe = resolveProviderManifestRecipe(originalManifest, "gentle-engram", VERSION);
  if (recipe.origin !== "derived") throw new Error("fixture must produce a derived manifest");
  fs.writeFileSync(path.join(activeRoot, "package.json"), recipe.manifest, { mode: 0o600 });

  const originalBytes = Buffer.from("official gentle-engram fixture bytes\n");
  const originalSha512 = createHash("sha512").update(originalBytes).digest("hex");
  const originalIntegrity = `sha512-${Buffer.from(originalSha512, "hex").toString("base64")}`;
  const derivedBytes = Buffer.from("derived gentle-engram fixture bytes\n");
  const derivedSha512 = createHash("sha512").update(derivedBytes).digest("hex");
  const manifestSha256 = sha256(recipe.manifest);
  return {
    name: "gentle-engram",
    version: VERSION,
    source: `npm:gentle-engram@${VERSION}`,
    packageRoot: "npm/node_modules/gentle-engram",
    integrity: originalIntegrity,
    treeSha256: inventoryTreeSha256(activeRoot),
    manifestSha256,
    bins: { "pi-engram": "cli.js" },
    provenance: {
      origin: "derived",
      packageName: "gentle-engram",
      version: VERSION,
      upstreamPr: 1567,
      upstreamCommit: UPSTREAM_COMMIT,
      original: {
        integrity: originalIntegrity,
        sha256: sha256(originalBytes),
        sha512: originalSha512,
        bytes: originalBytes.byteLength,
        manifestSha256: sha256(originalManifest),
        manifestBase64: originalManifest.toString("base64"),
      },
      derived: {
        bytes: derivedBytes.byteLength,
        sha256: sha256(derivedBytes),
        sha512: derivedSha512,
        integrity: `sha512-${Buffer.from(derivedSha512, "hex").toString("base64")}`,
        manifestSha256,
      },
    },
  };
}

describe("readPiProviderReceiptReport", () => {
  it("devuelve null cuando el recibo separado no existe", async () => {
    const f = makeFixture();
    await expect(readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: f.agentDir })).resolves.toBeNull();
  });

  it("clasifica un recibo registry con su versión", async () => {
    const f = makeFixture();
    writeReceipt(f.homeDir, registryEntry(f.activeRoot));

    const report = await readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: f.agentDir });

    expect(report).toEqual({ kind: "registry", detail: `artefacto oficial de registry v${VERSION}` });
  });

  it("clasifica un recibo derived con su versión", async () => {
    const f = makeFixture();
    writeReceipt(f.homeDir, derivedEntry(f.activeRoot));

    const report = await readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: f.agentDir });

    expect(report).toEqual({ kind: "derived", detail: `variante temporal derivada del oficial v${VERSION} (patch #1567)` });
  });

  it("bloquea drift del estado activo sin reparar nada", async () => {
    const f = makeFixture();
    writeReceipt(f.homeDir, registryEntry(f.activeRoot));
    const manifestPath = path.join(f.activeRoot, "package.json");
    const drifted = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: string };
    drifted.version = "9.9.9";
    fs.writeFileSync(manifestPath, `${JSON.stringify(drifted)}\n`);

    await expect(readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: f.agentDir }))
      .rejects.toThrow(/drift|identity|manifest/i);
  });

  it("con recibo existente, un agentDir ajeno falla en vez de simular ausencia", async () => {
    const f = makeFixture();
    writeReceipt(f.homeDir, registryEntry(f.activeRoot));
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-provider-report-other-"));
    roots.push(otherHome);

    await expect(readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: path.join(otherHome, ".pi", "agent") }))
      .rejects.toThrow(/strict child|active agent directory/i);
  });

  it("sin recibo, un agentDir ajeno conserva el perfil ausente", async () => {
    const f = makeFixture();
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-provider-report-other-"));
    roots.push(otherHome);

    await expect(readPiProviderReceiptReport({ homeDir: f.homeDir, agentDir: path.join(otherHome, ".pi", "agent") }))
      .resolves.toBeNull();
  });
});
