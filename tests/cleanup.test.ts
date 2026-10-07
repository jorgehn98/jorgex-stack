import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanResidues, pruneBackups } from "../src/cleanup.js";
import { listBackups } from "../src/lib/backup.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/var/tmp", "jx-cleanup-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const state = () => path.join(root, ".jorgex-stack");
const backups = () => path.join(state(), "backups");
const dirs = () => ({ stateDir: state(), configDirs: { opencode: path.join(root, "opencode"), pi: path.join(root, "pi-agent") } });
const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
function ui(answer: boolean) {
  const messages: string[] = [];
  return { confirm: vi.fn(async (_message: string) => answer), info: (message: string) => { messages.push(message); }, text: () => messages.join("\n") };
}

describe("cleanResidues", () => {
  const seed = () => {
    write(path.join(state(), "model-map.json"), "12345");
    write(path.join(state(), "packages", "a", "one.bin"), "1234567");
    write(path.join(state(), "manifest.json"), "{}");
    write(path.join(root, "pi-agent", "stage-abc", "pkg.tgz"), "123");
    write(path.join(root, "pi-agent", "settings.json"), "{}");
    write(path.join(root, "opencode", "commands", "xreview.md"), "mine");
  };

  it.each([
    ["still registers jorgex-pi", '{"packages":["npm:pi-subagents",{"source":"npm:jorgex-pi@0.8.29"}]}'],
    ["has unreadable settings", "{"],
  ])("keeps Pi residues while Pi %s, and still removes the ones in Stack's own directory", async (_label, settings) => {
    seed();
    write(path.join(root, "pi-agent", "settings.json"), settings);
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(2);
    expect(h.text()).toMatch(/stage-abc: Pi todavía registra jorgex-pi/);
    expect(fs.existsSync(path.join(root, "pi-agent", "stage-abc", "pkg.tgz"))).toBe(true);
    expect(fs.existsSync(path.join(state(), "packages"))).toBe(false);
  });

  it("removes private residues after confirmation, backing up files only, and leaves user configuration alone", async () => {
    seed();
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(3);

    expect(h.confirm).toHaveBeenCalledOnce();
    const question = h.confirm.mock.calls[0]![0];
    expect(question).toMatch(/3 residuos/);
    expect(question).toContain("15 B");
    expect(question).toMatch(/1 archivo.*backup/);
    expect(question).toMatch(/2 directorios.*sin backup/i);
    expect(fs.existsSync(path.join(state(), "model-map.json"))).toBe(false);
    expect(fs.existsSync(path.join(state(), "packages"))).toBe(false);
    expect(fs.existsSync(path.join(root, "pi-agent", "stage-abc"))).toBe(false);
    expect(fs.readFileSync(path.join(state(), "manifest.json"), "utf8")).toBe("{}");
    expect(fs.readFileSync(path.join(root, "pi-agent", "settings.json"), "utf8")).toBe("{}");
    expect(fs.readFileSync(path.join(root, "opencode", "commands", "xreview.md"), "utf8")).toBe("mine");
    expect(h.text()).toMatch(/xreview\.md.*a mano/);

    const [snapshot, ...rest] = listBackups(backups());
    expect(rest).toEqual([]);
    expect(snapshot).toMatchObject({ label: "cleanup", files: [{ original: path.join(state(), "model-map.json") }] });
    expect(fs.readFileSync(snapshot!.files[0]!.stored, "utf8")).toBe("12345");
  });

  it("changes nothing when the confirmation is declined", async () => {
    seed();
    const h = ui(false);
    expect(await cleanResidues(dirs(), h)).toBe(0);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(state(), "model-map.json"), "utf8")).toBe("12345");
    expect(fs.existsSync(path.join(state(), "packages", "a", "one.bin"))).toBe(true);
    expect(fs.existsSync(path.join(root, "pi-agent", "stage-abc", "pkg.tgz"))).toBe(true);
    expect(fs.existsSync(backups())).toBe(false);
  });

  it("does not ask when only user configuration residues exist", async () => {
    write(path.join(state(), "manifest.json"), "{}");
    write(path.join(root, "opencode", "commands", "xreview.md"), "mine");
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/xreview\.md/);
    expect(fs.existsSync(path.join(root, "opencode", "commands", "xreview.md"))).toBe(true);
  });

  it("informs and does not ask when there is nothing at all", async () => {
    write(path.join(state(), "manifest.json"), "{}");
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/sin residuos/i);
  });

  it.skipIf(process.platform === "win32")("neither removes nor follows a residue that is a symbolic link", async () => {
    const outside = path.join(root, "outside");
    write(path.join(outside, "keep.bin"), "keep");
    fs.mkdirSync(state(), { recursive: true });
    fs.symlinkSync(outside, path.join(state(), ".browser-managed"));
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(fs.lstatSync(path.join(state(), ".browser-managed")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep.bin"), "utf8")).toBe("keep");
    expect(h.text()).toMatch(/\.browser-managed.*enlace simbólico/);
  });

  it.skipIf(process.platform === "win32")("skips a residue reached through a linked parent that leaves the Pi directory", async () => {
    const outside = path.join(root, "outside");
    write(path.join(outside, "jorgex-pi-managed", "keep.bin"), "keep");
    fs.mkdirSync(path.join(root, "pi-agent"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "pi-agent", "npm"));
    const h = ui(true);
    expect(await cleanResidues(dirs(), h)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(outside, "jorgex-pi-managed", "keep.bin"), "utf8")).toBe("keep");
  });
});

