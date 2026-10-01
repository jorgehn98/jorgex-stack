import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildPiProviderReceipt,
  piProviderReceiptPath,
  serializePiProviderReceipt,
  verifyPiProviderReceipt,
  type PiProviderReceiptEntry,
} from "../src/lib/pi-provider-receipt.js";
import { inventoryTreeSha256 } from "../src/lib/pi-staged-lock.js";

/**
 * Read-only provider receipt seam: schema and structural guards. Semantic
 * binding drift and the derived lifecycle live in pi-provider-activation.test.ts
 * so the same behavior is not asserted twice.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function registryFixture() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-receipt-"));
  roots.push(homeDir);
  const agentDir = path.join(homeDir, ".pi", "agent");
  const activeRoot = path.join(agentDir, "npm", "node_modules", "gentle-engram");
  fs.mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(activeRoot, "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "0.1.17", bin: { "pi-engram": "cli.js" } })}\n`);
  fs.writeFileSync(path.join(activeRoot, "cli.js"), "// registry cli\n");
  const settingsJson = JSON.stringify({ quietStartup: false, packages: [{ source: "npm:gentle-engram@0.1.17", skills: [] }, "npm:foreign@1.0.0"] });
  fs.writeFileSync(path.join(agentDir, "settings.json"), settingsJson);
  const manifestBytes = fs.readFileSync(path.join(activeRoot, "package.json"));
  const entry: PiProviderReceiptEntry = {
    name: "gentle-engram",
    version: "0.1.17",
    source: "npm:gentle-engram@0.1.17",
    packageRoot: "npm/node_modules/gentle-engram",
    integrity: `sha512-${Buffer.alloc(64, 3).toString("base64")}`,
    treeSha256: inventoryTreeSha256(activeRoot),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    bins: { "pi-engram": "cli.js" },
  };
  return { homeDir, agentDir, activeRoot, entry, settingsJson };
}

function writeReceipt(homeDir: string, text: string): string {
  const receiptPath = piProviderReceiptPath(homeDir);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, text);
  return receiptPath;
}

function validReceiptText(f: ReturnType<typeof registryFixture>): string {
  return serializePiProviderReceipt(
    buildPiProviderReceipt({ agentDir: f.agentDir, mcpTransport: "native", providers: [f.entry] }),
  );
}

it("verifies a coherent registry receipt bound to the active root and reports absence without one", () => {
  const f = registryFixture();
  expect(verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir })).toEqual({ kind: "absent", receipt: null });

  writeReceipt(f.homeDir, validReceiptText(f));
  const verified = verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir });
  expect(verified.kind).toBe("registry");
  expect(verified.receipt?.agentDir).toBe(path.resolve(f.agentDir));
  expect(verified.receipt?.providers[0]?.source).toBe("npm:gentle-engram@0.1.17");
});

it("rejects structurally invalid receipts before binding to active state", () => {
  const base = registryFixture();
  const valid = buildPiProviderReceipt({ agentDir: base.agentDir, mcpTransport: "native", providers: [base.entry] });
  const adapterEntry: PiProviderReceiptEntry = { ...base.entry, name: "pi-mcp-adapter", source: "npm:pi-mcp-adapter@0.1.17" };

  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ["malformed JSON", "{not json", /malformed/i],
    ["wrong schemaVersion", JSON.stringify({ ...valid, schemaVersion: 2 }), /schemaVersion/i],
    ["non-absolute agentDir", JSON.stringify({ ...valid, agentDir: "relative/path" }), /absolute/i],
    ["unknown provider", JSON.stringify({ ...valid, providers: [{ ...base.entry, name: "unknown-provider" }] }), /unknown provider/i],
    ["non-canonical source", JSON.stringify({ ...valid, providers: [{ ...base.entry, source: "npm:gentle-engram@9.9.9" }] }), /canonical/i],
    ["provider set mismatch", JSON.stringify({ ...valid, providers: [base.entry, adapterEntry] }), /native providers/i],
  ];
  for (const [label, text, pattern] of cases) {
    const f = registryFixture();
    writeReceipt(f.homeDir, text);
    expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir }), label).toThrow(pattern);
  }
});

it("rejects a symlinked receipt or an unsafe state directory", () => {
  {
    const f = registryFixture();
    const real = path.join(f.homeDir, "real-receipt.json");
    fs.writeFileSync(real, validReceiptText(f));
    const receiptPath = piProviderReceiptPath(f.homeDir);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(real, receiptPath);
    expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir })).toThrow(/regular file/i);
  }
  {
    const f = registryFixture();
    const realState = path.join(f.homeDir, "real-state");
    fs.mkdirSync(realState, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realState, path.join(f.homeDir, ".jorgex-stack"));
    expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir })).toThrow(/state directory/i);
  }
});

it("rejects a receipt bound to a different agent directory", () => {
  const f = registryFixture();
  writeReceipt(f.homeDir, validReceiptText(f));
  const otherAgentDir = path.join(f.homeDir, ".pi", "other-agent");
  expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: otherAgentDir })).toThrow(/active agent directory/i);
});

it("fails closed when statting an existing receipt raises an I/O error instead of reporting absence", () => {
  const f = registryFixture();
  const receiptPath = writeReceipt(f.homeDir, validReceiptText(f));
  const originalLstatSync = fs.lstatSync;
  const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (path.resolve(String(target)) === path.resolve(receiptPath)) {
      throw Object.assign(new Error("injected EIO stat failure on the provider receipt"), { code: "EIO" });
    }
    return originalLstatSync(target, options);
  }) as typeof fs.lstatSync);
  try {
    expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir })).toThrow();
  } finally {
    lstat.mockRestore();
  }
});

it("rejects an active package root reached through a symlinked ancestor", () => {
  const f = registryFixture();
  writeReceipt(f.homeDir, validReceiptText(f));
  // The same fixture verifies while the active root sits inside the agent dir.
  expect(verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir }).kind).toBe("registry");
  const npmDir = path.join(f.agentDir, "npm");
  const foreignNpm = path.join(f.homeDir, "foreign-npm");
  fs.renameSync(npmDir, foreignNpm);
  fs.symlinkSync(foreignNpm, npmDir, "dir");
  expect(() => verifyPiProviderReceipt({ homeDir: f.homeDir, agentDir: f.agentDir })).toThrow();
});
