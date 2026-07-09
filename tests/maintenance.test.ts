import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, restoreBackup } from "../src/lib/backup.js";
import { findOrphans, readManifest, removeRuntimeManifest, writeRuntimeManifest } from "../src/lib/manifest.js";
import { isContainedIn, writeText } from "../src/lib/fsx.js";
import { planPlugins } from "../src/components/plugins.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";
import { runInstall } from "../src/install.js";
import { planCommands } from "../src/components/commands.js";

let tmp: string;

const readStackFile = (relativePath: string) =>
  fs.readFileSync(path.join(stackRoot(), relativePath), "utf8");

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
    relativePath: "commands/xreview.md",
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
  {
    relativePath: "scripts/post-pr-review.cjs",
    contractFragments: [
      "stays internal",
      "Reliability / Resilience / Readability / Risk",
      "comment-fixer",
      "test-analyzer",
      "silent-failure-hunter",
      "type-design-analyzer",
      "code-reviewer",
      "code-simplifier",
      "security-auditor",
      "extra agents",
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
    fragments: ["external contracts", "negative test cases", "async/concurrency behavior", "behavioral coverage rather than line coverage"],
  },
  {
    relativePath: "agents/silent-failure-hunter.md",
    header: "## 4R Resilience Lens",
    fragments: ["fallback, retry, degradation", "rollback", "fix-forward behavior"],
  },
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
    relativePath: "agents/orchestrator.md",
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
      "| # | PR | Task | One-liner | Status | Wave | Deps |",
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-maint-"));
});

afterEach(() => {
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

describe("permisos por defecto: lectura externa sin permisos", () => {
  const makeCtx = (id: "opencode" | "codex") => ({
    stackDir: stackRoot(),
    configDir: tmp,
    engramBin: null,
    models: DEFAULT_MODEL_MAP[id]!,
    warnings: [],
  });
  const mcp = () => loadCanonicalMcp(stackRoot());

  it("opencode: la config fresca abre lectura externa y reglas read/env, pero no broad bypass", () => {
    const [action] = opencodeAdapter.planMainConfig(mcp(), makeCtx("opencode"));
    const fresh = JSON.parse((action as { content: string }).content);
    expect(fresh.permission).toMatchObject({
      external_directory: { "*": "allow" },
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
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
    expect(JSON.stringify(fresh)).not.toMatch(/danger-full-access|bypassPermissions/);
  });

  it("opencode: migra el default viejo exacto y deja intacta la config custom", () => {
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
    expect(migrated.permission).toMatchObject({
      external_directory: { "*": "allow" },
      read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    });
    expect(migrated.permission.read).not.toBe("allow");
  });

  it("codex: la config fresca publica jorgex-read-anywhere sin sandbox_mode", () => {
    const [action] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const fresh = (action as { content: string }).content;
    expect(fresh).toContain('approval_policy = "on-request"');
    expect(fresh).toContain('default_permissions = "jorgex-read-anywhere"');
    expect(fresh).toContain("[permissions.jorgex-read-anywhere]");
    expect(fresh).toContain(":workspace");
    expect(fresh).toContain("*.env");
    expect(fresh).not.toContain('sandbox_mode = "workspace-write"');

    writeText(path.join(tmp, "config.toml"), 'approval_policy = "never"\ndefault_permissions = "custom"\nsandbox_mode = "workspace-write"\n');
    const [action2] = codexAdapter.planMainConfig(mcp(), makeCtx("codex"));
    const existing = (action2 as { content: string }).content;
    expect(existing).toContain('approval_policy = "never"');
    expect(existing).toContain('default_permissions = "custom"');
    expect(existing).toContain('sandbox_mode = "workspace-write"');
    expect(existing).not.toContain('[permissions.jorgex-read-anywhere]');
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
    const migrated = (legacy as { content: string }).content;
    expect(migrated).toContain('default_permissions = "jorgex-read-anywhere"');
    expect(migrated).toContain("[permissions.jorgex-read-anywhere]");
    expect(migrated).not.toContain('sandbox_mode = "workspace-write"');
  });
});

describe("planPlugins: placeholders resueltos", () => {
  it("engram.ts recibe el protocolo canónico y el binario, sin placeholders", async () => {
    const ctx = {
      stackDir: stackRoot(),
      configDir: tmp,
      engramBin: "C:\\bin\\engram.exe",
      models: DEFAULT_MODEL_MAP.opencode!,
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
      models: DEFAULT_MODEL_MAP.opencode!,
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
});

describe("lean integration: prompt wiring", () => {
  it("code-simplifier carga lean-code y admite audit scope", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "code-simplifier.md"), "utf8");

    expect(content).toContain("Use the `lean-code` skill as your anti-bloat lens");
    expect(content).toContain("If you're given an audit scope (repo/path root)");
    expect(content).toContain("Load the `lean-code` skill.");
  });

  it("implementer aplica lean-code antes de añadir código no trivial", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "implementer.md"), "utf8");

    expect(content).toContain("Load `lean-code` before non-trivial code");
    expect(content).toContain("Ask whether the code is needed at all");
  });

  it("orchestrator usa lean-code como gate de alcance", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "orchestrator.md"), "utf8");

    expect(content).toContain("Apply the `lean-code` skill as a scope gate");
    expect(content).toContain("whether the smallest obvious change is enough");
  });

  it("type-design-analyzer limita el audit scope a contratos/tipos", () => {
    const content = fs.readFileSync(path.join(stackRoot(), "agents", "type-design-analyzer.md"), "utf8");

    expect(content).toContain("If you're given an audit scope (repo/path root)");
    expect(content).toContain("inspect only type/interface/schema/contract definitions in that path");
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
      "agents/orchestrator.md",
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

describe("lean integration: xreview y post-pr-review alineados", () => {
  it("ambos tratan code-simplifier como el pase lean/anti-bloat y xreview deja lean-audit fuera de post-PR", () => {
    const xreview = fs.readFileSync(path.join(stackRoot(), "commands", "xreview.md"), "utf8");
    const postPrReview = fs.readFileSync(path.join(stackRoot(), "scripts", "post-pr-review.cjs"), "utf8");

    expect(xreview).toContain("code-simplifier");
    expect(xreview).toContain("lean/anti-bloat pass for diffs and PRs");
    expect(xreview).toContain("`/lean-audit` is a separate manual repo/path command");
    expect(xreview).toContain("not post-PR automation");

    expect(postPrReview).toContain("code-simplifier");
    expect(postPrReview).toContain("lean/anti-bloat pass for diffs and PRs");
    expect(postPrReview).not.toContain("lean-audit");
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
    const content = readStackFile("agents/orchestrator.md");

    expectFragments(content, [
      "If a subagent reports `partial`",
      "keep the safe work and relaunch only what still needs guidance",
      "If a subagent reports `blocked` with one concrete uncertainty question",
      "answer it from existing context when possible",
      "relaunch the original or a suitable specialist with explicit guidance",
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
