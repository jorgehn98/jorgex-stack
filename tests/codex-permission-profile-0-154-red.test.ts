import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { readTomlSection } from "../src/lib/filemerge.js";
import { loadCanonicalMcp } from "../src/lib/canonical.js";
import { DEFAULT_MODEL_MAP } from "../src/lib/model-map.js";
import { stackRoot } from "../src/lib/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorgex-codex-0154-"));
  tempDirs.push(dir);
  return dir;
}

function freshConfigContent(): { content: string; warnings: string[] } {
  const configDir = tempConfigDir();
  const ctx = {
    stackDir: stackRoot(),
    configDir,
    engramBin: null,
    models: DEFAULT_MODEL_MAP.codex,
    warnings: [] as string[],
  };
  const [action] = codexAdapter.planMainConfig(loadCanonicalMcp(stackRoot()), ctx);
  if (action?.kind !== "write") throw new Error("Expected a Codex config write");
  return { content: action.content, warnings: ctx.warnings };
}

function parseTomlKeyValues(section: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  if (section === null) return entries;
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const rawKey = line.slice(0, equals).trim();
    const rawValue = line.slice(equals + 1).trim().replace(/\s+#.*$/, "");
    let key: string;
    try {
      key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
    } catch {
      key = rawKey;
    }
    let value: string;
    try {
      value = JSON.parse(rawValue) as string;
    } catch {
      value = rawValue;
    }
    entries.set(key, value);
  }
  return entries;
}

const HOME_SECRET_DENIES = ["~/.ssh/**", "~/.aws/credentials", "~/.npmrc", "~/.git-credentials"] as const;

const WORKSPACE_SECRET_DENIES = [
  "*.env",
  "*.env.*",
  ".ssh/**",
  ".aws/credentials",
  ".npmrc",
  ".git-credentials",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*.pem",
  "**/*.key",
] as const;

const RELATIVE_SECRET_GLOBS = ["*.env", "*.env.*", "**/id_rsa", "**/id_ed25519", "**/*.pem", "**/*.key"] as const;

function isValidDirectFilesystemKey(key: string): boolean {
  return key.startsWith("/") || key.startsWith("~/") || key.startsWith(":");
}

/**
 * Codex 0.154 (real CLI): direct keys under
 * [permissions.jorgex-read-anywhere.filesystem] must be absolute, start with
 * ~/ , or be the special : keys. Relative secret globs materialize per
 * workspace, so they belong only under
 * [permissions.jorgex-read-anywhere.filesystem.":workspace_roots"].
 */
describe("codex 0.154 permission profile contract (RED)", () => {
  it("emits only absolute/~/: keys in filesystem and keeps relative secret globs in :workspace_roots", () => {
    const { content } = freshConfigContent();

    const filesystem = parseTomlKeyValues(
      readTomlSection(content, "permissions.jorgex-read-anywhere.filesystem"),
    );
    const workspaceRoots = parseTomlKeyValues(
      readTomlSection(content, "permissions.jorgex-read-anywhere.filesystem.:workspace_roots"),
    );

    expect(filesystem.size, "missing [permissions.jorgex-read-anywhere.filesystem]").toBeGreaterThan(0);
    expect(workspaceRoots.size, 'missing [permissions.jorgex-read-anywhere.filesystem.":workspace_roots"]').toBeGreaterThan(0);

    // Preserve read-anywhere root.
    expect(filesystem.get(":root")).toBe("read");

    // Preserve home secret denies at the filesystem level.
    for (const key of HOME_SECRET_DENIES) {
      expect(filesystem.get(key), `missing filesystem deny ${key}`).toBe("deny");
    }

    // Preserve every workspace secret deny (plus writable workspace root).
    expect(workspaceRoots.get(".")).toBe("write");
    for (const key of WORKSPACE_SECRET_DENIES) {
      expect(workspaceRoots.get(key), `missing workspace deny ${key}`).toBe("deny");
    }

    // 0.154 rule: no relative globs directly under filesystem.
    const invalid = [...filesystem.keys()].filter((key) => !isValidDirectFilesystemKey(key));
    expect(invalid, `relative globs must not live directly under filesystem (Codex 0.154): ${invalid.join(", ")}`).toEqual([]);

    // Relative secret globs live only in :workspace_roots.
    for (const key of RELATIVE_SECRET_GLOBS) {
      expect(filesystem.has(key), `${key} must not be a direct filesystem key`).toBe(false);
      expect(workspaceRoots.get(key), `${key} must stay denied per workspace`).toBe("deny");
    }
  });
});