describe("pruneBackups", () => {
  const snapshot = (dir: string, label: string, createdAt: string, id = dir) => {
    write(path.join(backups(), dir, "manifest.json"), JSON.stringify({ id, label, createdAt, files: [] }));
    write(path.join(backups(), dir, "files", "0000-x"), "12345");
  };
  const present = () => fs.readdirSync(backups()).sort();
  const seed = () => {
    for (const day of [1, 2, 3, 4, 5]) snapshot(`a${day}`, "sync", `2026-01-0${day}T00:00:00.000Z`);
    snapshot("b1", "uninstall", "2025-01-01T00:00:00.000Z");
    snapshot("b2", "uninstall", "2025-01-02T00:00:00.000Z");
    write(path.join(backups(), "broken", "manifest.json"), "{not json");
  };

  it("keeps the three most recent snapshots per label and every corrupt one", async () => {
    seed();
    const h = ui(true);
    expect(await pruneBackups(backups(), h)).toBe(2);
    expect(h.confirm).toHaveBeenCalledOnce();
    const question = h.confirm.mock.calls[0]![0];
    expect(question).toMatch(/2 snapshots/);
    expect(question).toMatch(/\d B/);
    expect(present()).toEqual(["a3", "a4", "a5", "b1", "b2", "broken"]);
  });

  it("deletes nothing when the confirmation is declined", async () => {
    seed();
    const h = ui(false);
    expect(await pruneBackups(backups(), h)).toBe(0);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(present()).toEqual(["a1", "a2", "a3", "a4", "a5", "b1", "b2", "broken"]);
  });

  it("does not ask when nothing exceeds the retention or the root is missing", async () => {
    const empty = ui(true);
    expect(await pruneBackups(backups(), empty)).toBe(0);
    for (const day of [1, 2, 3]) snapshot(`a${day}`, "sync", `2026-01-0${day}T00:00:00.000Z`);
    const h = ui(true);
    expect(await pruneBackups(backups(), h)).toBe(0);
    expect(empty.confirm).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/nada que podar/i);
    expect(present()).toEqual(["a1", "a2", "a3"]);
  });

  it("never deletes a path outside the backups root or one a manifest merely points at", async () => {
    for (const day of [3, 4, 5]) snapshot(`a${day}`, "sync", `2026-01-0${day}T00:00:00.000Z`);
    write(path.join(root, "outside", "keep.bin"), "keep");
    snapshot("escape", "sync", "2026-01-01T00:00:00.000Z", path.join("..", "..", "outside"));
    snapshot("alias", "sync", "2026-01-02T00:00:00.000Z", "a5");
    const h = ui(true);
    expect(await pruneBackups(backups(), h)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "outside", "keep.bin"), "utf8")).toBe("keep");
    expect(present()).toEqual(["a3", "a4", "a5", "alias", "escape"]);
  });
});
