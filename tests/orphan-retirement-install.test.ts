import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runInstall, type NativeExecutor } from "../src/install.js";
import { readManifest } from "../src/lib/manifest.js";
import { listBackups } from "../src/lib/backup.js";
import * as detection from "../src/lib/detect.js";
import { expectedEngramAssetName } from "../src/lib/github.js";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/paths.js", async (original) => ({
  ...await original<typeof import("../src/lib/paths.js")>(),
  HOME: "/var/tmp",
  dataDir: () => path.join(isolated.root, ".jorgex-stack"),
}));

let root: string;
const configDir = () => path.join(root, "opencode");
const sharedSkills = () => path.join(root, ".agents", "skills");
const manifestPath = () => path.join(root, ".jorgex-stack", "manifest.json");

beforeEach(() => {
  root = fs.mkdtempSync("/var/tmp/jx-orphan-install-");
  isolated.root = root;
  vi.spyOn(detection, "engramVersion").mockReturnValue("3.0.0");
  vi.spyOn(detection, "opencodeMajorVersion").mockReturnValue(2);
  vi.spyOn(detection, "lookPath").mockReturnValue(null);
  vi.spyOn(p.log, "warn").mockImplementation(() => {});
  const name = expectedEngramAssetName("3.0.0", process.platform, process.arch);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v3.0.0", assets: [{
    name, state: "uploaded", size: 1, digest: `sha256:${"0".repeat(64)}`,
    browser_download_url: `https://github.com/Gentleman-Programming/engram/releases/download/v3.0.0/${name}`,
  }] }))));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Apply the projection into an isolated config directory; native commands are inert. */
async function apply(): Promise<number> {
  const execute: NativeExecutor = () => "";
  const bin = path.join(root, "fake-engram");
  fs.writeFileSync(bin, "");
  return runInstall({
    runtimes: ["opencode"], dryRun: false, yes: true, engramBin: bin, execute,
    verifyEngram: async () => true,
    detect: () => ({ id: "opencode", name: "opencode", installed: true, binPath: "/fake/opencode", configDir: configDir() }),
  });
}

/** Records an owned path for a runtime other than the one being applied. */
function ownAsOtherRuntime(file: string) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
  manifest.runtimes.codex = {
    configDir: path.join(root, "codex"),
    updatedAt: new Date().toISOString(),
    owned: [...(manifest.runtimes.codex?.owned ?? []), file],
  };
  manifest.runtimes.opencode.owned = [...(manifest.runtimes.opencode?.owned ?? []), file];
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest));
}

it("retira un archivo compartido que ya no está en el canon aunque otro runtime lo tenga", async () => {
  expect(await apply()).toBe(0);
  const orphan = path.join(sharedSkills(), "one", "retired.py");
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, "print('vueltas')\n");
  ownAsOtherRuntime(orphan);

  expect(await apply()).toBe(0);

  expect(fs.existsSync(orphan)).toBe(false);
  const manifest = readManifest(manifestPath());
  expect(manifest.runtimes.opencode?.owned ?? []).not.toContain(orphan);
  expect(manifest.runtimes.codex?.owned ?? []).not.toContain(orphan);

  const retired = listBackups(path.join(root, ".jorgex-stack", "backups")).find((entry) => entry.id.endsWith("-retired-opencode"));
  expect(retired?.files.map((file) => file.original)).toContain(orphan);
});

it("conserva un archivo de la configuración privada que otro runtime todavía declara", async () => {
  expect(await apply()).toBe(0);
  const foreign = path.join(configDir(), "stale.json");
  fs.writeFileSync(foreign, "{}\n");
  ownAsOtherRuntime(foreign);

  expect(await apply()).toBe(0);

  expect(fs.existsSync(foreign)).toBe(true);
});
