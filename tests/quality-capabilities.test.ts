import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { Adapter, InstallContext } from "../src/adapters/types.js";
import { planHooks } from "../src/components/hooks.js";
import { planSystemPrompt } from "../src/components/system-prompt.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import {
  createLocalCapabilityReport,
  type LocalQualityCapabilityState,
  localQualityStatus,
} from "../src/lib/quality-capabilities.js";
import { stackRoot } from "../src/lib/paths.js";

const CAPABILITY_IDS = [
  "policy-guidance",
  "tool-approval",
  "external-verification",
] as const;

type CapabilityId = (typeof CAPABILITY_IDS)[number];

type AdapterFixture = {
  id: "claude-code" | "codex" | "opencode";
  adapter: Adapter;
  promptFile: string;
  configFile: string;
  writeCanonicalConfig: (configDir: string) => void;
  customConfig: string;
  invalidConfig: string;
};

type CapabilityFixture = {
  name: string;
  expected: readonly LocalQualityCapabilityState[];
  prepare: (adapter: AdapterFixture, configDir: string) => void;
};

const FIXTURE_MODELS = {
  strong: { model: "fixture/strong" },
  standard: { model: "fixture/standard" },
  cheap: { model: "fixture/cheap" },
};

const temporaryConfigDirs: string[] = [];

function fixtureContext(configDir: string): InstallContext {
  return {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: FIXTURE_MODELS,
    warnings: [],
  };
}

function temporaryConfigDir(): string {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-quality-capabilities-"));
  temporaryConfigDirs.push(configDir);
  return configDir;
}

function writeActionContent(
  actions: readonly { kind: string; target?: string; content?: string }[],
  target: string,
): void {
  const action = actions.find((candidate) => candidate.kind === "write" && candidate.target === target);
  if (action?.kind !== "write" || action.content === undefined) {
    throw new Error(`Missing write action for ${target}`);
  }
  fs.writeFileSync(target, action.content, "utf8");
}

function writeManagedPrompt(adapter: Adapter, configDir: string): void {
  const target = adapter.paths(configDir).systemPromptFile;
  writeActionContent(planSystemPrompt(adapter, fixtureContext(configDir)), target);
}

function writeCanonicalConfig(fixture: AdapterFixture, configDir: string): void {
  fixture.writeCanonicalConfig(configDir);
}

function directorySnapshot(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return `${entry.name}/[${directorySnapshot(target)}]`;
    return `${entry.name}:${fs.readFileSync(target, "utf8")}`;
  }).join("|");
}

function statesFor(report: ReturnType<typeof createLocalCapabilityReport>): LocalQualityCapabilityState[] {
  return CAPABILITY_IDS.map((id) => capability(report, id).state);
}

const ALL_UNAVAILABLE: readonly LocalQualityCapabilityState[] = [
  "unavailable",
  "unavailable",
  "unavailable",
];

const ADAPTER_FIXTURES: readonly AdapterFixture[] = [
  {
    id: "claude-code",
    adapter: claudeCodeAdapter,
    promptFile: "CLAUDE.md",
    configFile: "settings.json",
    writeCanonicalConfig(configDir) {
      const context = fixtureContext(configDir);
      writeActionContent(
        planHooks(claudeCodeAdapter, context),
        path.join(configDir, "settings.json"),
      );
    },
    customConfig: JSON.stringify({ permissions: { ask: ["Bash"] } }),
    invalidConfig: '{"permissions":',
  },
  {
    id: "codex",
    adapter: codexAdapter,
    promptFile: "AGENTS.md",
    configFile: "config.toml",
    writeCanonicalConfig(configDir) {
      const context = fixtureContext(configDir);
      writeActionContent(
        codexAdapter.planMainConfig(loadCanonicalMcp(context.stackDir), context),
        path.join(configDir, "config.toml"),
      );
    },
    customConfig: 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n',
    invalidConfig: 'approval_policy = "on-request"\ninvalid = [\n',
  },
  {
    id: "opencode",
    adapter: opencodeAdapter,
    promptFile: "AGENTS.md",
    configFile: "opencode.json",
    writeCanonicalConfig(configDir) {
      const context = fixtureContext(configDir);
      writeActionContent(
        opencodeAdapter.planMainConfig(loadCanonicalMcp(context.stackDir), context),
        path.join(configDir, "opencode.json"),
      );
    },
    customConfig: JSON.stringify({ permission: { edit: "ask" } }),
    invalidConfig: '{"permission":',
  },
];

