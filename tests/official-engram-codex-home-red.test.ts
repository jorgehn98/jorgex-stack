import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RED: Engram 2.0.0 `setup codex` ignores CODEX_HOME and writes `$HOME/.codex`.
 *
 * Real diagnosis: isolated verification with a custom CODEX_HOME still mutated
 * the personal `$HOME/.codex`, because the provider does not honor the env.
 * Required contract (no network/download, binary untouched, no HOME/DB/bin
 * mutation in the tests themselves):
 * 1) `runOfficialSetupIfNeeded("codex", { configDir != <homeDir>/.codex })`
 *    must fail BEFORE targets/backup/spawn with an actionable
 *    provider-ignores-CODEX_HOME reason; the default `<home>/.codex` passes.
 * 2) The real `runInstall` real-install path with a custom Codex config must
 *    fail in preflight BEFORE applying Stack file changes (not only after
 *    plan/apply); sync/dry-run/target-dir remain allowed and never invoke
 *    setup.
 * 3) The default Codex child env must omit an inherited CODEX_HOME (deletion
 *    marker) so the provider uses `$HOME/.codex`; the public runtime default
 *    stays aligned.
 *
 * Current code has no Codex custom gate (only OpenCode basename) and always
 * forwards `{ CODEX_HOME: configDir }`, so the custom rejection, the
 * runInstall preflight-before-apply and the default-omission cases below must
 * FAIL now for the intended behavioral reason. Default-pass and
 * sync/dry-run/target-dir controls lock the non-blocking contract and must
 * keep passing after GREEN.
 *
 * All fixtures live under `os.tmpdir()`; parent env (HOME/USERPROFILE/
 * CODEX_HOME/CLAUDE_CONFIG_DIR/OPENCODE_CONFIG_DIR) is restored in `finally`.
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
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR"] as const) {
    const leaked = process.env[key];
    if (typeof leaked === "string" && leaked.includes(os.tmpdir())) {
      delete process.env[key];
    }
  }
});

function tempHome(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

const FAKE_BIN_SCRIPT = "#!/bin/sh\nexit 0\n";

function seedFakeBin(home: string): string {
  const bin = path.join(home, ".local", "bin", "engram");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, FAKE_BIN_SCRIPT);
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows: exec bit not applicable.
  }
  return bin;
}

function makeProbeBin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jx-codex-home-probe-"));
  tempRoots.push(root);
  const bin = path.join(root, "probe-codex-env");
  fs.writeFileSync(
    bin,
    "#!/bin/sh\nif [ -z \"${CODEX_HOME+x}\" ]; then printf 'absent\\n'; else printf 'present:%s\\n' \"$CODEX_HOME\"; fi\nexit 0\n",
  );
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // Windows.
  }
  return bin;
}

