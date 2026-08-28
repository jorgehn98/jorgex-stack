import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  FileAction,
  InstallContext,
  SelectableRuntimeId,
  SharedProjectionAdapter,
} from "../src/adapters/types.js";
import { planCommands } from "../src/components/commands.js";
import { planSkills } from "../src/components/skills.js";
import { planSystemPrompt } from "../src/components/system-prompt.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { diffPlan } from "../src/install.js";

type PiProjectionAdapter = SharedProjectionAdapter & {
  readonly id: Extract<SelectableRuntimeId, "pi">;
};

async function loadPiAdapter(): Promise<PiProjectionAdapter> {
  const mod = await import("../src/adapters/pi.js");
  expect(mod.piAdapter).toBeDefined();
  return mod.piAdapter;
}

function planPiProjection(adapter: PiProjectionAdapter, ctx: InstallContext): FileAction[] {
  return [
    ...planSystemPrompt(adapter, ctx),
    ...planSkills(adapter, ctx),
    ...planCommands(adapter, ctx),
  ];
}

function apply(plan: FileAction[]): void {
  for (const action of plan) {
    fs.mkdirSync(path.dirname(action.target), { recursive: true });
    if (action.kind === "copy") fs.copyFileSync(action.source, action.target);
    else fs.writeFileSync(action.target, action.content);
  }
}

describe("Pi managed shared projection", () => {
  it("makes a Pi-only plan provide the missing external skills, system prompt, and lean-audit template while preserving user content and staying idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-pi-projection-"));
    const home = path.join(root, "home");
    const configDir = path.join(root, "pi-agent");
    const userPrompt = "# Local Pi policy\n\nKeep this user-owned instruction.\n";
    const userCommand = path.join(configDir, "prompts", "custom.md");

    try {
      fs.mkdirSync(path.dirname(userCommand), { recursive: true });
      fs.writeFileSync(path.join(configDir, "AGENTS.md"), userPrompt);
      fs.writeFileSync(userCommand, "# Custom command\n");

      const adapter = await loadPiAdapter();
      const paths = adapter.paths(configDir);
      const skillsDir = path.join(home, ".agents", "skills");
      const leanAudit = path.join(configDir, "prompts", "lean-audit.md");
      const ctx: InstallContext = {
        stackDir: stackRoot(),
        configDir,
        engramBin: path.join(root, "bin", "engram"),
        models: DEFAULT_MODEL_MAP.codex,
        warnings: [],
      };

      // This reproduces the Pi-only gap: the native package exists, but Stack
      // has not projected any shared resource outside it yet.
      expect(fs.existsSync(skillsDir)).toBe(false);
      expect(fs.existsSync(leanAudit)).toBe(false);
      expect(paths.systemPromptFile).toBe(path.join(configDir, "AGENTS.md"));
      expect(paths.skillsDir).toBe(skillsDir);
      expect(paths.commandsDir).toBe(path.join(configDir, "prompts"));

      const plan = planPiProjection(adapter, ctx);
      const skill = path.join(skillsDir, "agent-delegation", "SKILL.md");
      const skillAction = plan.find((action) => action.target === skill);
      const promptAction = plan.find((action) => action.target === leanAudit);
      const systemPromptAction = plan.find((action) => action.target === paths.systemPromptFile);

      expect(skillAction).toMatchObject({
        kind: "copy",
        source: path.join(ctx.stackDir, "skills", "agent-delegation", "SKILL.md"),
        target: skill,
      });
      expect(plan.filter((action) => action.kind === "copy")).not.toHaveLength(0);
      expect(promptAction).toMatchObject({ kind: "write", target: leanAudit });
      expect((promptAction as Extract<FileAction, { kind: "write" }>).content).toContain("$ARGUMENTS");
      expect((promptAction as Extract<FileAction, { kind: "write" }>).content).not.toContain("{{input}}");
      expect(systemPromptAction).toMatchObject({ kind: "write", target: paths.systemPromptFile });

      apply(plan);

      const installedPrompt = fs.readFileSync(paths.systemPromptFile, "utf8");
      expect(installedPrompt).toContain(userPrompt.trim());
      expect(installedPrompt.match(/<!-- jorgex:system-prompt -->/g)).toHaveLength(1);
      expect(fs.readFileSync(userCommand, "utf8")).toBe("# Custom command\n");

      const secondPlan = planPiProjection(adapter, { ...ctx, warnings: [] });
      expect(diffPlan(secondPlan).every(({ status }) => status === "unchanged")).toBe(true);
      expect(fs.readFileSync(paths.systemPromptFile, "utf8")).toBe(installedPrompt);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
