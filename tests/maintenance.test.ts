import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackup, listBackups, restoreBackup } from "../src/lib/backup.js";
import { findOrphans, readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { isContainedIn, writeText } from "../src/lib/fsx.js";
import { readTomlSection } from "../src/lib/filemerge.js";
import { planPlugins } from "../src/components/plugins.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import * as modelMap from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { runInstall } from "../src/install.js";
import { planCommands } from "../src/components/commands.js";
import { planSkills } from "../src/components/skills.js";
import { OPEN_CODE_TEST_MODELS, TEST_MODEL_MAP } from "./fixtures/model-map.js";

let tmp: string;

const readStackFile = (relativePath: string) =>
  fs.readFileSync(path.join(stackRoot(), relativePath), "utf8");

const readRequiredStackFile = (relativePath: string) => {
  const absolutePath = path.join(stackRoot(), relativePath);
  expect(fs.existsSync(absolutePath), `falta el contrato canónico ${relativePath}`).toBe(true);
  return fs.readFileSync(absolutePath, "utf8");
};

const readStandardOrchestratorWorkflow = () =>
  readRequiredStackFile("skills/orchestrator/references/standard-workflow.md");

const sectionBetween = (content: string, start: string, end: string): string => {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
};

const expectFragments = (content: string, fragments: string[]) => {
  for (const fragment of fragments) {
    expect(content).toContain(fragment);
  }
};

const expectFragmentsInOrder = (content: string, fragments: string[]) => {
  let cursor = 0;
  for (const fragment of fragments) {
    const index = content.indexOf(fragment, cursor);
    expect(index).toBeGreaterThanOrEqual(cursor);
    cursor = index + fragment.length;
  }
};

const REVIEW_ENTRYPOINT_CASES = [
  {
    relativePath: "skills/xreview/SKILL.md",
    contractFragments: [
      "4R internally",
      "comment-fixer",
      "test-analyzer",
      "silent-failure-hunter",
      "type-design-analyzer",
      "code-reviewer",
      "code-simplifier",
      "security-auditor",
      "not add a separate 4R section or taxonomy",
    ],
  },
] as const;

const FOUR_R_LENS_CASES = [
  {
    relativePath: "agents/security-auditor.md",
    header: "## 4R Risk Lens",
    fragments: ["auth, authorization, secrets, sensitive data, input validation, webhooks", "input validation", "Webhooks & external callbacks"],
  },
  {
    relativePath: "agents/code-simplifier.md",
    header: "## 4R Readability Lens",
    fragments: ["nested ternary operators", "guard clauses", "readability/maintainability"],
  },
  {
    relativePath: "agents/test-analyzer.md",
    header: "## 4R Reliability Lens",
    fragments: [
      "actual evidence",
      "accidental `test.only`/exclusive-focus slips",
      "implementation-coupled tests",
      "behavioral coverage rather than line coverage",
    ],
  },
  {
    relativePath: "agents/silent-failure-hunter.md",
    header: "## 4R Resilience Lens",
    fragments: ["fallback, retry, degradation", "rollback", "fix-forward behavior"],
  },
] as const;

const XREVIEW_CONTEXT_AGENT_CASES = [
  { relativePath: "agents/code-reviewer.md", scopeFragment: "**Get the diff.**" },
  { relativePath: "agents/test-analyzer.md", scopeFragment: "**Get the diff.**" },
  { relativePath: "agents/silent-failure-hunter.md", scopeFragment: "**Get the diff.**" },
  { relativePath: "agents/type-design-analyzer.md", scopeFragment: "**Resolve scope.**" },
  { relativePath: "agents/code-simplifier.md", scopeFragment: "**Resolve scope.**" },
  { relativePath: "agents/security-auditor.md", scopeFragment: "**Get the diff.**" },
] as const;

const MULTI_PR_LIFECYCLE_CASES = [
  {
    relativePath: "skills/work-lifecycle/SKILL.md",
    fragments: [
      "PR checkpoint outcome",
      "Final work close",
      "work/{name}/pr/{NN}",
      "work/{name}/done",
      "PR status/evidence lives ONLY in the PR roadmap table.",
      "For multi-PR work, resume from the first PR/task not done in the roadmap/table.",
      "For single-PR work, the PR checkpoint and final work close happen together: one merge, one `work/{name}/done`, then cleanup.",
    ],
  },
  {
    relativePath: "skills/orchestrator/SKILL.md",
    fragments: [
      "For multi-PR work, each merge is a checkpoint; keep `work/{name}/PRD.md` and `plan.md` alive until the roadmap is finished.",
      "Phase outcomes, decisions and PR checkpoints → Engram under `work/{name}/{phase}` and `work/{name}/pr/{NN}`",
      "After each intermediate merge: persist the checkpoint to `work/{name}/pr/{NN}`",
    ],
  },
  {
    relativePath: "system-prompt/engram-protocol.md",
    fragments: [
      "PR checkpoints",
      "final outcome in `work/{name}/done` only after the last PR",
    ],
  },
  {
    relativePath: "skills/work-lifecycle/references/plan-template.md",
    fragments: [
      "## PR Roadmap",
      "This is the live PR-level board: scope, PR status, and merge evidence live here.",
      "Task-level status stays in the task table below.",
      "Full checkpoint history lives in Engram under `work/[name]/pr/[NN]`.",
      "| PR | Scope | Branch | Worktree | Base | Status | Merge evidence |",
      "Task status lives ONLY in this table",
      "PR status/evidence lives in the PR Roadmap above.",
      "| # | PR | Agent | Scope | Spec | Task | One-liner | SC | Status | Wave | Deps |",
    ],
  },
  {
    relativePath: "skills/to-prd/SKILL.md",
    fragments: [
      "## Delivery / PR Roadmap",
      "Live status, checkpoints, and task progress belong in `plan.md`.",
      "Keep this static: describe the planned delivery slices, not the current state.",
    ],
  },
] as const;

const DESTRUCTIVE_GIT_ESCALATION_CASES = [
  ["implementer", "agents/implementer.md"],
  ["tester", "agents/tester.md"],
  ["translator", "agents/translator.md"],
] as const;

const EXACT_SEMVER = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const EXACT_PACKAGE_SPEC = new RegExp(`^(?:@[^/\\s]+/[^@\\s]+|[^@\\s]+)@${EXACT_SEMVER}$`);
const PINNED_PLAYWRIGHT_DLX = "pnpm dlx @playwright/cli@0.1.18 --version";

const listFilesRecursively = (root: string): string[] =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(absolutePath) : [absolutePath];
  });

const mutableRuntimeViolations = (): string[] => {
  const skillsRoot = path.join(stackRoot(), "skills");
  const violations: string[] = [];

  for (const file of listFilesRecursively(skillsRoot)) {
    const relativePath = path.relative(stackRoot(), file).replace(/\\/g, "/");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      const location = `${relativePath}:${index + 1}`;
      if (/@latest\b/i.test(line)) violations.push(`${location}: @latest: ${line.trim()}`);
      if (/\bnpx\b/i.test(line)) violations.push(`${location}: npx: ${line.trim()}`);
      if (/\bnpm\s+(?:install|i|exec|run)\b/i.test(line)) {
        violations.push(`${location}: npm command: ${line.trim()}`);
      }
      if (/\bpnpm\s+create\b/i.test(line)) {
        violations.push(`${location}: mutable pnpm create: ${line.trim()}`);
      }
      if (/\b(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?pip(?:3(?:\.\d+)?)?\s+install\b/i.test(line)) {
        violations.push(`${location}: mutable pip install: ${line.trim()}`);
      }

      for (const match of line.matchAll(/\bpnpm\s+dlx\s+(\S+)/gi)) {
        if (!EXACT_PACKAGE_SPEC.test(match[1]!)) {
          violations.push(`${location}: unpinned pnpm dlx package: ${match[1]}`);
        }
      }
    });

    if (path.basename(file) === "requirements.txt") {
      lines.forEach((line, index) => {
        const requirement = line.trim();
        if (!requirement || requirement.startsWith("#")) return;
        if (!/^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?==[^<>=!~;\s]+(?:\s*;.*)?$/.test(requirement)) {
          violations.push(`${relativePath}:${index + 1}: non-exact Python requirement: ${requirement}`);
        }
      });
    }
  }

  return violations;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-maint-"));
  vi.spyOn(modelMap, "loadModelMap").mockReturnValue(TEST_MODEL_MAP);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("backup: dedup de snapshots idénticos", () => {
  it("reutiliza el backup más reciente si el contenido no ha cambiado", () => {
    const file = path.join(tmp, "config.json");
    writeText(file, '{"a":1}\n');
    const root = path.join(tmp, "backups");

    const first = createBackup([file], "install-test", root)!;
    const second = createBackup([file], "uninstall-test", root)!;
    expect(second.id).toBe(first.id);
    expect(listBackups(root)).toHaveLength(1);
  });

  it("crea un backup nuevo cuando el contenido cambia", () => {
    const file = path.join(tmp, "config.json");
    const root = path.join(tmp, "backups");
    writeText(file, '{"a":1}\n');
    const first = createBackup([file], "t", root)!;
    writeText(file, '{"a":2}\n');
    const second = createBackup([file], "t", root)!;
    expect(second.id).not.toBe(first.id);
    expect(listBackups(root)).toHaveLength(2);
  });
});