async function withCountingVerifier<T>(
  runtime: "codex",
  run: (count: { calls: number }) => Promise<T>,
): Promise<T> {
  const setup = await import("../src/lib/official-engram-setup.js");
  await import("../src/adapters/codex.js");
  const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
  const original = verifiers[runtime];
  const count = { calls: 0 };
  verifiers[runtime] = async () => {
    count.calls++;
    return { ok: true, layers: ["plugin", "mcp", "instructions", "compact"] };
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
// 1) runOfficialSetupIfNeeded Codex custom gate before targets/backup/spawn
// ---------------------------------------------------------------------------

describe("[codex-home-1] custom Codex configDir is rejected before setup", () => {
  it("custom inside HOME (!= <home>/.codex) fails preflight before backup/spawn with actionable CODEX_HOME reason, binary untouched", async () => {
    const home = tempHome("jx-codex-home-custom-");
    // Inside HOME but not the default: the existing outside-HOME boundary
    // would NOT block this, so only the new CODEX_HOME gate can reject it.
    const customDir = path.join(home, "custom-codex");
    fs.mkdirSync(customDir, { recursive: true });
    const marker = path.join(customDir, "config.toml");
    const originalMarker = 'model = "user/model"\n';
    fs.writeFileSync(marker, originalMarker);
    const engramBin = seedFakeBin(home);
    const beforeBin = fs.readFileSync(engramBin, "utf8");
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);

    await withCountingVerifier("codex", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "codex",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin,
          configDir: customDir,
          homeDir: home,
        },
      )) as Record<string, unknown>;

      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(false);
      expect(result["backupId"] ?? null).toBeNull();
      expect(result["recovery"] ?? "none").toBe("none");
      const detail = detailOf(result);
      expect(detail).toMatch(/CODEX_HOME/);
      expect(detail).toMatch(/ignor/i);
      expect(detail).toMatch(/\.codex/);
      expect(detail).toMatch(/provider|setup codex/i);
      expect(count.calls).toBe(0);
      // No mutation: custom marker intact, default personal dir untouched,
      // existing binary byte-identical, no DB touched.
      expect(fs.readFileSync(marker, "utf8")).toBe(originalMarker);
      expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
      expect(fs.readFileSync(engramBin, "utf8")).toBe(beforeBin);
      expect(detail).not.toMatch(/\.engram\/engram\.db|engram\.db/);
    });
  });

  it("control: default <home>/.codex passes through to setup (not blocked)", async () => {
    const home = tempHome("jx-codex-home-default-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const engramBin = seedFakeBin(home);

    await withCountingVerifier("codex", async (count) => {
      const mod = await import("../src/lib/official-engram-setup.js");
      const result = (await (mod.runOfficialSetupIfNeeded as unknown as CallableFunction)(
        "codex",
        {
          command: "install",
          dryRun: false,
          targetDir: undefined,
          engramBin,
          configDir,
          homeDir: home,
        },
      )) as Record<string, unknown>;

      expect(count.calls).toBe(1);
      expect(result["ran"]).toBe(true);
      expect(result["ok"]).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2) runInstall real-install preflight before Stack file changes
// ---------------------------------------------------------------------------

describe("[codex-home-2] runInstall real-install with custom Codex config fails before Stack writes", () => {
  it("real install (CODEX_HOME custom inside temp HOME) exits 1 with CODEX_HOME reason, verifier never runs, no Stack files applied", async () => {
    const tmp = tempDir("jx-codex-home-runinstall-");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const customDir = path.join(homeDir, "custom-codex");
    fs.mkdirSync(customDir, { recursive: true });
    const fakeBin = path.join(homeDir, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, FAKE_BIN_SCRIPT);
    try {
      fs.chmodSync(fakeBin, 0o755);
    } catch {
      // Windows.
    }
    const beforeBin = fs.readFileSync(fakeBin, "utf8");

    const prevCodex = process.env.CODEX_HOME;
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    const prevOpencode = process.env.OPENCODE_CONFIG_DIR;
    process.env.CODEX_HOME = customDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const setup = await import("../src/lib/official-engram-setup.js");
        await import("../src/adapters/codex.js");
        const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
        const original = verifiers["codex"];
        const count = { calls: 0 };
        verifiers["codex"] = async () => {
          count.calls++;
          return { ok: true, layers: ["plugin", "mcp", "instructions", "compact"] };
        };
        // Keep other runtimes out of the way without touching real HOME.
        const codex = install.ADAPTERS.codex!;
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const opencode = install.ADAPTERS.opencode!;
        const origCodexDetect = codex.detect;
        const origClaudeDetect = claudeCode.detect;
        const origOpenDetect = opencode.detect;
        // Real wiring for codex via CODEX_HOME; others forced absent.
        claudeCode.detect = () => ({
          id: "claude-code",
          name: "Claude Code",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".claude"),
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
            runtimes: ["codex"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "install",
            engramBin: fakeBin,
            showSummary: false,
          });
          expect(code).toBe(1);
          expect(count.calls).toBe(0);
          // Preflight before Stack writes: no Stack files in the custom dir,
          // no manifest claiming success, default personal dir untouched.
          expect(fs.existsSync(path.join(customDir, "AGENTS.md"))).toBe(false);
          expect(fs.existsSync(path.join(customDir, "config.toml"))).toBe(false);
          expect(fs.existsSync(path.join(customDir, "hooks.json"))).toBe(false);
          expect(fs.existsSync(path.join(homeDir, ".codex"))).toBe(false);
          expect(fs.readFileSync(fakeBin, "utf8")).toBe(beforeBin);
          const errors = [
            ...promptsMock.log.error.mock.calls.flat(),
            ...promptsMock.log.warn.mock.calls.flat(),
          ].join("\n");
          expect(errors).toMatch(/CODEX_HOME/);
          expect(errors).toMatch(/ignor/i);
        } finally {
          codex.detect = origCodexDetect;
          claudeCode.detect = origClaudeDetect;
          opencode.detect = origOpenDetect;
          if (original === undefined) delete verifiers["codex"];
          else verifiers["codex"] = original;
        }
      });
    } finally {
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
      if (prevOpencode === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prevOpencode;
    }
    void tmp;
  });

  it("control: sync with custom Codex config remains allowed and never invokes setup", async () => {
    const tmp = tempDir("jx-codex-home-sync-");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const customDir = path.join(homeDir, "custom-codex");
    fs.mkdirSync(customDir, { recursive: true });
    const fakeBin = path.join(homeDir, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, FAKE_BIN_SCRIPT);

    const prevCodex = process.env.CODEX_HOME;
    const prevClaude = process.env.CLAUDE_CONFIG_DIR;
    const prevOpencode = process.env.OPENCODE_CONFIG_DIR;
    process.env.CODEX_HOME = customDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const setup = await import("../src/lib/official-engram-setup.js");
        await import("../src/adapters/codex.js");
        const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
        const original = verifiers["codex"];
        const count = { calls: 0 };
        verifiers["codex"] = async () => {
          count.calls++;
          return { ok: true, layers: ["plugin"] };
        };
        const claudeCode = install.ADAPTERS["claude-code"]!;
        const opencode = install.ADAPTERS.opencode!;
        const origClaude = claudeCode.detect;
        const origOpen = opencode.detect;
        claudeCode.detect = () => ({
          id: "claude-code",
          name: "Claude Code",
          installed: false,
          binPath: null,
          configDir: path.join(homeDir, ".claude"),
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
            runtimes: ["codex"],
            dryRun: false,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "sync",
            engramBin: fakeBin,
            showSummary: false,
          });
          expect(code).toBe(0);
          expect(count.calls).toBe(0);
        } finally {
          claudeCode.detect = origClaude;
          opencode.detect = origOpen;
          if (original === undefined) delete verifiers["codex"];
          else verifiers["codex"] = original;
        }
      });
    } finally {
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaude;
      if (prevOpencode === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prevOpencode;
    }
    void tmp;
  });

  it("control: dry-run with custom Codex config remains allowed and never invokes setup", async () => {
    const tmp = tempDir("jx-codex-home-dry-");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const customDir = path.join(homeDir, "custom-codex");
    fs.mkdirSync(customDir, { recursive: true });
    const fakeBin = path.join(homeDir, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, FAKE_BIN_SCRIPT);

    const prevCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = customDir;
    try {
      await withTempHome(homeDir, async () => {
        const install = await import("../src/install.js");
        const setup = await import("../src/lib/official-engram-setup.js");
        await import("../src/adapters/codex.js");
        const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
        const original = verifiers["codex"];
        const count = { calls: 0 };
        verifiers["codex"] = async () => {
          count.calls++;
          return { ok: true, layers: ["plugin"] };
        };
        try {
          vi.clearAllMocks();
          const code = await install.runInstall({
            runtimes: ["codex"],
            dryRun: true,
            yes: true,
            mode: { mode: "human", subagentConcurrency: "serial" },
            command: "install",
            engramBin: fakeBin,
            showSummary: false,
          });
          expect(code).toBe(0);
          expect(count.calls).toBe(0);
          expect(fs.existsSync(path.join(customDir, "AGENTS.md"))).toBe(false);
        } finally {
          if (original === undefined) delete verifiers["codex"];
          else verifiers["codex"] = original;
        }
      });
    } finally {
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
    }
    void tmp;
  });

  it("control: target-dir with custom location remains allowed and never invokes setup", async () => {
    const tmp = tempDir("jx-codex-home-target-");
    const homeDir = path.join(tmp, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const targetDir = path.join(tmp, "target-codex");
    fs.mkdirSync(targetDir, { recursive: true });
    const fakeBin = path.join(homeDir, ".local", "bin", "engram");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, FAKE_BIN_SCRIPT);

    await withTempHome(homeDir, async () => {
      const install = await import("../src/install.js");
      const setup = await import("../src/lib/official-engram-setup.js");
      await import("../src/adapters/codex.js");
      const verifiers = setup.officialSetupVerifiers as Record<string, unknown>;
      const original = verifiers["codex"];
      const count = { calls: 0 };
      verifiers["codex"] = async () => {
        count.calls++;
        return { ok: true, layers: ["plugin"] };
      };
      try {
        vi.clearAllMocks();
        const code = await install.runInstall({
          runtimes: ["codex"],
          targetDir,
          dryRun: false,
          yes: true,
          mode: { mode: "human", subagentConcurrency: "serial" },
          command: "install",
          engramBin: fakeBin,
          showSummary: false,
        });
        expect(code).toBe(0);
        expect(count.calls).toBe(0);
      } finally {
        if (original === undefined) delete verifiers["codex"];
        else verifiers["codex"] = original;
      }
    });
    void tmp;
  });
});

