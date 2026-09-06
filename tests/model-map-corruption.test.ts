import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const prompts = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => prompts);

async function withTempHome<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    vi.resetModules();
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    vi.resetModules();
  }
}

function setOnlyCodexDetected(install: typeof import("../src/install.js"), configDir: string): () => void {
  const originals = Object.values(install.ADAPTERS).map((adapter) => [adapter, adapter.detect] as const);
  for (const adapter of Object.values(install.ADAPTERS)) {
    adapter.detect = () => ({
      id: adapter.id,
      name: adapter.name,
      installed: adapter.id === "codex",
      binPath: null,
      configDir: adapter.id === "codex" ? configDir : path.join(configDir, adapter.id),
    });
  }
  return () => {
    for (const [adapter, detect] of originals) adapter.detect = detect;
  };
}

describe("corrupt model-map install safety", () => {
  it("stops a file-runtime install before backups or projection can change existing configuration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-install-corrupt-model-map-"));
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".codex");
    const mapFile = path.join(homeDir, ".jorgex-stack", "model-map.json");
    const configFile = path.join(configDir, "config.toml");
    const malformed = '{"codex":\n';
    const configBefore = 'model = "user-selected"\n';
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(mapFile, malformed);
    fs.writeFileSync(configFile, configBefore);

    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const restoreDetect = setOnlyCodexDetected(install, configDir);

        try {
          await expect(install.runInstall({
            runtimes: ["codex"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
          })).rejects.toThrow(/model-map|corrige|restaura/i);

          expect(fs.readFileSync(configFile, "utf8")).toBe(configBefore);
          expect(fs.existsSync(path.join(configDir, "AGENTS.md"))).toBe(false);
          expect(fs.existsSync(path.join(homeDir, ".jorgex-stack", "backups"))).toBe(false);
        } finally {
          restoreDetect();
        }
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
