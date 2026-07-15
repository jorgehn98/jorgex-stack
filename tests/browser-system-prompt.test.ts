import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext, RuntimeId } from "../src/adapters/types.js";
import { planSystemPrompt } from "../src/components/system-prompt.js";
import { loadCanonicalHooks, loadCanonicalMcp } from "../src/lib/canonical.js";
import { upsertMarkdownSection } from "../src/lib/filemerge.js";
import { stackRoot } from "../src/lib/paths.js";
import { testModelsForRuntime } from "./fixtures/model-map.js";

const DEVTOOLS_SERVER = "chrome-devtools";
const tempDirs: string[] = [];
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

const RUNTIMES = [
  ["Claude Code", claudeCodeAdapter],
  ["Codex", codexAdapter],
  ["OpenCode", opencodeAdapter],
] as const;

const CAPABILITY_CASES = [
  { name: "none", playwright: false, devtools: false },
  { name: "Playwright", playwright: true, devtools: false },
  { name: "DevTools", playwright: false, devtools: true },
  { name: "both", playwright: true, devtools: true },
] as const;

interface BrowserPromptContext extends InstallContext {
  playwrightCliEnabled: boolean;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jx-browser-prompt-"));
  tempDirs.push(dir);
  return dir;
}

function context(adapter: Adapter, configDir: string, playwrightCliEnabled: boolean, devtoolsEnabled: boolean): BrowserPromptContext {
  return {
    stackDir: stackRoot(),
    configDir,
    mode: "human",
    subagentConcurrency: "serial",
    engramBin: null,
    models: testModelsForRuntime(adapter.id),
    warnings: [],
    enabledMcpServers: new Set(devtoolsEnabled ? [DEVTOOLS_SERVER] : []),
    playwrightCliEnabled,
  };
}

function promptContent(adapter: Adapter, ctx: BrowserPromptContext): string {
  const [action] = planSystemPrompt(adapter, ctx);
  if (action?.kind !== "write") throw new Error(`No prompt write was planned for ${adapter.id}`);
  return action.content;
}

function browserSection(content: string): string | null {
  return /<!-- jorgex:browser -->\n([\s\S]*?)\n<!-- \/jorgex:browser -->/.exec(content)?.[1] ?? null;
}

function expectCapabilities(content: string, playwright: boolean, devtools: boolean): void {
  const section = browserSection(content);
  if (!playwright && !devtools) {
    expect(section).toBeNull();
    return;
  }

  expect(section).not.toBeNull();
  if (playwright) {
    expect(section).toMatch(/Playwright CLI/i);
    expect(section).toContain("`playwright-cli` skill");
    expect(section).toMatch(/snapshot/i);
    expect(section).toMatch(/routine/i);
    expect(section).toMatch(/navigation|interaction|QA/i);
  } else {
    expect(section).not.toMatch(/Playwright CLI/i);
  }

  if (devtools) {
    expect(section).toMatch(/Chrome DevTools/i);
    expect(section).toMatch(/console/i);
    expect(section).toMatch(/network/i);
    expect(section).toMatch(/Lighthouse|performance/i);
    expect(section).toMatch(/sensitive.*bod|bod.*sensitive/i);
  } else {
    expect(section).not.toMatch(/Chrome DevTools/i);
  }
}

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