// ---------------------------------------------------------------------------
// 3) Default Codex child env omits inherited CODEX_HOME (real env-patch seam)
// ---------------------------------------------------------------------------

describe("[codex-home-3] default Codex setup env omits inherited CODEX_HOME", () => {
  it("resolve returns deletion marker and real spawn child reports absent despite inherited parent var", async () => {
    const home = tempHome("jx-codex-home-omit-");
    const configDir = path.join(home, ".codex");
    fs.mkdirSync(configDir, { recursive: true });
    const inherited = path.join(home, "inherited-custom-codex");
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = inherited;
    try {
      const mod = await import("../src/lib/official-engram-setup.js");
      const setupEnv = (mod.resolveOfficialSetupEnv as unknown as CallableFunction)(
        "codex",
        configDir,
        home,
      ) as Record<string, string | undefined>;
      expect("CODEX_HOME" in setupEnv).toBe(true);
      expect(setupEnv["CODEX_HOME"]).toBeUndefined();

      const probeBin = makeProbeBin();
      const result = await (mod.spawnOfficialSetupBin as unknown as CallableFunction)(
        probeBin,
        [],
        setupEnv,
      );
      expect(result.ok).toBe(true);
      expect(String(result.stdout).trim()).toBe("absent");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it("control: public runtime default stays <home>/.codex when CODEX_HOME is unset", async () => {
    const home = tempHome("jx-codex-home-default-align-");
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevCodex = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CODEX_HOME;
    try {
      vi.resetModules();
      const { detectCodex } = await import("../src/lib/detect.js");
      const detection = detectCodex();
      expect(detection.configDir).toBe(path.join(home, ".codex"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
      vi.resetModules();
    }
  });
});