describe("permisos por defecto: lectura externa sin write-anywhere", () => {
  const makeCtx = (id: "opencode" | "codex") => ({
    stackDir: stackRoot(),
    configDir: tmp,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[id]!,
    warnings: [],
  });
  const mcp = () => loadCanonicalMcp(stackRoot());

  it("opencode: la config fresca abre lectura externa y reglas read/env, pero no write-anywhere", () => {
    const [action] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const fresh = JSON.parse((action as { content: string }).content);
    expect(fresh.permission).toMatchObject({
      external_directory: { "*": "allow" },
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
      webfetch: "ask",
      websearch: "ask",
      bash: {
        "*": "ask",
        "git diff*": "ask",
        "rm *": "ask",
        "del *": "ask",
        "rmdir *": "ask",
        "git push --force*": "ask",
        "format *": "deny",
        "mkfs *": "deny",
        "dd *": "deny",
        "shred *": "deny",
      },
    });
    expect(fresh.permission.edit).not.toBe("allow");
    expect(fresh.permission.bash["*"]).not.toBe("allow");
    expect(fresh.permission.bash["git diff*"]).not.toBe("allow");
    expect(fresh.permission.webfetch).not.toBe("allow");
    expect(fresh.permission.websearch).not.toBe("allow");
  });

  it("opencode: una config no vacía sin permission no recibe permission", () => {
    writeText(path.join(tmp, "opencode.json"), JSON.stringify({ other: true }));

    const [action] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const config = JSON.parse((action as { content: string }).content) as Record<string, unknown>;

    expect(config.other).toBe(true);
    expect(config).not.toHaveProperty("permission");
  });

  it("opencode: la config fresca también avisa y deniega stores de secretos más amplios", () => {
    const ctx = makeCtx("opencode");
    const [action] = opencodeAdapter.planMainConfig(mcp(), ctx);
    const fresh = JSON.parse((action as { content: string }).content);
    const readRules = fresh.permission.read as Record<string, string>;

    expect(Object.keys(readRules)).toEqual(
      expect.arrayContaining([
        "*",
        "*.env",
        "*.env.*",
        "*.env.example",
        "*/.ssh/*",
        "*/.aws/credentials",
        "*/.npmrc",
        "*/.git-credentials",
        "*/id_rsa",
        "*/id_ed25519",
        "*.pem",
        "*.key",
      ]),
    );
    expect(ctx.warnings.join("\n")).toMatch(/read-anywhere|broad/i);
  });

  it("opencode: deja intacta la config custom y no auto-migra el legacy exacto", () => {
    writeText(path.join(tmp, "opencode.json"), JSON.stringify({ permission: { edit: "deny", read: "ask" } }));
    const [custom] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    expect(JSON.parse((custom as { content: string }).content).permission).toEqual({ edit: "deny", read: "ask" });

    writeText(
      path.join(tmp, "opencode.json"),
      JSON.stringify({
        permission: {
          edit: "allow",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          lsp: "allow",
          webfetch: "allow",
          websearch: "allow",
          bash: {
            "*": "allow",
            "rm *": "ask",
            "del *": "ask",
            "rmdir *": "ask",
            "git push --force*": "ask",
            "format *": "deny",
            "mkfs *": "deny",
            "dd *": "deny",
            "shred *": "deny",
          },
        },
      }),
    );

    const [legacy] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const migrated = JSON.parse((legacy as { content: string }).content);
    expect(migrated.permission).toEqual({
      edit: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      webfetch: "allow",
      websearch: "allow",
      bash: {
        "*": "allow",
        "rm *": "ask",
        "del *": "ask",
        "rmdir *": "ask",
        "git push --force*": "ask",
        "format *": "deny",
        "mkfs *": "deny",
        "dd *": "deny",
        "shred *": "deny",
      },
    });
    expect(migrated.permission.external_directory).toBeUndefined();
    expect(migrated.permission.read).toBe("allow");
  });

  it("opencode: el legacy exacto no se auto-migra ni avisa", () => {
    writeText(
      path.join(tmp, "opencode.json"),
      JSON.stringify({
        permission: {
          edit: "allow",
          read: "allow",
          glob: "allow",
          grep: "allow",
          list: "allow",
          lsp: "allow",
          webfetch: "allow",
          websearch: "allow",
          bash: {
            "*": "allow",
            "rm *": "ask",
            "del *": "ask",
            "rmdir *": "ask",
            "git push --force*": "ask",
            "format *": "deny",
            "mkfs *": "deny",
            "dd *": "deny",
            "shred *": "deny",
          },
        },
      }),
    );

    const ctx = { ...makeCtx("opencode"), engramBin: "/opt/engram" };
    const [legacy] = opencodeAdapter.planMainConfig(mcp(), ctx);
    const migrated = JSON.parse((legacy as { content: string }).content);

    expect(migrated.permission).toEqual({
      edit: "allow",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      webfetch: "allow",
      websearch: "allow",
      bash: {
        "*": "allow",
        "rm *": "ask",
        "del *": "ask",
        "rmdir *": "ask",
        "git push --force*": "ask",
        "format *": "deny",
        "mkfs *": "deny",
        "dd *": "deny",
        "shred *": "deny",
      },
    });
    expect(migrated.permission.external_directory).toBeUndefined();
    expect(ctx.warnings.join("\n")).not.toMatch(/external\s+directory|read-anywhere|external edits/i);
  });

  it("codex: la config fresca publica jorgex-read-anywhere sin sandbox_mode", () => {
    const ctx = makeCtx("codex");
    const [action] = codexAdapter.planMainConfig(mcp(), ctx);
    const fresh = (action as { content: string }).content;
    expect(fresh).toContain('approval_policy = "on-request"');
    expect(fresh).toContain('default_permissions = "jorgex-read-anywhere"');
    expect(fresh).toContain("[permissions.jorgex-read-anywhere]");
    expect(fresh).toContain(":workspace");
    expect(fresh).toContain("*.env");
    expect(fresh).not.toContain('sandbox_mode = "workspace-write"');
    expect(readTomlSection(fresh, "permissions.jorgex-read-anywhere")?.trimEnd()).toBe('extends = ":workspace"');
    expect(readTomlSection(fresh, "permissions.jorgex-read-anywhere.filesystem")?.trimEnd()).toBe(
      '":root" = "read"\n"*.env" = "deny"\n"*.env.*" = "deny"\n"~/.ssh/**" = "deny"\n"~/.aws/credentials" = "deny"\n"~/.npmrc" = "deny"\n"~/.git-credentials" = "deny"\n"**/id_rsa" = "deny"\n"**/id_ed25519" = "deny"\n"**/*.pem" = "deny"\n"**/*.key" = "deny"',
    );
    expect(readTomlSection(fresh, 'permissions.jorgex-read-anywhere.filesystem.:workspace_roots')?.trimEnd()).toBe(
      '"." = "write"\n"*.env" = "deny"\n"*.env.*" = "deny"\n".ssh/**" = "deny"\n".aws/credentials" = "deny"\n".npmrc" = "deny"\n".git-credentials" = "deny"\n"**/id_rsa" = "deny"\n"**/id_ed25519" = "deny"\n"**/*.pem" = "deny"\n"**/*.key" = "deny"',
    );
    expect(fresh).toContain(".ssh");
    expect(fresh).toContain(".aws/credentials");
    expect(fresh).toContain(".npmrc");
    expect(fresh).toContain(".git-credentials");
    expect(fresh).toContain("id_rsa");
    expect(fresh).toContain("id_ed25519");
    expect(fresh).toContain("*.pem");
    expect(fresh).toContain("*.key");
    expect(ctx.warnings.join("\n")).toMatch(/read-anywhere|broad/i);
  });

  it("codex: una config no vacía sin default_permissions ni [permissions.*] no recibe el perfil", () => {
    writeText(path.join(tmp, "config.toml"), 'other = "value"\n');

    const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const content = (action as { content: string }).content;

    expect(content).toContain('other = "value"');
    expect(content).not.toContain('default_permissions = "jorgex-read-anywhere"');
    expect(readTomlSection(content, "permissions.jorgex-read-anywhere")).toBeNull();
  });

  it("codex: la config custom conserva default_permissions y no auto-migra el perfil", () => {
    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\ndefault_permissions = "custom"\nsandbox_mode = "workspace-write"\n');
    const [action2] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const existing = (action2 as { content: string }).content;
    expect(existing).toContain('approval_policy = "never"');
    expect(existing).toContain('default_permissions = "custom"');
    expect(existing).toContain('sandbox_mode = "workspace-write"');
    expect(existing).not.toContain('[permissions.jorgex-read-anywhere]');
  });

  it.each(["read-only", "danger-full-access"] as const)(
    "codex: sandbox_mode %s sin permisos no deja un default_permissions colgando",
    (sandboxMode) => {
      writeText(path.join(tmp, "config.toml"), `approval_policy = "never"\nsandbox_mode = "${sandboxMode}"\n`);

      const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
      const content = (action as { content: string }).content;

      expect(content).toContain(`sandbox_mode = "${sandboxMode}"`);
      expect(content).not.toContain('default_permissions = "jorgex-read-anywhere"');
      expect(content).not.toContain('[permissions.jorgex-read-anywhere]');
    },
  );

  it("codex: sandbox_mode con comentario inline se respeta como sandbox custom y no activa el perfil jorgex", () => {
    writeText(
      path.join(tmp, "config.toml"),
      'approval_policy = "never"\nsandbox_mode = "read-only" # custom\n',
    );

    const custom = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(custom).toContain('sandbox_mode = "read-only" # custom');
    expect(custom).not.toContain('default_permissions = "jorgex-read-anywhere"');
    expect(custom).not.toContain('[permissions.jorgex-read-anywhere]');
  });

  it("codex: la config con [permissions.custom] no recibe default_permissions ni el perfil jorgex", () => {
    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\n[permissions.custom]\nallow = ["Read"]\n');
    const custom = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(custom).toContain('approval_policy = "never"');
    expect(custom).toContain('[permissions.custom]');
    expect(custom).not.toContain('default_permissions = "jorgex-read-anywhere"');
    expect(custom).not.toContain('[permissions.jorgex-read-anywhere]');

    writeText(path.join(tmp, "config.toml"), 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');

    const [legacy] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const preserved = (legacy as { content: string }).content;
    expect(preserved).toContain('approval_policy = "on-request"');
    expect(preserved).toContain('sandbox_mode = "workspace-write"');
    expect(preserved).not.toContain('default_permissions = "jorgex-read-anywhere"');
    expect(preserved).not.toContain("[permissions.jorgex-read-anywhere]");
  });

  it("codex: el legacy workspace-write con comentario inline se preserva sin perfil jorgex", () => {
    writeText(
      path.join(tmp, "config.toml"),
      'approval_policy = "on-request"\nsandbox_mode = "workspace-write" # old default\n',
    );

    const preserved = (codexAdapter.planMainConfig(mcp(), makeCtx("codex"))[0] as { content: string }).content;
    expect(preserved).toContain('approval_policy = "on-request"');
    expect(preserved).toContain('sandbox_mode = "workspace-write" # old default');
    expect(preserved).not.toContain('default_permissions = "jorgex-read-anywhere"');
    expect(preserved).not.toContain("[permissions.jorgex-read-anywhere]");
  });
});

describe("planPlugins: placeholders resueltos", () => {
  it("engram.ts recibe el protocolo canónico y el binario, sin placeholders", async () => {
    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: "C:\\bin\\engram.exe",
      models: OPEN_CODE_TEST_MODELS,
      warnings: [],
    };
    const actions = planPlugins(opencodeAdapter, ctx);
    const engram = actions.find((a) => a.target.endsWith("engram.ts"))!;
    expect(engram.kind).toBe("write");
    const content = (engram as { content: string }).content;
    expect(content).toContain("Engram Memory Protocol"); // protocolo canónico inyectado
    expect(content).toContain("engram.exe");
    expect(content).not.toContain("{{ENGRAM_PROTOCOL}}");
    expect(content).not.toContain("{{ENGRAM_BIN}}");
  });
});