function writeOpenCodeModelMap(homeDir: string): void {
  const file = path.join(homeDir, ".jorgex-stack", "model-map.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ opencode: testModelsForRuntime("opencode") }) + "\n");
}

function setOnlyOpenCodeDetected(install: typeof import("../src/install.js"), configDir: string): () => void {
  const originals = Object.values(install.ADAPTERS).map((adapter) => [adapter, adapter.detect] as const);
  for (const adapter of Object.values(install.ADAPTERS)) {
    adapter.detect = () => ({
      id: adapter.id,
      name: adapter.name,
      installed: adapter.id === "opencode",
      binPath: null,
      configDir: adapter.id === "opencode" ? configDir : path.join(configDir, adapter.id),
    });
  }
  return () => {
    for (const [adapter, detect] of originals) adapter.detect = detect;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe.each(RUNTIMES)("%s browser prompt", (_name, adapter) => {
  it.each(CAPABILITY_CASES)("renders the $name capability matrix idempotently and preserves user text", ({ playwright, devtools }) => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    const promptFile = adapter.paths(configDir).systemPromptFile;
    const userText = "# User notes\n\nKeep this instruction.\n";
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, userText);
    const ctx = context(adapter, configDir, playwright, devtools);

    const first = promptContent(adapter, ctx);
    expect(first).toContain("Keep this instruction.");
    expectCapabilities(first, playwright, devtools);

    fs.writeFileSync(promptFile, first);
    expect(promptContent(adapter, ctx)).toBe(first);
  });

  it("removes only the browser section when both browser capabilities are disabled", () => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    const promptFile = adapter.paths(configDir).systemPromptFile;
    const userText = "# User notes\n\nKeep this instruction.\n";
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, upsertMarkdownSection(userText, "browser", "Old managed browser guidance."));

    const content = promptContent(adapter, context(adapter, configDir, false, false));
    expect(browserSection(content)).toBeNull();
    expect(content).toContain("Keep this instruction.");
    expect(content).not.toContain("Old managed browser guidance.");
  });

  it("uninstall removes the managed browser section without touching user text", () => {
    const root = tempDir();
    const configDir = path.join(root, "config");
    const promptFile = adapter.paths(configDir).systemPromptFile;
    const userText = "# User notes\n\nKeep this instruction.\n";
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, upsertMarkdownSection(userText, "browser", "Managed browser guidance."));

    const action = adapter.planUnmerge(
      loadCanonicalMcp(stackRoot()),
      loadCanonicalHooks(stackRoot()),
      context(adapter, configDir, true, true),
    ).find((candidate) => candidate.target === promptFile);
    expect(action).toMatchObject({ kind: "write" });
    const content = (action as { content: string }).content;
    expect(browserSection(content)).toBeNull();
    expect(content).toContain("Keep this instruction.");
  });
});

describe("Playwright prompt install ordering", () => {
  it.each([
    { name: "successful", toolResult: true, expectedCode: 0, announcesPlaywright: true },
    { name: "failed", toolResult: false, expectedCode: 1, announcesPlaywright: false },
  ])("$name fresh --playwright install advertises Playwright only after successful setup", async ({ toolResult, expectedCode, announcesPlaywright }) => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const configDir = path.join(homeDir, ".config", "opencode");
    writeOpenCodeModelMap(homeDir);

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const restoreDetect = setOnlyOpenCodeDetected(install, configDir);
      try {
        const code = await install.runInstall({
          runtimes: ["opencode"],
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          playwrightToolConsent: {
            command: "install",
            interactive: false,
            yes: true,
            targetDir: false,
            explicitToolSelection: true,
            confirmed: false,
          },
          playwrightToolDeps: {
            run: async () => toolResult,
            persistEnabled(enabled) {
              const preference = path.join(homeDir, ".jorgex-stack", "playwright-cli.json");
              fs.mkdirSync(path.dirname(preference), { recursive: true });
              fs.writeFileSync(preference, JSON.stringify({ version: 1, enabled }) + "\n");
            },
          },
        });

        const content = fs.readFileSync(path.join(configDir, "AGENTS.md"), "utf8");
        expect(code).toBe(expectedCode);
        expect(browserSection(content) !== null).toBe(announcesPlaywright);
        expect(content.includes("Playwright CLI")).toBe(announcesPlaywright);
      } finally {
        restoreDetect();
      }
    });
  });

  it("--target-dir never reads enabled real browser preferences into its prompt", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "home");
    const targetDir = path.join(root, "target");
    const stateDir = path.join(homeDir, ".jorgex-stack");
    writeOpenCodeModelMap(homeDir);
    fs.writeFileSync(path.join(stateDir, "playwright-cli.json"), JSON.stringify({ version: 1, enabled: true }) + "\n");
    fs.writeFileSync(
      path.join(stateDir, "devtools-mcp.json"),
      JSON.stringify({ version: 1, enabled: { opencode: true }, owned: {} }) + "\n",
    );

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const restoreDetect = setOnlyOpenCodeDetected(install, targetDir);
      try {
        await expect(install.runInstall({
          runtimes: ["opencode"],
          targetDir,
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
        })).resolves.toBe(0);

        const content = fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8");
        expect(browserSection(content)).toBeNull();
        expect(content).not.toContain("Playwright CLI");
        expect(content).not.toContain("Chrome DevTools");
      } finally {
        restoreDetect();
      }
    });
  });
});
