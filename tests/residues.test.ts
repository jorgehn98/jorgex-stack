import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInstall } from "../src/install.js";
import { runDoctor } from "../src/doctor.js";
import { createBackup } from "../src/lib/backup.js";
import { findResidues, formatBytes, treeBytes } from "../src/lib/residues.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@clack/prompts", () => ({ log: logs }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/var/tmp", "jx-residues-")); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
const state = () => path.join(root, ".jorgex-stack");
const dirs = () => ({ stateDir: state(), configDirs: { opencode: path.join(root, "opencode"), pi: path.join(root, "pi-agent") } });
const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const output = () => [...logs.info.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls].flat().join("\n");

describe("findResidues", () => {
  it("returns nothing when no known path exists", () => {
    write(path.join(state(), "manifest.json"), "{}");
    write(path.join(root, "pi-agent", "settings.json"), "{}");
    expect(findResidues(dirs())).toEqual([]);
  });

  it("reports existing known paths with class and size, and ignores everything else", () => {
    write(path.join(state(), "model-map.json"), "12345");
    write(path.join(state(), "packages", "a", "one.bin"), "123");
    write(path.join(state(), "packages", "two.bin"), "1234");
    write(path.join(state(), "manifest.json"), "{}");
    write(path.join(root, "pi-agent", "stage-abc", "pkg.tgz"), "123456");
    write(path.join(root, "pi-agent", "stage-note"), "a file, not a stage directory");
    write(path.join(root, "pi-agent", "npm", "jorgex-pi-managed", "x"), "12");
    write(path.join(root, "pi-agent", "npm", "package.json"), "{}");
    write(path.join(root, "pi-agent", "extensions", "jorgex-compact-tools", "index.ts"), "1234567");
    write(path.join(root, "opencode", "commands", "xreview.md"), "12345678");
    write(path.join(root, "opencode", "commands", "mine.md"), "personal");

    const found = findResidues(dirs());
    expect(found.map(({ path: file, kind, bytes }) => ({ path: file, kind, bytes }))).toEqual([
      { path: path.join(state(), "model-map.json"), kind: "private", bytes: 5 },
      { path: path.join(state(), "packages"), kind: "private", bytes: 7 },
      { path: path.join(root, "pi-agent", "stage-abc"), kind: "private", bytes: 6 },
      { path: path.join(root, "pi-agent", "npm", "jorgex-pi-managed"), kind: "private", bytes: 2 },
      { path: path.join(root, "opencode", "commands", "xreview.md"), kind: "user-config", bytes: 8 },
      { path: path.join(root, "pi-agent", "extensions", "jorgex-compact-tools"), kind: "user-config", bytes: 7 },
    ]);
    expect(found.every((entry) => entry.remedy.length > 0)).toBe(true);
  });

  it("skips runtimes whose config directory is not provided", () => {
    write(path.join(root, "opencode", "plugins", "stack-hooks.ts"), "x");
    expect(findResidues({ stateDir: state(), configDirs: {} })).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("never follows symbolic links", () => {
    const outside = path.join(root, "outside");
    write(path.join(outside, "big.bin"), "x".repeat(5000));
    fs.mkdirSync(path.join(state(), "packages"), { recursive: true });
    fs.symlinkSync(outside, path.join(state(), "packages", "link"));
    fs.symlinkSync(outside, path.join(state(), ".browser-managed"));
    const found = findResidues(dirs());
    expect(found.map((entry) => path.basename(entry.path))).toEqual(["packages", ".browser-managed"]);
    for (const entry of found) expect(entry.bytes).toBeLessThan(5000);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable directory as unknown size", () => {
    const locked = path.join(state(), "packages");
    write(path.join(locked, "inner", "a"), "1");
    fs.chmodSync(path.join(locked, "inner"), 0o000);
    try { expect(findResidues(dirs())).toMatchObject([{ path: locked, bytes: null }]); }
    finally { fs.chmodSync(path.join(locked, "inner"), 0o700); }
  });
});

it("treeBytes sums file sizes and is null for a missing path; formatBytes is human readable", () => {
  write(path.join(root, "t", "a"), "12");
  write(path.join(root, "t", "b", "c"), "345");
  expect(treeBytes(path.join(root, "t"))).toBe(5);
  expect(treeBytes(path.join(root, "missing"))).toBeNull();
  expect(formatBytes(5)).toBe("5 B");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  expect(formatBytes(null)).toBe("tamaño desconocido");
});

describe("doctor", () => {
  const options = () => ({ targetDir: root, runtimes: ["codex" as const, "pi" as const], scope: { section: "agents" as const, agent: "implementer" } });
  const tree = () => fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => { const file = path.join(entry.parentPath, entry.name); const stat = fs.lstatSync(file); return `${file}|${stat.size}|${stat.mtimeMs}`; }).sort();

  it("lists residues once and summarises backups without writing or changing its exit code", async () => {
    for (const runtime of options().runtimes) expect(await runInstall({ ...options(), runtimes: [runtime], dryRun: false, yes: true })).toBe(0);
    expect(await runDoctor(options())).toBe(0);
    expect(output()).not.toContain("Residuos");
    vi.clearAllMocks();

    const backups = path.join(state(), "backups");
    fs.rmSync(backups, { recursive: true, force: true });
    write(path.join(root, "one.txt"), "one");
    createBackup([path.join(root, "one.txt")], "first", backups);
    fs.writeFileSync(path.join(root, "one.txt"), "two");
    createBackup([path.join(root, "one.txt")], "second", backups);
    const stateResidue = path.join(state(), "pi-receipt.json");
    const userResidue = path.join(root, "pi-agent", "prompts", "lean-audit.md");
    write(stateResidue, "1234");
    write(userResidue, "12");
    const before = tree();

    expect(await runDoctor(options())).toBe(0);
    const text = output();
    expect(text.split(stateResidue)).toHaveLength(2);
    expect(text.split(userResidue)).toHaveLength(2);
    expect(text).toMatch(/privado.*pi-receipt\.json.*4 B/);
    expect(text).toMatch(/configuración del usuario.*lean-audit\.md.*2 B/);
    expect(text).toMatch(/Backups: 2 snapshots, \d/);
    expect(tree()).toEqual(before);
  });

  it("uses the target paths only: no residue or backup report for an empty target", async () => {
    await runDoctor({ targetDir: root, runtimes: ["codex"] });
    expect(output()).not.toMatch(/Residuos|Backups:/);
  });
});

describe("manifest updatedAt", () => {
  const options = () => ({ targetDir: root, runtimes: ["pi" as const], dryRun: false, yes: true, execute: () => "" });
  const manifestFile = () => path.join(state(), "manifest.json");
  const updatedAt = () => JSON.parse(fs.readFileSync(manifestFile(), "utf8")).runtimes.pi.updatedAt as string;

  it("is renewed when the row changes and stays put when it does not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    expect(await runInstall({ ...options(), scope: { section: "agents", agent: "implementer" } })).toBe(0);
    expect(updatedAt()).toBe("2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const raw = fs.readFileSync(manifestFile(), "utf8");
    const mtime = fs.statSync(manifestFile()).mtimeMs;
    expect(await runInstall({ ...options(), scope: { section: "agents", agent: "implementer" } })).toBe(0);
    expect(fs.readFileSync(manifestFile(), "utf8")).toBe(raw);
    expect(fs.statSync(manifestFile()).mtimeMs).toBe(mtime);

    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    expect(await runInstall({ ...options(), scope: { section: "skills" } })).toBe(0);
    expect(updatedAt()).toBe("2026-03-01T00:00:00.000Z");
  });
});