describe("planPlugins: Goal Mode de OpenCode", () => {
  it("copia goal-plugin.ts y el subdirectorio goal/* de forma recursiva", () => {
    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: null,
      models: OPEN_CODE_TEST_MODELS,
      warnings: [],
    };
    const actions = planPlugins(opencodeAdapter, ctx);
    const pluginRoot = path.join(tmp, "plugins");
    const targets = actions.map((action) => path.relative(pluginRoot, action.target).replace(/\\/g, "/"));

    expect(targets).toContain("goal-plugin.ts");
    expect(targets).toContain("goal/command.ts");
    expect(targets).toContain("goal/store.ts");
    expect(targets).not.toContain("package.json");
  });

  it("install/sync con --target-dir escribe el árbol Goal Mode de forma idempotente", async () => {
    const targetDir = path.join(tmp, "opencode-target");

    await expect(runInstall({
      runtimes: ["opencode"],
      targetDir,
      dryRun: false,
      yes: true,
    })).resolves.toBe(0);

    const installedFiles = [
      path.join(targetDir, "commands", "goal.md"),
      path.join(targetDir, "plugins", "goal-plugin.ts"),
      path.join(targetDir, "plugins", "goal", "db.ts"),
      path.join(targetDir, "plugins", "goal", "store.ts"),
      path.join(targetDir, "plugins", "goal", "opencode-hooks.ts"),
    ];
    for (const file of installedFiles) {
      expect(fs.existsSync(file)).toBe(true);
    }

    await expect(runInstall({
      runtimes: ["opencode"],
      targetDir,
      dryRun: false,
      yes: true,
    })).resolves.toBe(0);
    for (const file of installedFiles) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it("reescribe los imports locales .js a .ts y permite importar el árbol instalado", async () => {
    const targetDir = path.join(tmp, "opencode-smoke");

    await expect(runInstall({
      runtimes: ["opencode"],
      targetDir,
      dryRun: false,
      yes: true,
    })).resolves.toBe(0);

    const goalPlugin = fs.readFileSync(path.join(targetDir, "plugins", "goal-plugin.ts"), "utf8");
    expect(goalPlugin).toContain('from "./goal/store.ts"');
    expect(goalPlugin).toContain('from "./goal/opencode-hooks.ts"');
    expect(goalPlugin).not.toContain('.js"');

    const goalUrl = pathToFileURL(path.join(targetDir, "plugins", "goal-plugin.ts")).href;
    const engramUrl = pathToFileURL(path.join(targetDir, "plugins", "engram.ts")).href;
    const smoke = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(goalUrl)}); await import(${JSON.stringify(engramUrl)}); console.log("ok");`,
      ],
      { encoding: "utf8" },
    );

    expect(smoke.trim()).toBe("ok");
  });

  it.each(
    [
      ["claude-code", claudeCodeAdapter],
      ["codex", codexAdapter],
    ] as const,
  )("no planifica plugins locales para %s", (_id, adapter) => {
    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: null,
      models: DEFAULT_MODEL_MAP[adapter.id]!,
      warnings: [],
    };
    expect(planPlugins(adapter, ctx)).toEqual([]);
  });
});

describe("planCommands: comandos específicos por runtime", () => {
  const makeCtx = (adapterId: "opencode" | "claude-code" | "codex") => ({
    stackDir: stackRoot(),
    configDir: tmp,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[adapterId]!,
    warnings: [],
  });

  it("instala /goal solo en OpenCode", () => {
    const opencodeTargets = planCommands(opencodeAdapter, makeCtx("opencode"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));
    expect(opencodeTargets).toContain("commands/goal.md");

    const claudeTargets = planCommands(claudeCodeAdapter, makeCtx("claude-code"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));
    expect(claudeTargets).not.toContain("commands/goal.md");

    const codexTargets = planCommands(codexAdapter, makeCtx("codex"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));
    expect(codexTargets).not.toContain("skills/goal/SKILL.md");
  });

  it("instala wrappers de /xreview en Claude/OpenCode y deja Codex usar la skill portable", () => {
    const opencodeTargets = planCommands(opencodeAdapter, makeCtx("opencode"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));
    const claudeTargets = planCommands(claudeCodeAdapter, makeCtx("claude-code"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));
    const codexTargets = planCommands(codexAdapter, makeCtx("codex"))
      .map((action) => path.relative(tmp, action.target).replace(/\\/g, "/"));

    expect(opencodeTargets).toContain("commands/xreview.md");
    expect(claudeTargets).toContain("commands/xreview.md");
    expect(codexTargets).not.toContain("skills/xreview/SKILL.md");

    for (const [adapter, id] of [
      [opencodeAdapter, "opencode"],
      [claudeCodeAdapter, "claude-code"],
      [codexAdapter, "codex"],
    ] as const) {
      const ctx = makeCtx(id);
      const expectedTarget = path.join(adapter.paths(ctx.configDir).skillsDir, "xreview", "SKILL.md");
      expect(planSkills(adapter, ctx).some((action) => action.target === expectedTarget)).toBe(true);
    }
  });
});

describe("renderCommand de OpenCode", () => {
  it("traduce {{input}} a $ARGUMENTS (placeholder oficial de OpenCode)", () => {
    const out = opencodeAdapter.renderCommand("xreview.md", "Review.\n\nInput: {{input}}\n");
    expect(out.content).toContain("$ARGUMENTS");
    expect(out.content).not.toContain("{{input}}");
  });
});

describe("lean integration: artefactos canónicos del stack", () => {
  it("incluye lean-code y lean-audit bajo stack/ y los publica en el paquete", () => {
    const root = stackRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "..", "package.json"), "utf8")) as { files?: string[] };

    expect(pkg.files).toContain("stack");

    const skill = path.join(root, "skills", "lean-code", "SKILL.md");
    const command = path.join(root, "commands", "lean-audit.md");

    expect(fs.existsSync(skill)).toBe(true);
    expect(fs.existsSync(command)).toBe(true);
    expect(fs.readFileSync(skill, "utf8")).toContain("name: lean-code");
    expect(fs.readFileSync(command, "utf8")).toContain("description: Manual read-only lean audit");
  });
});

describe("Goal Mode runtime version contract", () => {
  it("mantiene alineados Node >=22.5, tsup node22 y la documentación", () => {
    const root = path.join(stackRoot(), "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const tsup = fs.readFileSync(path.join(root, "tsup.config.ts"), "utf8");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

    expect(pkg.engines?.node).toBe(">=22.5");
    expect(tsup).toContain('target: "node22"');
    expect(readme).toContain("Node >= 22.5");
  });
});

describe("contrato upstreams.json ↔ skills vendorizadas", () => {
  it("cada skill registrada tiene carpeta local stack/skills/<name> y source no vacío", () => {
    const root = path.join(stackRoot(), "..");
    const upstreams = JSON.parse(fs.readFileSync(path.join(root, "upstreams.json"), "utf8")) as {
      skills: Record<string, { source?: string }>;
    };
    for (const [name, info] of Object.entries(upstreams.skills)) {
      expect(fs.existsSync(path.join(stackRoot(), "skills", name)), `falta stack/skills/${name}`).toBe(true);
      expect(typeof info.source === "string" && info.source.length > 0, `${name} sin source`).toBe(true);
    }
  });

  it("vende Playwright CLI 0.1.18 completo, con pin y guía pnpm coherentes", () => {
    const root = path.join(stackRoot(), "..");
    const upstreams = JSON.parse(fs.readFileSync(path.join(root, "upstreams.json"), "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
    };
    const skillFiles = [
      "SKILL.md",
      "references/element-attributes.md",
      "references/playwright-tests.md",
      "references/request-mocking.md",
      "references/running-code.md",
      "references/session-management.md",
      "references/storage-state.md",
      "references/test-generation.md",
      "references/tracing.md",
      "references/video-recording.md",
    ];
    const unmodifiedOfficialFiles = {
      "references/element-attributes.md": "bf19aa4671e0a50a0fefa9c790f39124e803060eefe395042b723c29fcb7faa2",
      "references/request-mocking.md": "54e801c9663fc2b6d68ceb058cb1c360724c2499f42acc7852a68e83e5b5f37c",
      "references/running-code.md": "d95c539a5990b71d02d8bdf1d9414df16191eb6cff95b0063820518b7a13dcb2",
      "references/session-management.md": "cd3e261b8763bf952f1e371b876cb78d054379afec85482f9250633e1b7e6c44",
      "references/storage-state.md": "9ac47f9ae4a1aedcd2077f8ac9ab1ba6bee1962cb83ff51adcd36fb6d83b5ec6",
      "references/tracing.md": "792e0ac7705e56ac48df84c0f5400221ce86107897c671590a64a4ea6a82508e",
      "references/video-recording.md": "8555ab5400df0d90e66318aacc0a8a4418fbf872e7463824d55d5c41615abd83",
    };
    const skillRoot = path.join(stackRoot(), "skills", "playwright-cli");

    expect(fs.existsSync(path.join(stackRoot(), "skills", "agent-browser"))).toBe(false);
    expect(upstreams.skills["playwright-cli"]).toMatchObject({
      source: "github:microsoft/playwright-cli",
      path: "skills/playwright-cli",
      package: "@playwright/cli",
      binary: "playwright-cli",
      version: "0.1.18",
      commit: "2f85a94b7b885dbf4a5d34462f253a8746a690c9",
      license: "Apache-2.0",
      modified: true,
    });

    for (const relativePath of skillFiles) {
      expect(fs.existsSync(path.join(skillRoot, relativePath)), `falta ${relativePath}`).toBe(true);
    }

    for (const [relativePath, expectedHash] of Object.entries(unmodifiedOfficialFiles)) {
      const content = fs.readFileSync(path.join(skillRoot, relativePath));
      expect(createHash("sha256").update(content).digest("hex"), `${relativePath} diverge del commit oficial`).toBe(expectedHash);
    }

    const content = skillFiles.map((relativePath) => fs.readFileSync(path.join(skillRoot, relativePath), "utf8")).join("\n");
    expect(content).not.toMatch(/\b(?:npm|npx)\b/i);
    expect(content).toContain("pnpm dlx @playwright/cli@0.1.18");
    expect(content).toContain("pnpm add --global @playwright/cli@0.1.18");

    const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8"))?.[0];
    expect(frontmatter).toBe(
      "---\nname: playwright-cli\ndescription: Automate browser interactions, test web pages and work with Playwright tests.\nallowed-tools: Bash(playwright-cli:*)\n---\n",
    );
    expect(frontmatter).not.toContain("Bash(pnpm:*)");
  });
});

describe("skills distribuidas: ejecución reproducible", () => {
  it("rechaza gestores mutables y dependencias sin versión exacta", () => {
    expect(mutableRuntimeViolations()).toEqual([]);

    const playwright = readStackFile("skills/playwright-cli/SKILL.md");
    expect(playwright.match(/pnpm dlx @playwright\/cli@\S+ --version/g)).toEqual([PINNED_PLAYWRIGHT_DLX]);
  });

  it("find-skills se limita a descubrir y no instruye instalar, actualizar o inicializar", () => {
    const content = readStackFile("skills/find-skills/SKILL.md");

    expect(content).toMatch(/discover/i);
    expect(content).not.toMatch(
      /\b(?:skills\s+(?:add|update|init)|offer to install|install with|to install it|install command)\b/i,
    );
  });

  it.each([
    ["React Doctor", "skills/react-doctor/SKILL.md"],
    ["deploy-to-vercel", "skills/deploy-to-vercel/SKILL.md"],
  ])("%s exige una herramienta preinstalada y no intenta instalarla", (_name, relativePath) => {
    const content = readStackFile(relativePath);

    expect(content).not.toMatch(/\b(?:npx|npm\s+(?:install|i|exec)|pnpm\s+(?:add|dlx)|yarn\s+add|bunx)\b/i);
  });
});

describe("lean integration: prompt wiring", () => {
  it("code-simplifier carga lean-code y admite audit scope", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "code-simplifier.md"), "utf8");

    expect(content).toContain("Use the `lean-code` skill as your anti-bloat lens");
    expect(content).toMatch(/explicit repo\/path audit stays within that audit target, not a default diff/i);
    expect(content).toContain("Load the `lean-code` skill.");
  });

  it("implementer aplica lean-code antes de añadir código no trivial", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "implementer.md"), "utf8");

    expect(content).toContain("Load `lean-code` before non-trivial code");
    expect(content).toContain("Ask whether the code is needed at all");
  });

  it("orchestrator usa lean-code como gate de alcance", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "skills", "orchestrator", "SKILL.md"), "utf8");

    expect(content).toContain("Apply the `lean-code` skill as a scope gate");
    expect(content).toContain("whether the smallest obvious change is enough");
  });

  it("lean-code conserva los cuatro guardarraíles aprobados y el routing global", () => {
    const leanCode = readStackFile("skills/lean-code/SKILL.md");

    expectFragments(leanCode, [
      "understand the touched flow and caller impact",
      "symptom from root cause",
      "shared seam",
      "line-count-only code golf",
      "clarity/correctness",
    ]);
    expectFragmentsInOrder(leanCode, [
      "ceiling",
      "revisit trigger",
      "exactly one existing tracking home",
      "current task",
      "an issue",
      "project's backlog",
      "Do not create a parallel",
      "ledger",
    ]);

    const globalPrompt = readStackFile("system-prompt/AGENTS.md");
    expectFragmentsInOrder(globalPrompt, [
      "For code-bearing tasks",
      "load the `lean-code` skill",
      "before deciding scope or implementation.",
    ]);
    expect(globalPrompt.match(/\blean-code\b/g)).toHaveLength(1);
    for (const leanBodyMarker of [
      "# Lean Code",
      "Work top-down. Stop as soon as a step solves it:",
      "Before adding a new helper, wrapper, abstraction, or dependency, run the ladder again.",
      "Rank findings as:",
    ]) {
      expect(globalPrompt).not.toContain(leanBodyMarker);
    }
  });

  it("type-design-analyzer limita el audit scope a contratos/tipos", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "type-design-analyzer.md"), "utf8");

    expect(content).toMatch(/explicit repo\/path audit targets its type\/interface\/schema\/contract definitions, not a default diff/i);
    expect(content).toMatch(/primary definitions and only the supporting usages needed for their invariants/i);
  });
});

describe("worktree workflow contract", () => {
  it("keeps the canonical project-local worktree rule in every operational prompt", () => {
    const fragments = [
      "git rev-parse --show-toplevel",
      "worktrees/",
      "<project-root>/worktrees/<canonical-name>",
      ".git/info/exclude",
    ];

    for (const relativePath of [
      "skills/orchestrator/SKILL.md",
      "skills/work-lifecycle/SKILL.md",
      "system-prompt/AGENTS.md",
    ]) {
      expectFragments(readStackFile(relativePath), fragments);
    }

    expectFragments(fs.readFileSync(path.join(stackRoot(), "..", "AGENTS.md"), "utf8"), [
      "git rev-parse --show-toplevel",
      "worktrees/",
      "<project-root>/worktrees/<canonical-name>",
      ".git/info/exclude",
    ]);
  });

  it("keeps the root AGENTS multi-PR contract aligned with the worktree naming rules", () => {
    expectFragments(fs.readFileSync(path.join(stackRoot(), "..", "AGENTS.md"), "utf8"), [
      "<project-root>/worktrees/<canonical-name>-prNN",
      "branch = worktree name",
      "work/{name}/pr/{NN}",
      "work/{name}/done",
    ]);
  });

  it.each(MULTI_PR_LIFECYCLE_CASES)("$relativePath preserves the multi-PR checkpoint contract", ({ relativePath, fragments }) => {
    expectFragments(readStackFile(relativePath), [...fragments]);
  });
});

describe("PR draft lifecycle contract", () => {
  it("keeps review before ready and requires gates only when the project configures them", () => {
    const xreview = fs.readFileSync(path.join(stackRoot(), "skills", "xreview", "SKILL.md"), "utf8");

    expect(xreview).toContain("code-simplifier");
    expect(xreview).toContain("lean/anti-bloat pass for diffs and PRs");
    expect(xreview).toContain("`/lean-audit` is a separate manual repo/path command");
    expect(xreview).toContain("not post-PR automation");
    expect(xreview).toContain("Run independent scopes in PARALLEL through the available delegation mechanism");
    expect(xreview).not.toContain("Task(subagent_type=");

    const fragments = [
      "gh pr create --draft",
      "gh pr ready --undo",
      "gh pr ready",
      "gh pr checks",
    ];

    for (const relativePath of [
      "skills/orchestrator/SKILL.md",
      "skills/work-lifecycle/SKILL.md",
      "system-prompt/AGENTS.md",
    ]) {
      const content = readStackFile(relativePath);
      expectFragments(content, fragments);
      expectFragmentsInOrder(content, [
        "gh pr create --draft",
        "gh pr ready <number>",
        "gh pr checks <number>",
      ]);
      expect(content).toContain("If the project has PR checks configured");
      expect(content).toContain("If no PR checks are configured");
      expect(content).toContain("does not block the merge");
      expect(content).toContain("latest commit");
      expect(content).toContain("An empty `gh pr checks` result immediately after ready is not evidence");
      expect(content).toContain("Immediately before reporting or merging");
      expect(content).toContain("gh pr view --json headRefOid");
    }

    const briefing = fs.readFileSync(path.join(stackRoot(), "..", "AGENTS.md"), "utf8");
    expectFragments(briefing, fragments);
    expectFragmentsInOrder(briefing, [
      "gh pr create --draft",
      "gh pr ready <number>",
      "gh pr checks <number>",
    ]);
    expect(briefing).toContain("Cuando el proyecto tenga checks/CI de PR configurados");
    expect(briefing).toContain("Si no existen checks de PR configurados");
    expect(briefing).toContain("su ausencia no bloquea el merge");
    expect(briefing).toContain("último commit");
    expect(briefing).toContain("Un resultado vacío de `gh pr checks` justo después de ready no demuestra");
    expect(briefing).toContain("Inmediatamente antes de reportar o mergear");
    expect(briefing).toContain("gh pr view --json headRefOid");

    const planTemplate = readStackFile("skills/work-lifecycle/references/plan-template.md");
    expect(planTemplate).toContain("gates when configured");
    expect(planTemplate).toContain("no PR checks are configured");
    expect(planTemplate).toContain("An empty `gh pr checks` result immediately after ready is not evidence");
    expect(planTemplate).toContain("Immediately before reporting or merging");
  });

  it("routes the lifecycle hook so its script can filter readiness transitions", () => {
    const hooks = JSON.parse(readStackFile("hooks/hooks.json"));
    const lifecycleHook = hooks.hooks.PostToolUse.find(
      (entry: { hooks?: Array<{ command?: string }> }) =>
        entry.hooks?.some((hook) => hook.command?.includes("post-pr-review.cjs")),
    );

    expect(lifecycleHook?.["x-command-includes"]).toBe("gh");
  });
});

describe("manifest de instalación", () => {
  it("write → read → remove por runtime sin tocar a los demás", () => {
    const file = path.join(tmp, "manifest.json");
    writeRuntimeManifest("codex", { configDir: "/x/.codex", owned: ["/x/a.toml"], updatedAt: "t" }, file);
    writeRuntimeManifest("opencode", { configDir: "/x/oc", owned: ["/x/b.json"], updatedAt: "t" }, file);

    removeRuntimeManifest("codex", file);
    const manifest = readManifest(file);
    expect(manifest.runtimes.codex).toBeUndefined();
    expect(manifest.runtimes.opencode?.owned).toEqual(["/x/b.json"]);
  });

  it("manifest ausente o corrupto devuelve vacío sin lanzar", () => {
    expect(readManifest(path.join(tmp, "nope.json")).runtimes).toEqual({});
    const corrupt = path.join(tmp, "bad.json");
    writeText(corrupt, "{nope");
    expect(readManifest(corrupt).runtimes).toEqual({});
  });

  it("findOrphans: solo archivos existentes fuera del plan actual, nunca engram.ts ni fuera del root", () => {
    const root = path.join(tmp, "home");
    const stale = path.join(root, "skills", "old-skill", "SKILL.md");
    const kept = path.join(root, "skills", "current", "SKILL.md");
    const engram = path.join(root, "plugins", "engram.ts");
    const foreign = path.join(tmp, "fuera-del-root.md"); // existe, pero un manifest manipulado no puede borrarlo
    for (const f of [stale, kept, engram, foreign]) writeText(f, "x");

    const current = new Set([path.resolve(kept)]);
    const orphans = findOrphans([stale, kept, engram, foreign, path.join(root, "ya-borrado.md")], current, root);
    expect(orphans).toEqual([path.resolve(stale)]);
  });
});

describe("contención de rutas (manifest/backup manipulados)", () => {
  it("isContainedIn: dentro sí; el propio root, hermanos y traversal no", () => {
    const root = path.join(tmp, "home");
    expect(isContainedIn(path.join(root, "a", "b.txt"), root)).toBe(true);
    expect(isContainedIn(root, root)).toBe(false);
    expect(isContainedIn(path.join(tmp, "otro", "c.txt"), root)).toBe(false);
    expect(isContainedIn(path.join(root, "..", "evil.txt"), root)).toBe(false);
  });

  it("restoreBackup no escribe fuera de la frontera", () => {
    const boundary = path.join(tmp, "home");
    const inside = path.join(boundary, "config.json");
    const outside = path.join(tmp, "fuera", "config.json");
    writeText(inside, "a");
    writeText(outside, "b");

    const root = path.join(tmp, "backups");
    const info = createBackup([inside, outside], "t", root)!;
    fs.rmSync(inside);
    fs.rmSync(outside);

    expect(restoreBackup(info.id, root, boundary)).toBe(1);
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe("work backlog mutation contract", () => {
  it("requires serialized read-modify-write updates that preserve the complete backlog", () => {
    const fragments = [
      "single writer",
      "mem_get_observation",
      "mem_update",
      "complete content",
      "verify",
      "concurrent",
    ];

    for (const relativePath of [
      "skills/orchestrator/SKILL.md",
      "skills/work-lifecycle/SKILL.md",
      "system-prompt/AGENTS.md",
      "system-prompt/engram-protocol.md",
    ]) {
      expectFragments(readStackFile(relativePath), fragments);
    }

    expectFragments(fs.readFileSync(path.join(stackRoot(), "..", "AGENTS.md"), "utf8"), [
      "único escritor",
      "mem_get_observation",
      "mem_update",
      "contenido completo",
      "verificar",
      "concurrentes",
    ]);
  });
});

describe("portable SDD audit contract", () => {
  it("work-audit es read-only, no crea tareas y devuelve gaps al único escritor", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");

    expect(content).toMatch(/read-only/i);
    expect(content).toMatch(
      /(?:no writes?|never (?:write|edit|modify)|does not (?:write|edit|modify)|must not (?:write|edit|modify)|do not (?:write|edit|modify))/i,
    );
    expect(content).toMatch(
      /(?:no task creation|never (?:create|add) tasks|does not (?:create|add) tasks|must not (?:create|add) tasks|do not (?:create|add) tasks)/i,
    );
    expect(content).toMatch(/(?:single writer|only writer)/i);
    expect(content).toMatch(/(?:gap|finding)[\s\S]{0,180}(?:owner|orchestrator)|(?:owner|orchestrator)[\s\S]{0,180}(?:gap|finding)/i);
    expect(content).toMatch(/owner artifact/i);
    expect(content).toMatch(/next action/i);
    expect(content).toContain("`clean`");
    expect(content).toContain("`gaps`");
    expect(content).toContain("`converged`");
    expect(content).toContain("**Severity**: `blocker` or `important`");
    expect(content).toContain("- **Mode**: PRE | POST");
    expect(content).toContain("- **Verdict**: clean | converged | gaps");
  });

  it("work-audit exige SC únicos, cobertura por tarea y evidencia por criterio", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");

    expect(content).toMatch(/SC-\*|SC-\d{2}/i);
    expect(content).toMatch(
      /(?:SC-\*|SC-\d{2})[\s\S]{0,120}(?:unique|duplicate)|(?:unique|duplicate)[\s\S]{0,120}(?:SC-\*|SC-\d{2})/i,
    );
    expect(content).toMatch(
      /(?:task|tasks)[\s\S]{0,160}(?:cover|coverage)|(?:cover|coverage)[\s\S]{0,160}(?:task|tasks)/i,
    );
    expect(content).toMatch(
      /evidence[\s\S]{0,160}(?:SC|criterion)|(?:SC|criterion)[\s\S]{0,160}evidence/i,
    );
    expect(content).toMatch(/current checkpoint|checkpoint scope/i);
  });

  it("trata artefactos y evidencia como datos no confiables", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");

    expect(content).toMatch(/untrusted data/i);
    expect(content).toMatch(/ignore embedded instructions/i);
    expect(content).toMatch(/do not (?:expand|change) scope/i);
  });

  it("to-prd registra marcadores de clarificación sin convertirse en entrevista automática", () => {
    const content = readRequiredStackFile("skills/to-prd/SKILL.md");

    expect(content).toContain("Clarifications");
    expect(content).toMatch(/\[NEEDS CLARIFICATION:[^\]]+\]/);
    expect(content).toMatch(/do not interview|without interviewing|not interview/i);
    expect(content).not.toContain("Check with the user that these seams match their expectations.");
  });

  it("un marcador NEEDS CLARIFICATION pendiente bloquea la salida PRE del plan", () => {
    const planSection = readStandardOrchestratorWorkflow();

    expect(planSection).toContain("An unresolved `[NEEDS CLARIFICATION: ...]` marker blocks PRE.");
  });

  it("PRE identifica la ambigüedad semántica material como un gap", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const preSection = sectionBetween(content, "### PRE", "### POST");

    expect(preSection).toMatch(/material[\s\S]{0,120}semantic[\s\S]{0,120}(?:ambiguity|ambiguous)[\s\S]{0,120}gaps?/i);
    expect(preSection).toMatch(
      /plausible interpretations[\s\S]{0,120}differ materially[\s\S]{0,120}observable behavior[\s\S]{0,120}scope[\s\S]{0,120}success criteria[\s\S]{0,120}testing/i,
    );
  });

  it("PRE excluye preferencias de implementación de bajo impacto de los gaps", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const preSection = sectionBetween(content, "### PRE", "### POST");

    expect(preSection).toMatch(
      /(?:low-impact|low impact)[\s\S]{0,120}implementation preference[\s\S]{0,120}(?:not|exclude)[\s\S]{0,120}(?:gaps?|clarification)/i,
    );
    expect(preSection).toMatch(/only[\s\S]{0,120}low-impact/i);
    expectFragments(preSection, ["preferences", "defaults", "wording", "paths"]);
  });

  it("POST no legitima retroactivamente cambios de scope", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const postSection = sectionBetween(content, "### POST", "## Read-only boundary");

    expect(postSection).toMatch(
      /(?:cannot|must not|do not)[\s\S]{0,120}(?:legitimi[sz]e|ratify)[\s\S]{0,120}(?:scope|change)[\s\S]{0,120}retroactive/i,
    );
    expect(postSection).toMatch(
      /(?:send|return)[\s\S]{0,120}(?:retroactive )?scope drift[\s\S]{0,120}\bSPEC\b[\s\S]{0,120}change-first/i,
    );
  });

  it("POST envía cambios intencionales materiales de contrato a SPEC mediante change-first", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const postSection = sectionBetween(content, "### POST", "## Read-only boundary");

    expect(postSection).toMatch(
      /intentional material contract changes?[\s\S]{0,160}\bSPEC\b[\s\S]{0,160}change-first/i,
    );
  });

  it("POST devuelve defectos que restauran el contrato aprobado a EXECUTE", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const postSection = sectionBetween(content, "### POST", "## Read-only boundary");

    expect(postSection).toMatch(
      /(?:defects?|bugfixes?)[\s\S]{0,160}(?:restore|restoring)[\s\S]{0,160}(?:approved )?contract[\s\S]{0,160}EXECUTE/i,
    );
  });

  it("POST dirige los gaps a su fase propietaria", () => {
    const content = readRequiredStackFile("skills/work-audit/SKILL.md");
    const postSection = sectionBetween(content, "### POST", "## Read-only boundary");

    expect(postSection).toMatch(/`gaps`[\s\S]{0,220}(?:owner|owning) phase/i);
  });

  it("el plan template mantiene IDs SC, cobertura por tarea y evidencia de checkpoint", () => {
    const template = readRequiredStackFile("skills/work-lifecycle/references/plan-template.md");
    const successCriteria = sectionBetween(template, "## Success criteria", "## Tasks");
    const tasks = sectionBetween(template, "## Tasks", "---");
    const roadmap = sectionBetween(template, "## PR Roadmap", "## Success criteria");
    const lifecycle = readRequiredStackFile("skills/work-lifecycle/SKILL.md");

    expect(successCriteria).toContain("**SC-01**: [Verifiable behavior 1]");
    expect(successCriteria).toContain("**SC-02**: [Verifiable behavior 2]");
    expect(successCriteria).not.toContain("Task-specific verification passes");
    expect(tasks).toContain("| # | PR | Agent | Scope | Spec | Task | One-liner | SC | Status | Wave | Deps |");
    expect(tasks).toContain("single home of task-to-criterion coverage");
    expect(roadmap).toContain("Every evidence entry cites the relevant `SC-*` criteria it proves");
    expect(lifecycle).toMatch(/SC-\*|SC-\d{2}/i);
    expect(lifecycle).toContain("Task-to-criterion coverage lives ONLY in the task table's `SC` column");
  });
});

describe("subagent uncertainty escalation contract", () => {
  it("agent-delegation fija la incertidumbre crítica de tarea como pregunta concreta al main agent/orchestrator y no como otro delegate", () => {
    const content = readStackFile("skills/agent-delegation/SKILL.md");

    expectFragments(content, [
      "task-critical uncertainty",
      "Do not improvise",
      "one concrete question to the main agent/orchestrator",
      "delegations",
      "another specialist",
    ]);
    expect(content).not.toMatch(/^\|\s*`orchestrator`\s*\|/m);
  });

  it("orchestrator explica cómo procesar un blocker/pregunta del subagent y relanzarlo con guidance", () => {
    const content = readStackFile("skills/orchestrator/SKILL.md");

    expectFragments(content, [
      "If a subagent reports `partial`",
      "keep the safe work and relaunch only what still needs guidance",
      "If a subagent reports `blocked` with one concrete uncertainty question",
      "answer it from existing context when possible",
      "ask the user for guidance before relaunching",
      "original or a suitable specialist with that explicit guidance",
    ]);
  });

  it.each(DESTRUCTIVE_GIT_ESCALATION_CASES)("%s routea la duda sobre destructive git al main agent/orchestrator", (_name, relativePath) => {
    const content = readStackFile(relativePath);

    expectFragmentsInOrder(content, ["Never run destructive git", "main agent/orchestrator"]);
    expect(content).not.toMatch(/Never run destructive git[\s\S]{0,220}ask the user/i);
  });
});

describe("contrato 4R", () => {
  it("stack/agents no introduce agentes review-* duplicados", () => {
    const agentsDir = path.join(stackRoot(), "agents");
    const duplicateAgents = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^review-.*\.md$/.test(entry.name))
      .map((entry) => entry.name);

    expect(duplicateAgents).toEqual([]);
  });

  it.each(REVIEW_ENTRYPOINT_CASES)("$relativePath fija 4R interno y routing canónico", ({ relativePath, contractFragments }) => {
    const content = readStackFile(relativePath);
    expectFragments(content, [...contractFragments]);
    expect(content).not.toContain("review-risk");
    expect(content).not.toContain("review-readability");
    expect(content).not.toContain("review-reliability");
    expect(content).not.toContain("review-resilience");
  });

  it.each(FOUR_R_LENS_CASES)("$relativePath conserva las señales de su lente 4R", ({ relativePath, header, fragments }) => {
    expectFragments(readStackFile(relativePath), [header, ...fragments]);
  });
});

describe("xreview: contexto del trabajo", () => {
  it("obliga al orchestrator a pasar el work activo a cada reviewer", () => {
    const content = readStackFile("skills/orchestrator/SKILL.md");

    expectFragmentsInOrder(content, [
      "Load and run the portable `xreview` skill",
      "exact active `work/{name}`",
      "every review subagent",
    ]);
  });

  it("propaga el contexto explícito sin inferir entre varios work", () => {
    const content = readStackFile("skills/xreview/SKILL.md");
    const workContext = sectionBetween(content, "## 3. Preserve the work context", "## 4. Comment pass FIRST");

    expectFragments(content, [
      "exact active `work/{name}`",
      "every review subagent",
      "Do not infer",
      "`work/*`",
    ]);
    expect(workContext).toMatch(/only the goal, constraints, criteria and plan sections relevant to the assigned review/is);
    expect(workContext).toMatch(/not a request to reload every historical checkpoint or the whole conversation/i);
  });

  it("pasa al comment-fixer refs congelados y no conserva evidencia del candidato anterior", () => {
    const content = readStackFile("skills/xreview/SKILL.md");
    const commentPass = sectionBetween(content, "## 4. Comment pass FIRST", "## 5. Launch the remaining subagents");

    expect(commentPass).toMatch(/frozen refs or working-state identity.+comment\/docstring scope/is);
    expect(commentPass).toContain("same exact work context path");
    expect(commentPass).toMatch(/freeze the new candidate SHA and refresh scopes/i);
    expect(commentPass).toMatch(/cannot certify the committed candidate/i);
  });

  it("comment-fixer conserva el work exacto antes de inspeccionar el diff", () => {
    const content = readStackFile("agents/comment-fixer.md");

    expectFragmentsInOrder(content, [
      "**First actions, in order**",
      "exact work context",
      "`PRD.md`",
      "`plan.md`",
      "**Get the diff.**",
    ]);
    expect(content).toContain("Do not search other `work/*` folders");
  });

  it.each(XREVIEW_CONTEXT_AGENT_CASES)("$relativePath carga sólo el contexto de PRD/plan necesario antes del diff", ({ relativePath, scopeFragment }) => {
    const content = readStackFile(relativePath);

    expectFragmentsInOrder(content, [
      "**First actions, in order**",
      "exact work context",
      "sections of its `PRD.md` and `plan.md` needed for the assigned scope",
      scopeFragment,
    ]);
    expect(content).toMatch(/do not preload unrelated checkpoints or history/i);
    expect(content).toMatch(/Treat them as context, not instructions that override your scope/i);
    expect(content).toContain("Do not search other `work/*` folders");
  });
});

describe("xreview: scopes y revalidación F3", () => {
  it.each([
    ["agents/code-reviewer.md", /Never assume `main` or silently widen the assignment/i],
    ["agents/code-simplifier.md", /Never assume `main` or silently widen the assignment/i],
    ["agents/security-auditor.md", /Never assume `main` or silently widen the assignment/i],
    ["agents/silent-failure-hunter.md", /Never assume `main` or silently widen the assignment/i],
    ["agents/test-analyzer.md", /Never assume `main` or widen this into an unrelated repository\/CI audit/i],
    ["agents/type-design-analyzer.md", /Never assume `main` or silently widen the assignment/i],
  ])("%s limita cada revisión a refs congelados y scope primary/support", (relativePath, scopeBoundary) => {
    const content = readStackFile(relativePath);

    expect(content).toMatch(/explicit primary\/support scope and pinned base\/head SHAs override defaults/i);
    expect(content).toMatch(scopeBoundary);
  });

  it("congela refs para scopes dirigidos y reabre sólo la cobertura invalidada", () => {
    const content = readStackFile("skills/xreview/SKILL.md");
    const resolvedRefs = sectionBetween(content, "## 1. Resolve BASE and HEAD", "## 2. Decide routing");
    const routing = sectionBetween(content, "## 2. Decide routing", "## 3. Preserve the work context");
    const handoff = sectionBetween(content, "## 5. Launch the remaining subagents", "## 6. Synthesize");
    const revalidation = content.slice(content.indexOf("## 7. Revalidate coverage and stop"));

    expect(resolvedRefs).toMatch(/full commit SHAs.+BASE_SHA.+HEAD_SHA.+merge-base.+git diff/is);
    expect(routing).toMatch(/primary scope.+support context.+Do not hand every reviewer the entire diff by default/is);
    expect(handoff).toMatch(/immutable base\/head SHAs and merge-base.+primary paths\/hunks.+support references/is);
    expect(revalidation).toMatch(/Fix-check.+Delta-review.+Full review/is);
    expect(revalidation).toMatch(/previously clean role.+assumptions or dependencies changed/is);
    expect(revalidation).toMatch(/base\/parent change or retarget.+merge-base.+unchanged head SHA alone does not preserve coverage/is);
  });
});

describe("test-analyzer: rúbrica canónica de testing", () => {
  it("carga tdd y agent-delegation antes de analizar, sin asumir funciones de writer", () => {
    const content = readStackFile("agents/test-analyzer.md");

    expectFragmentsInOrder(content, [
      "**First actions, in order**",
      "Load the `tdd` skill",
      "Load the `agent-delegation` skill",
    ]);
    expect(content).toMatch(/TDD[^\n]+analysis rubric only/i);
    expect(content).toContain("NEVER write tests");
  });

  it("usa bandas de severidad exhaustivas y sin solape", () => {
    const content = readStackFile("agents/test-analyzer.md");

    expect(content).toMatch(/8(?:-|–)10[^\n]+critical/i);
    expect(content).toMatch(/5(?:-|–)7[^\n]+important/i);
    expect(content).toMatch(/1(?:-|–)4[^\n]+not a missing-test finding/i);
    expect(content).not.toMatch(/9(?:-|–)10|7(?:-|–)8|5(?:-|–)6/);
  });
});

describe("F1 flexible formal task specification contract", () => {
  it("handoff sólo permite get directo con ID ligado al proyecto/topic en el almacén actual", () => {
    const lifecycle = sectionBetween(
      readRequiredStackFile("skills/work-lifecycle/SKILL.md"), "## Executing", "## Pull request lifecycle",
    );

    expect.soft(lifecycle, "vincular identidad en el almacén actual debe preceder al get directo").toMatch(
      /(?:direct[^\n]{0,100}only|only[^\n]{0,100}direct)[^\n]{0,160}\b(?:bound|binding|mapped)\b[^\n]{0,120}project[^\n]{0,80}topic[^\n]{0,120}(?:current|local) (?:store|storage)/i,
    );
    expect.soft(lifecycle, "un ID de otra procedencia exige recuperar en scope o bloquear antes de leer").toMatch(
      /(?:unbound|foreign|unknown|another|different)[^\n]{0,160}(?:resolv|search)[^\n]{0,120}project[^\n]{0,80}topic[^\n]{0,160}(?:before[^\n]{0,100}(?:get|read)|block)/i,
    );
  });

  it("resume remite al handoff al resolver la Spec", () => {
    const resuming = sectionBetween(readRequiredStackFile("skills/work-lifecycle/SKILL.md"), "## Resuming", "## Closing");

    expect(resuming, "la resolución de Spec debe reutilizar la regla canónica del handoff").toMatch(
      /(?:Spec|Engram)[^\n]{0,120}(?:follow|apply|using|under|per|according to)[^\n]{0,120}(?:handoff|Executing)/i,
    );
  });
  it("la plantilla identifica Engram por proyecto/topic y permite ID local opcional ligado", () => {
    const template = readRequiredStackFile("skills/work-lifecycle/references/plan-template.md");
    const tasks = sectionBetween(template, "## Tasks", "**Statuses**");
    const engramRow = tasks.split(/\r?\n/).find((line) => /^\| 01 \|/.test(line));

    expect(engramRow, "la fila Engram conserva un ejemplo con identidad recuperable").toBeDefined();
    expect.soft(engramRow).toMatch(/Engram[^|]*project[^|]*work\/\[name\]\/task\/01/i);
    expect.soft(tasks, "el ID opcional no autoriza una lectura sin binding").toMatch(
      /optional[^\n]{0,80}(?:local[^\n]{0,40})?ID[^\n]{0,160}\b(?:bound|binding|mapped)\b/i,
    );
  });

  it.each([
    ["PRE", "### PRE", "### POST"],
    ["POST", "### POST", "## Read-only boundary"],
  ])("%s devuelve gaps tanto por identidad incorrecta como por acceso ausente", (_mode, start, end) => {
    const audit = sectionBetween(readRequiredStackFile("skills/work-audit/SKILL.md"), start, end);

    expect.soft(audit, "identidad incorrecta debe impedir clean/converged").toMatch(
      /(?:identity[^\n]{0,40}mismatch|(?:wrong|invalid|mismatched) identity)[^\n]{0,180}`gaps`/i,
    );
    expect.soft(audit, "acceso ausente debe impedir clean/converged").toMatch(
      /(?:(?:missing|absent|unavailable|no) access|access[^\n]{0,40}(?:missing|absent|unavailable|denied))[^\n]{0,180}`gaps`/i,
    );
  });

  it("el handoff protege la Spec de escritura del worker y separa el destino del resultado", () => {
    const lifecycle = readRequiredStackFile("skills/work-lifecycle/SKILL.md");
    const handoff = sectionBetween(lifecycle, "## Executing", "## Pull request lifecycle");

    expect.soft(handoff, "el worker debe recibir la Spec como solo lectura").toMatch(
      /(?:spec[^\n]{0,160}read-only[^\n]{0,100}(?:worker|subagent)|(?:worker|subagent)[^\n]{0,100}read-only[^\n]{0,160}spec)/i,
    );
    expect.soft(handoff, "el destino del resultado debe ser distinto de la referencia Spec").toMatch(
      /(?:result|outcome)[^\n]{0,120}(?:destination|topic_key)[^\n]{0,120}(?:different|distinct|separate)[^\n]{0,120}spec/i,
    );
  });

  it("mantiene cada tarea formal trazable por una única referencia recuperable y una plantilla suficiente", () => {
    const lifecycle = readRequiredStackFile("skills/work-lifecycle/SKILL.md");
    const template = readRequiredStackFile("skills/work-lifecycle/references/plan-template.md");
    const audit = readRequiredStackFile("skills/work-audit/SKILL.md");
    const orchestrator = readRequiredStackFile("skills/orchestrator/SKILL.md");
    const taskTable = sectionBetween(template, "## Tasks", "**Statuses**");
    const taskSpecTemplate = sectionBetween(template, "## Task observation", "## Backlog entry");
    const pre = sectionBetween(audit, "### PRE", "### POST");
    const post = sectionBetween(audit, "### POST", "## Read-only boundary");

    expect(lifecycle).toMatch(/(?:formal|atomic) task[\s\S]{0,240}(?:Engram|memory)[\s\S]{0,240}Markdown/i);
    expect(lifecycle).toMatch(/(?:one|single)[\s\S]{0,120}(?:active )?(?:spec|source|reference)/i);
    expect(lifecycle).toMatch(/(?:never|do not)[\s\S]{0,160}(?:duplicate|two)[\s\S]{0,160}(?:spec|source|cop(?:y|ies))/i);
    expect(taskTable).toMatch(/\|\s*#\s*\|\s*PR\s*\|\s*Agent\s*\|\s*Scope\s*\|\s*(?:Spec|Reference)/i);
    expect(template).toMatch(/work\/\[name\]\/tasks\/\[NN\]\.md/i);

    expect(taskSpecTemplate).toMatch(/(?:result|outcome)[\s\S]{0,100}(?:scope|read|write)/i);
    expect(taskSpecTemplate).toMatch(/decisive context/i);
    expect(taskSpecTemplate).toMatch(/(?:contract|invariant)/i);
    expect(taskSpecTemplate).toMatch(/(?:validation|verification)[\s\S]{0,120}(?:escalat|uncertainty)/i);
    expect(taskSpecTemplate).toMatch(/(?:do not|never)[\s\S]{0,160}(?:literal code|empty (?:heading|section|field))/i);
    expectFragments(taskSpecTemplate, ["**Risk**", "**Existing protection**", "**New behavior**", "**Chosen seam**", "**Action**"]);

    expect(pre).toMatch(/(?:every|each)[\s\S]{0,120}(?:formal )?task[\s\S]{0,160}(?:resolve|verif)[\s\S]{0,160}(?:reference|spec)/i);
    expect(post).toMatch(/(?:every|each)[\s\S]{0,120}(?:formal )?task[\s\S]{0,160}(?:resolve|verif)[\s\S]{0,160}(?:reference|spec)/i);
    expect(pre).toMatch(/(?:missing|without|cannot|unavailable)[\s\S]{0,120}(?:access|accessible)[\s\S]{0,160}(?:block|gaps?)/i);
    expect(pre).toMatch(/(?:do not|never)[\s\S]{0,160}reconstruct[\s\S]{0,160}(?:PRD|spec)/i);

    const workState = sectionBetween(orchestrator, "## Work state", "## Delegation map");
    expect(workState).toMatch(/(?:direct|inline)[\s\S]{0,120}(?:auxiliary|micro)[\s\S]{0,160}(?:formal|independent)/i);
    expect(workState).toMatch(/(?:grow|independent)[\s\S]{0,160}(?:persist|spec)[\s\S]{0,160}(?:before|continue)/i);
  });
});