const CAPABILITY_FIXTURES: readonly CapabilityFixture[] = [
  {
    name: "absence",
    expected: ALL_UNAVAILABLE,
    prepare: () => undefined,
  },
  {
    name: "valid managed prompt marker",
    expected: ["prompt-only", "unavailable", "unavailable"],
    prepare: (adapter, configDir) => writeManagedPrompt(adapter.adapter, configDir),
  },
  {
    name: "canonical permissions",
    expected: ["unavailable", "manual", "unavailable"],
    prepare: (adapter, configDir) => writeCanonicalConfig(adapter, configDir),
  },
  {
    name: "canonical prompt and permissions",
    expected: ["prompt-only", "manual", "unavailable"],
    prepare: (adapter, configDir) => {
      writeManagedPrompt(adapter.adapter, configDir);
      writeCanonicalConfig(adapter, configDir);
    },
  },
  {
    name: "custom permissions",
    expected: ALL_UNAVAILABLE,
    prepare: (adapter, configDir) => {
      fs.writeFileSync(path.join(configDir, adapter.configFile), adapter.customConfig, "utf8");
    },
  },
  {
    name: "invalid permissions config",
    expected: ALL_UNAVAILABLE,
    prepare: (adapter, configDir) => {
      fs.writeFileSync(path.join(configDir, adapter.configFile), adapter.invalidConfig, "utf8");
    },
  },
  {
    name: "unreadable prompt and permissions config",
    expected: ALL_UNAVAILABLE,
    prepare: (adapter, configDir) => {
      fs.mkdirSync(path.join(configDir, adapter.promptFile));
      fs.mkdirSync(path.join(configDir, adapter.configFile));
    },
  },
];

