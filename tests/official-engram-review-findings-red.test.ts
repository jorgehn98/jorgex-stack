import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RED coverage for review findings (no prod change).
 *
 * 1) Claude real install preflight must fail closed BEFORE backup/spawn when
 *    the actual `engram --version` is empty, malformed, times out/fails or
 *    otherwise unparseable. Known 1.20.0 / 2.0.0-rc.11 already reject via the
 *    direct seam (see official-engram-claude-version-preflight-red.test.ts);
 *    stable 2.0.0 passes (control). At least one test goes through the real
 *    `runInstall` wiring with an isolated temp fake executable so dropping
 *    version forwarding would fail.
 * 2) When CLAUDE_CONFIG_DIR is explicitly set equal to `$HOME/.claude`,
 *    provider/runtime must use explicit custom semantics (nested
 *    `$CLAUDE_CONFIG_DIR/.claude.json`), not sibling `$HOME/.claude.json`.
 *    Protects resolveOfficialSetupEnv + verifier/doctor mode alignment.
 *    Env is restored afterward. Avoids duplicating the existing
 *    default-valid / custom-valid provider-layout positives.
 * 3) Doctor must propagate the actionable Claude verifier reason (update to
 *    Engram 2.0.0+ for obsolete/incompatible setup) instead of replacing it
 *    with generic `ejecuta install`.
 * 4) Registry/settings unreadable or malformed diagnostics must distinguish
 *    ENOENT, unreadable, malformed and disabled where practical; reason must
 *    include path/cause, not false `missing/disabled`.
 *
 * All fixtures are isolated temp dirs; no personal HOME is touched. The
 * `withTempHome` helper re-imports fresh modules so the `HOME` const (from
 * `os.homedir()`) points at the temp home. Every CLAUDE_CONFIG_DIR mutation
 * is restored in `finally`.
 */

const promptsMock = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@clack/prompts", () => ({
  intro: promptsMock.intro,
  outro: promptsMock.outro,
  log: promptsMock.log,
}));

const tempRoots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  try {
    vi.restoreAllMocks();
  } catch {
    // no spies
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Safety: never leak an explicit CLAUDE_CONFIG_DIR into other tests.
  // Individual tests restore it in `finally`, this is defense in depth.
  // (Only deletes if it points inside os.tmpdir(); never touches a real user value.)
  const leaked = process.env.CLAUDE_CONFIG_DIR;
  if (typeof leaked === "string" && leaked.includes(os.tmpdir())) {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function makeVersionBin(output: string, exitCode = 0): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-review-ver-"));
  tempRoots.push(root);
  const bin = path.join(root, "engram");
  // Single-quoted printf payload; outputs used here contain no single quotes.
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit not applicable.
  }
  return bin;
}

function makeEmptyBin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-review-empty-"));
  tempRoots.push(root);
  const bin = path.join(root, "engram");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows
  }
  return bin;
}

function makeFailingBin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-review-fail-"));
  tempRoots.push(root);
  const bin = path.join(root, "engram");
  fs.writeFileSync(bin, "#!/bin/sh\nprintf 'boom\\n' 1>&2\nexit 1\n");
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows
  }
  return bin;
}

function seedBinAt(home: string, output: string, exitCode = 0): string {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${exitCode}\n`);
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows
  }
  return bin;
}

async function withCountingVerifier<T>(
  runtime: "claude-code",
  run: (count: { calls: number }) => Promise<T>,
): Promise<T> {
  const setup = await import("../src/lib/official-engram-setup.js");
  await import("../src/adapters/claude-code.js");
  const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
  const original = verifiers[runtime];
  const count = { calls: 0 };
  verifiers[runtime] = async () => {
    count.calls++;
    return { ok: true, layers: ["plugin", "mcp", "hooks"] };
  };
  try {
    return await run(count);
  } finally {
    if (original === undefined) delete verifiers[runtime];
    else verifiers[runtime] = original;
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

function detailOf(result: unknown): string {
  const rec = result as Record<string, unknown>;
  return String((rec["reason"] ?? rec["stderr"] ?? "") as unknown);
}

// ---------------------------------------------------------------------------
// 1) Version preflight fails closed on unreadable `engram --version`
// ---------------------------------------------------------------------------

describe("[review-1] unreadable engram --version rejects before backup/spawn", () => {
  it("empty output rejects before backup/spawn with actionable update-to-2.0.0+ reason", async () => {
    const bin = makeEmptyBin();
    const { engramVersion } = await import("../src/lib/detect.js");
    // Real spawn: empty stdout parses to empty/unparseable, never to a version.
    const version = engramVersion(bin);
    expect(version === null || version.trim() === "").toBe(true);

    const home = tempHome("jx-review1-empty-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const before = fs.readFileSync(bin, "utf8");
    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "claude-code",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin: bin,
          configDir,
          homeDir: home,
          // Forward the REAL parsed value (empty/null), not a hand-written string.
          engramVersion: version,
        },
      )) as Record<string, unknown>;
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(result["recovery"] ?? "none").toBe("none");
      const detail = detailOf(result);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
      expect(count.calls).toBe(0);
      expect(fs.readFileSync(bin, "utf8")).toBe(before);
    });
  });

  it("malformed output rejects before backup/spawn", async () => {
    const bin = makeVersionBin("bogus output");
    const { engramVersion } = await import("../src/lib/detect.js");
    const version = engramVersion(bin);
    expect(typeof version === "string" && version.length > 0).toBe(true);

    const home = tempHome("jx-review1-malformed-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "claude-code",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin: bin,
          configDir,
          homeDir: home,
          engramVersion: version,
        },
      )) as Record<string, unknown>;
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(count.calls).toBe(0);
      const detail = detailOf(result);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
    });
  });

  it("failing binary (exit 1, timeout/fail path → null) rejects before backup/spawn", async () => {
    const bin = makeFailingBin();
    const { engramVersion } = await import("../src/lib/detect.js");
    // Real spawn failure maps to null (same as timeout): must still fail closed.
    expect(engramVersion(bin)).toBeNull();

    const home = tempHome("jx-review1-fail-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "claude-code",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin: bin,
          configDir,
          homeDir: home,
          engramVersion: null,
        },
      )) as Record<string, unknown>;
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(count.calls).toBe(0);
      const detail = detailOf(result);
      expect(detail).toMatch(/update/i);
      expect(detail).toMatch(/2\.0\.0/);
    });
  });

  it("unparseable output without numbers rejects before backup/spawn", async () => {
    const bin = makeVersionBin("engram");
    const { engramVersion } = await import("../src/lib/detect.js");
    const version = engramVersion(bin);
    // No numeric triple: currently treated as non-blocking (passes through).
    expect(typeof version === "string").toBe(true);

    const home = tempHome("jx-review1-unparseable-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "claude-code",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin: bin,
          configDir,
          homeDir: home,
          engramVersion: version,
        },
      )) as Record<string, unknown>;
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(count.calls).toBe(0);
      expect(detailOf(result)).toMatch(/update/i);
    });
  });

  it("control: stable 2.0.0 via real binary still passes through to setup", async () => {
    const bin = makeVersionBin("engram 2.0.0");
    const { engramVersion } = await import("../src/lib/detect.js");
    const version = engramVersion(bin);
    expect(version).toBe("2.0.0");

    const home = tempHome("jx-review1-200-ctrl-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    await withCountingVerifier("claude-code", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "claude-code",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin: bin,
          configDir,
          homeDir: home,
          engramVersion: version,
        },
      )) as Record<string, unknown>;
      expect(count.calls).toBe(1);
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(true);
    });
  });
});

describe("[review-1] runInstall wiring forwards the real version (dropping it would pass)", () => {
  it("runInstall with empty-version fake executable fails with the version reason; verifier never runs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-review1-runinstall-"));
    tempRoots.push(tmp);
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    // Isolated fake executable at the canonical candidate so BOTH the explicit
    // `engramBin` opt AND the internal `engramVersion(bin)` spawn use it.
    // Empty stdout exercises the unreadable path through the real wiring.
    const emptyBin = path.join(homeDir, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(emptyBin), { recursive: true });
    fs.writeFileSync(emptyBin, "#!/bin/sh\nexit 0\n");
    try {
      fs.chmodSync(emptyBin, 0o755);
    } catch {
      // Windows
    }
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const setup = await import("../src/lib/official-engram-setup.js");
        await import("../src/adapters/claude-code.js");
        const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
        const original = verifiers["claude-code"];
        const count = { calls: 0 };
        verifiers["claude-code"] = async () => {
          count.calls++;
          return { ok: true, layers: ["plugin", "mcp", "hooks"] };
        };
        const adapter = install.ADAPTERS["claude-code"]!;
        const codex = install.ADAPTERS["codex"]!;
        const opencode = install.ADAPTERS["opencode"]!;
        const origClaude = adapter.detect;
        const origCodex = codex.detect;
        const origOpen = opencode.detect;
        const configDir = path.join(homeDir, ".claude");
        fs.mkdirSync(configDir, { recursive: true });
        adapter.detect = () => ({
          id: "claude-code",
          name: "Claude Code",
          installed: true,
          binPath: null,
          configDir,
        });
        codex.detect = () => ({
          id: "codex",
          name: "Codex CLI",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".codex"),
        });
        opencode.detect = () => ({
          id: "opencode",
          name: "OpenCode",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".config", "opencode"),
        });
        try {
          vi.clearAllMocks();
          const code = await install.runInstall({
            runtimes: ["claude-code"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "install",
            engramBin: emptyBin,
            showSummary: false,
          });
          // Must fail closed on the unreadable version BEFORE setup.
          expect(code).toBe(1);
          expect(count.calls).toBe(0);
          const errors = [
            ...promptsMock.log.error.mock.calls.flat(),
            ...promptsMock.log.warn.mock.calls.flat(),
          ].join("\n");
          expect(errors).toMatch(/update/i);
          expect(errors).toMatch(/2\.0\.0/);
        } finally {
          adapter.detect = origClaude;
          codex.detect = origCodex;
          opencode.detect = origOpen;
          if (original === undefined) delete verifiers["claude-code"];
          else verifiers["claude-code"] = original;
        }
      });
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
  });
});

// ---------------------------------------------------------------------------
// 2) Explicit CLAUDE_CONFIG_DIR equal to $HOME/.claude uses custom semantics
// ---------------------------------------------------------------------------

const OFFICIAL_HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "session-start.sh" }] }],
  },
};

function writeRegistryWithInstallPath(configDir: string, installPath: string): void {
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "engram@engram": [{ scope: "user", version: "0.1.3", installPath, gitCommitSha: "abc1234" }],
      },
    }),
  );
}

function writeEnabled(configDir: string, enabled: boolean): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ enabledPlugins: { "engram@engram": enabled } }),
  );
}

function writeInstallPathTree(installPath: string): void {
  fs.mkdirSync(path.join(installPath, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(installPath, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(installPath, "hooks", "hooks.json"), JSON.stringify(OFFICIAL_HOOKS));
  fs.writeFileSync(path.join(installPath, "scripts", "session-start.sh"), "#!/bin/sh\n");
}

function writeExactNestedMcp(configDir: string, engramBin: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, ".claude.json"),
    JSON.stringify({ mcpServers: { engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"] } } }),
  );
}

describe("[review-2] explicit CLAUDE_CONFIG_DIR equal to $HOME/.claude is custom (nested)", () => {
  it("resolveOfficialSetupEnv uses nested custom semantics when the var is explicitly set, even if equal", async () => {
    const home = tempHome("jx-review2-env-");
    const configDir = path.join(home, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const mod = await import("../src/lib/official-engram-setup.js");
      const env = (mod.resolveOfficialSetupEnv as unknown as CallableFunction)("claude-code", configDir, home) as Record<
        string,
        string | undefined
      >;
      // Explicit custom: provider/runtime must use the nested file, so the
      // setup env must forward CLAUDE_CONFIG_DIR (not default sibling).
      expect(env["CLAUDE_CONFIG_DIR"]).toBe(configDir);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("verifier honors the explicit equal var: nested-only MCP passes, sibling-only would not", async () => {
    const home = tempHome("jx-review2-verify-");
    // Explicitly set to the default-looking path: effective mode is custom.
    const configDir = path.join(home, ".claude");
    const engramBin = path.join(home, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(engramBin), { recursive: true });
    fs.writeFileSync(engramBin, "#!/bin/sh\n");
    const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
    writeRegistryWithInstallPath(configDir, installPath);
    writeEnabled(configDir, true);
    writeInstallPathTree(installPath);
    // Custom layout: nested present, sibling absent (isolates the mode).
    writeExactNestedMcp(configDir, engramBin);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);

    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const mod = await import("../src/adapters/claude-code.js");
      const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
        configDir,
        engramBin,
        homeDir: home,
      })) as { ok: boolean; layers: string[] };
      // Explicit custom must accept the nested MCP (not demand the sibling).
      expect(report.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// 3) Doctor propagates the actionable verifier reason
// ---------------------------------------------------------------------------

describe("[review-3] doctor surfaces the actionable update-to-2.0.0+ reason", () => {
  it("obsolete mcp/engram.json without valid MCP logs update-to-2.0.0+, not just generic ejecuta install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-review3-doctor-"));
    tempRoots.push(tmp);
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const configDir = path.join(homeDir, ".claude");
    fs.mkdirSync(configDir, { recursive: true });
    // Valid plugin + hooks so the ONLY missing layer is the MCP, with the
    // obsolete file present: verifier must return the actionable obsolete reason.
    const engramBin = seedBinAt(homeDir, "engram 2.0.0");
    const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
    writeRegistryWithInstallPath(configDir, installPath);
    writeEnabled(configDir, true);
    writeInstallPathTree(installPath);
    fs.mkdirSync(path.join(configDir, "mcp"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "mcp", "engram.json"),
      JSON.stringify({ type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"] }),
    );
    // No valid MCP in either effective location.
    expect(fs.existsSync(path.join(homeDir, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(false);

    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const doctor = await import("../src/doctor.js");
        const adapter = install.ADAPTERS["claude-code"]!;
        const codex = install.ADAPTERS["codex"]!;
        const opencode = install.ADAPTERS["opencode"]!;
        const origClaude = adapter.detect;
        const origCodex = codex.detect;
        const origOpen = opencode.detect;
        adapter.detect = () => ({
          id: "claude-code",
          name: "Claude Code",
          installed: true,
          binPath: null,
          configDir,
        });
        codex.detect = () => ({
          id: "codex",
          name: "Codex CLI",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".codex"),
        });
        opencode.detect = () => ({
          id: "opencode",
          name: "OpenCode",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".config", "opencode"),
        });
        try {
          vi.clearAllMocks();
          const code = await doctor.runDoctor({ runtimes: ["claude-code"] });
          expect(code).not.toBe(0);
          const logs = [
            ...promptsMock.log.warn.mock.calls.flat(),
            ...promptsMock.log.error.mock.calls.flat(),
            ...promptsMock.log.info.mock.calls.flat(),
          ].join("\n");
          // Actionable reason must survive, not be replaced by generic text.
          expect(logs).toMatch(/update/i);
          expect(logs).toMatch(/2\.0\.0/);
          expect(logs).toMatch(/obsolete/i);
        } finally {
          adapter.detect = origClaude;
          codex.detect = origCodex;
          opencode.detect = origOpen;
        }
      });
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
  });
});

// ---------------------------------------------------------------------------
// 4) Registry/settings diagnostics distinguish cause, include path
// ---------------------------------------------------------------------------

function seedMinimalValidClaude(home: string): { configDir: string; engramBin: string; installPath: string } {
  const configDir = path.join(home, ".claude");
  const engramBin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(engramBin), { recursive: true });
  fs.writeFileSync(engramBin, "#!/bin/sh\n");
  const installPath = path.join(configDir, "plugins", "cache", "engram", "engram", "0.1.3");
  writeRegistryWithInstallPath(configDir, installPath);
  writeEnabled(configDir, true);
  writeInstallPathTree(installPath);
  // Valid sibling MCP so registry/settings are the only variables.
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { engram: { type: "stdio", command: engramBin, args: ["mcp", "--tools=agent"] } } }),
  );
  return { configDir, engramBin, installPath };
}

describe("[review-4] registry diagnostics include path and distinguish cause", () => {
  it("missing registry reports the registry path, not disabled", async () => {
    const home = tempHome("jx-review4-reg-missing-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    fs.rmSync(path.join(configDir, "plugins", "installed_plugins.json"), { force: true });
    const mod = await import("../src/adapters/claude-code.js");
    const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
      configDir,
      engramBin,
      homeDir: home,
    })) as { ok: boolean; reason?: string; layers: string[] };
    expect(report.ok).toBe(false);
    const reason = String(report.reason ?? "");
    expect(reason).toContain(path.join(configDir, "plugins", "installed_plugins.json"));
    expect(reason).not.toMatch(/disabled/i);
  });

  it("unreadable registry (EACCES) reports path/cause, not false missing", async () => {
    const home = tempHome("jx-review4-reg-eacces-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    const registry = path.join(configDir, "plugins", "installed_plugins.json");
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, opts: unknown) => {
      if (path.resolve(String(file)) === path.resolve(registry)) {
        const err = new Error(`EACCES: permission denied, open '${String(file)}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realRead as (f: string, o?: unknown) => string)(String(file), opts as never);
    }) as typeof fs.readFileSync);
    try {
      const mod = await import("../src/adapters/claude-code.js");
      const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
        configDir,
        engramBin,
        homeDir: home,
      })) as { ok: boolean; reason?: string };
      expect(report.ok).toBe(false);
      const reason = String(report.reason ?? "");
      expect(reason).toContain(registry);
      expect(reason).toMatch(/EACCES|ilegible|unreadable|permiso/i);
      expect(reason).not.toMatch(/registry ausente/);
    } finally {
      spy.mockRestore();
    }
  });

  it("malformed registry reports path/cause, not false missing", async () => {
    const home = tempHome("jx-review4-reg-malformed-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    const registry = path.join(configDir, "plugins", "installed_plugins.json");
    fs.writeFileSync(registry, "{ not-json\n");
    const mod = await import("../src/adapters/claude-code.js");
    const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
      configDir,
      engramBin,
      homeDir: home,
    })) as { ok: boolean; reason?: string };
    expect(report.ok).toBe(false);
    const reason = String(report.reason ?? "");
    expect(reason).toContain(registry);
    expect(reason).toMatch(/ilegible|malform|JSON|inv[aá]lid/i);
    expect(reason).not.toMatch(/disabled/i);
  });
});