afterEach(() => {
  for (const directory of temporaryConfigDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function capability(
  report: ReturnType<typeof createLocalCapabilityReport>,
  id: CapabilityId,
) {
  const result = report.capabilities.find((entry) => entry.id === id);
  if (result === undefined) throw new Error(`Missing capability: ${id}`);
  return result;
}

describe("local quality capability report", () => {
  it("returns the fixed report envelope and does not promote prompt-only guidance", () => {
    const report = createLocalCapabilityReport("claude-code", [
      {
        id: "policy-guidance",
        state: "prompt-only",
        reason: "The prompt describes the policy but cannot enforce it",
        evidence: { source: "jorgex-stack-policy", version: "1" },
      },
    ]);

    expect(report).toMatchObject({
      namespace: "jorgex.quality.capabilities",
      version: 1,
      runtime: "claude-code",
    });
    expect(report.capabilities.map((entry) => entry.id)).toEqual(CAPABILITY_IDS);
    expect(capability(report, "policy-guidance").state).toBe("prompt-only");
    expect(report.capabilities.map((entry) => entry.state)).not.toContain("enforced");
  });

  it("keeps a manually approved action manual instead of treating approval as enforcement", () => {
    const report = createLocalCapabilityReport("codex", [
      {
        id: "tool-approval",
        state: "manual",
        reason: "The runtime requires a human approval step",
        evidence: { source: "codex-approval-policy", version: "1" },
      },
    ]);

    expect(capability(report, "tool-approval")).toMatchObject({
      id: "tool-approval",
      state: "manual",
      reason: "The runtime requires a human approval step",
      evidence: { source: "codex-approval-policy", version: "1" },
    });
    expect(capability(report, "tool-approval").state).not.toBe("enforced");
  });

  it("represents absent capabilities as unavailable and never as a local strict authority", () => {
    const report = createLocalCapabilityReport("opencode", []);

    expect(report.capabilities).toHaveLength(CAPABILITY_IDS.length);
    expect(report.capabilities.every((entry) => entry.state === "unavailable")).toBe(true);
    expect(capability(report, "external-verification").state).toBe("unavailable");
  });

  it("normalizes a claimed enforced or unknown capability state to unavailable", () => {
    const report = createLocalCapabilityReport("pi", [
      {
        id: "external-verification",
        state: "enforced",
        reason: "An untrusted local declaration claims external authority",
        evidence: { source: "local-config", version: "1" },
      },
      {
        id: "tool-approval",
        state: "future-state",
        reason: "An unknown state is not part of the contract",
      },
    ] as never);

    expect(capability(report, "external-verification").state).toBe("unavailable");
    expect(capability(report, "tool-approval").state).toBe("unavailable");
  });

  it.each(["manual", "prompt-only"] as const)(
    "keeps external-verification unavailable for a valid %s declaration",
    (state) => {
      const report = createLocalCapabilityReport("claude-code", [{
        id: "external-verification",
        state,
        reason: "A local declaration cannot provide external verification authority",
        evidence: { source: "reviewed-local-declaration", version: "1" },
      }]);

      expect(capability(report, "external-verification").state).toBe("unavailable");
    },
  );

  it("degrades duplicate capability IDs instead of accepting an ambiguous declaration", () => {
    const report = createLocalCapabilityReport("codex", [
      {
        id: "tool-approval",
        state: "manual",
        reason: "First declaration",
        evidence: { source: "codex-approval-policy", version: "1" },
      },
      {
        id: "tool-approval",
        state: "prompt-only",
        reason: "Conflicting duplicate declaration",
        evidence: { source: "prompt", version: "1" },
      },
    ]);

    expect(capability(report, "tool-approval").state).toBe("unavailable");
  });

  it.each([
    { name: "prompt-only", id: "policy-guidance", state: "prompt-only" },
    { name: "manual", id: "tool-approval", state: "manual" },
  ] as const)("requires source and version evidence for $name declarations", ({ id, state }) => {
    const report = createLocalCapabilityReport("claude-code", [
      {
        id,
        state,
        reason: "This declaration has no reviewed source/version pair",
        evidence: { source: " ", version: " " },
      },
    ]);

    expect(capability(report, id).state).toBe("unavailable");
  });

  it("normalizes an unknown runtime to unavailable entries", () => {
    const report = createLocalCapabilityReport("future-runtime" as never, []);

    expect(report.runtime).toBe("unknown");
    expect(report.capabilities.every((entry) => entry.state === "unavailable")).toBe(true);
  });
});

describe.each(ADAPTER_FIXTURES)("$id adapter capability boundaries", (fixture) => {
  it.each(CAPABILITY_FIXTURES)("$name reports only reviewed local declarations and does not write", (scenario) => {
    const configDir = temporaryConfigDir();
    scenario.prepare(fixture, configDir);
    const before = directorySnapshot(configDir);
    let report: ReturnType<Adapter["reportCapabilities"]> | undefined;

    expect(() => {
      report = fixture.adapter.reportCapabilities(configDir);
    }).not.toThrow();

    if (report === undefined) throw new Error("Adapter did not return a capability report");
    expect(statesFor(report)).toEqual(scenario.expected);
    expect(report.capabilities.some((entry) => (entry.state as string) === "enforced")).toBe(false);
    expect(directorySnapshot(configDir)).toBe(before);
  });
});

it("does not treat approval_policy inside Codex TOML multiline data as manual approval", () => {
  const configDir = temporaryConfigDir();
  const configFile = path.join(configDir, "config.toml");
  fs.writeFileSync(
    configFile,
    "instructions = '''\napproval_policy = \"on-request\"\n'''\n",
    "utf8",
  );
  const before = directorySnapshot(configDir);

  const report = codexAdapter.reportCapabilities(configDir);

  expect(statesFor(report)).toEqual(ALL_UNAVAILABLE);
  expect(directorySnapshot(configDir)).toBe(before);
});

describe("permission declaration provenance", () => {
  it.each([
    ["Claude Code", ADAPTER_FIXTURES.find(({ id }) => id === "claude-code")!, (config: Record<string, unknown>) => {
      const permissions = config.permissions as Record<string, unknown>;
      permissions.allow = [...(permissions.allow as string[]), "Bash"];
    }],
    ["Claude Code", ADAPTER_FIXTURES.find(({ id }) => id === "claude-code")!, (config: Record<string, unknown>) => {
      const permissions = config.permissions as Record<string, unknown>;
      permissions.unrecognized = true;
    }],
  ] as const)("reports $0 unavailable when canonical Claude permissions are customized", (_name, fixture, mutate) => {
    const configDir = temporaryConfigDir();
    writeCanonicalConfig(fixture, configDir);
    const configFile = path.join(configDir, fixture.configFile);
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    mutate(config);
    fs.writeFileSync(configFile, JSON.stringify(config), "utf8");

    expect(statesFor(fixture.adapter.reportCapabilities(configDir))).toEqual(ALL_UNAVAILABLE);
  });

  it("reports OpenCode unavailable when canonical bash permissions gain an allow override", () => {
    const fixture = ADAPTER_FIXTURES.find(({ id }) => id === "opencode")!;
    const configDir = temporaryConfigDir();
    writeCanonicalConfig(fixture, configDir);
    const configFile = path.join(configDir, fixture.configFile);
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
    const permission = config.permission as Record<string, unknown>;
    const bash = permission.bash as Record<string, unknown>;
    bash["git push*"] = "allow";
    fs.writeFileSync(configFile, JSON.stringify(config), "utf8");

    expect(statesFor(fixture.adapter.reportCapabilities(configDir))).toEqual(ALL_UNAVAILABLE);
  });

  it.each(ADAPTER_FIXTURES)("keeps canonical approval diagnosis with unrelated $id metadata", (fixture) => {
    const configDir = temporaryConfigDir();
    writeCanonicalConfig(fixture, configDir);
    const configFile = path.join(configDir, fixture.configFile);

    if (fixture.id === "codex") {
      const config = fs.readFileSync(configFile, "utf8");
      fs.writeFileSync(configFile, `unrelated_metadata = "kept"\n${config}`, "utf8");
    } else {
      const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
      config.unrelated_metadata = { owner: "user" };
      fs.writeFileSync(configFile, JSON.stringify(config), "utf8");
    }

    expect(statesFor(fixture.adapter.reportCapabilities(configDir))).toEqual([
      "unavailable",
      "manual",
      "unavailable",
    ]);
  });
});

describe("Codex approval declaration parser boundary", () => {
  it.each([
    ['profile="unsafe"'],
    ['invalid_metadata=null'],
  ] as const)("rejects canonical Codex config with root %s", (rootDeclaration) => {
    const fixture = ADAPTER_FIXTURES.find(({ id }) => id === "codex")!;
    const configDir = temporaryConfigDir();
    writeCanonicalConfig(fixture, configDir);
    const configFile = path.join(configDir, fixture.configFile);
    const canonical = fs.readFileSync(configFile, "utf8");
    fs.writeFileSync(configFile, `${rootDeclaration}\n${canonical}`, "utf8");

    expect(statesFor(codexAdapter.reportCapabilities(configDir))).toEqual(ALL_UNAVAILABLE);
  });

  it.each([
    [
      "duplicate tables",
      'approval_policy = "on-request"\n[permissions.jorgex-read-anywhere]\nvalue = "one"\n[permissions.jorgex-read-anywhere]\nother = "two"\n',
    ],
    [
      "duplicate keys",
      'approval_policy = "on-request"\nmetadata = "one"\nmetadata = "two"\n',
    ],
    [
      "invalid string escapes",
      'approval_policy = "on-request"\nmetadata = "bad\\q"\n',
    ],
    [
      "conflicting root default_permissions",
      'approval_policy = "on-request"\ndefault_permissions = "other-profile"\n',
    ],
    [
      "conflicting profile override",
      'approval_policy = "on-request"\n[permissions.jorgex-read-anywhere]\nextends = ":workspace"\n[permissions.jorgex-read-anywhere.filesystem]\n":root" = "write"\n',
    ],
  ] as const)("reports $0 as unavailable", (_name, config) => {
    const configDir = temporaryConfigDir();
    fs.writeFileSync(path.join(configDir, "config.toml"), config, "utf8");

    expect(statesFor(codexAdapter.reportCapabilities(configDir))).toEqual(ALL_UNAVAILABLE);
  });
});

describe.each(ADAPTER_FIXTURES)("$id managed prompt marker boundary", (fixture) => {
  it("reports a valid marker pair as unavailable when it also contains an inline duplicate marker", () => {
    const configDir = temporaryConfigDir();
    writeManagedPrompt(fixture.adapter, configDir);
    const promptFile = path.join(configDir, fixture.promptFile);
    fs.appendFileSync(promptFile, "\ninline duplicate: <!-- jorgex:system-prompt -->\n", "utf8");

    expect(statesFor(fixture.adapter.reportCapabilities(configDir))).toEqual(ALL_UNAVAILABLE);
  });
});

describe("local strict quality status", () => {
  it.each([
    ["routine", "pass", "pass"],
    ["elevated", "pass", "pass"],
    ["high", "pass", "incomplete"],
    ["release", "pass", "incomplete"],
    ["high", "fail", "fail"],
    ["release", "incomplete", "incomplete"],
  ] as const)("maps %s/%s to %s without weakening existing failures", (profile, status, expected) => {
    expect(localQualityStatus(profile, status)).toBe(expected);
  });
});