describe("[review-4] settings diagnostics distinguish unreadable/malformed from disabled", () => {
  it("unreadable settings (EACCES) is not reported as disabled; includes path/cause", async () => {
    const home = tempHome("jx-review4-set-eacces-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    const settings = path.join(configDir, "settings.json");
    const realRead = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: unknown, opts: unknown) => {
      if (path.resolve(String(file)) === path.resolve(settings)) {
        const err = new Error(`EACCES: permission denied, open '${String(file)}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realRead as (f: string, o?: unknown) => string)(String(file), opts as never);
    }) as typeof fs.readFileSync);
    try {
      const mod = await import("../src/adapters/claude-code.js");
      const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
        configDir,
        engramBin,
        homeDir: home,
      })) as { ok: boolean; reason?: string };
      expect(report.ok).toBe(false);
      const reason = String(report.reason ?? "");
      expect(reason).toContain(settings);
      expect(reason).toMatch(/EACCES|ilegible|unreadable|permiso/i);
      // Must not falsely claim the plugin was explicitly disabled.
      expect(reason).not.toMatch(/disabled/);
    } finally {
      spy.mockRestore();
    }
  });

  it("malformed settings is not reported as disabled; includes path/cause", async () => {
    const home = tempHome("jx-review4-set-malformed-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    const settings = path.join(configDir, "settings.json");
    fs.writeFileSync(settings, "{ not-json\n");
    const mod = await import("../src/adapters/claude-code.js");
    const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
      configDir,
      engramBin,
      homeDir: home,
    })) as { ok: boolean; reason?: string };
    expect(report.ok).toBe(false);
    const reason = String(report.reason ?? "");
    expect(reason).toContain(settings);
    expect(reason).toMatch(/ilegible|malform|JSON|inv[aá]lid/i);
    expect(reason).not.toMatch(/disabled/);
  });

  it("control: explicitly disabled plugin still reports disabled", async () => {
    const home = tempHome("jx-review4-disabled-ctrl-");
    const { configDir, engramBin } = seedMinimalValidClaude(home);
    writeEnabled(configDir, false);
    const mod = await import("../src/adapters/claude-code.js");
    const report = (await (mod.verifyOfficialSetup as unknown as CallableFunction)({
      configDir,
      engramBin,
      homeDir: home,
    })) as { ok: boolean; reason?: string };
    expect(report.ok).toBe(false);
    expect(String(report.reason ?? "")).toMatch(/disabled/i);
  });
});
