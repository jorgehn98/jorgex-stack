import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createGoalStore } from "./goal/store.js";
import { createOpenCodeGoalHooks } from "./goal/opencode-hooks.js";

interface GoalPluginLogger {
  warn?: (message: string, details?: unknown) => void;
  error?: (message: string, details?: unknown) => void;
}

export function resolveGoalProjectName(directory: string, logger?: GoalPluginLogger): string {
  try {
    const remote = execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const name = parseRemoteProjectKey(remote);
    if (name) return name;
    logger?.warn?.("Goal Mode could not parse origin URL; falling back to local project key.", {
      directory,
      remote,
    });
  } catch (error) {
    logger?.warn?.("Goal Mode project remote lookup failed; falling back to local project key.", error);
    // Fallback below.
  }

  try {
    const commonDir = execFileSync("git", ["-C", directory, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const absolute = path.resolve(directory, commonDir);
    return `local:${createHash("sha256").update(absolute.toLowerCase()).digest("hex").slice(0, 16)}`;
  } catch (error) {
    logger?.warn?.("Goal Mode git-common-dir lookup failed; falling back to directory project key.", error);
    return `local:${createHash("sha256").update(path.resolve(directory).toLowerCase()).digest("hex").slice(0, 16)}`;
  }
}

function parseRemoteProjectKey(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/, "");
  const githubMatch = /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)$/i.exec(normalized);
  if (githubMatch?.groups?.owner && githubMatch.groups.repo) {
    return `${githubMatch.groups.owner}/${githubMatch.groups.repo}`;
  }
  const genericMatch = /[:/]([^/:]+\/[^/]+)$/.exec(normalized);
  return genericMatch?.[1];
}

export const GoalModePlugin = async (ctx: { directory: string; client?: unknown }) => {
  const logger = createGoalPluginLogger(ctx.client);
  const databasePath = resolveGoalDatabasePath(process.env.JORGEX_GOAL_DB);
  const store = createGoalStore({ databasePath });
  try {
    store.migrate();
    const project = resolveGoalProjectName(ctx.directory, logger);

    return createOpenCodeGoalHooks({
      store,
      project,
      artifactsRootDir: path.join(os.homedir(), ".jorgex-stack", "goals", "artifacts", safePathSegment(project)),
      sessionClient: extractSessionClient(ctx.client),
      logger,
    });
  } catch (error) {
    store.close();
    throw error;
  }
};

function createGoalPluginLogger(client: unknown): GoalPluginLogger {
  return {
    warn: (message, details) => {
      void logToOpenCode(client, "warn", message, details);
      console.warn(message, details);
    },
    error: (message, details) => {
      void logToOpenCode(client, "error", message, details);
      console.error(message, details);
    },
  };
}

async function logToOpenCode(client: unknown, level: "warn" | "error", message: string, details?: unknown): Promise<void> {
  if (typeof client !== "object" || client === null) return;
  const app = (client as { app?: unknown }).app;
  if (typeof app !== "object" || app === null) return;
  const log = (app as { log?: unknown }).log;
  if (typeof log !== "function") return;
  try {
    await log.call(app, {
      body: {
        service: "goal-mode",
        level,
        message,
        extra: details,
      },
    });
  } catch {
    // Logging must never break the plugin path.
  }
}

export function resolveGoalDatabasePath(overridePath?: string): string {
  const goalRoot = path.join(os.homedir(), ".jorgex-stack", "goals");
  const requested = overridePath ?? path.join(goalRoot, "goals.sqlite");
  const resolved = path.resolve(requested);
  const resolvedGoalRoot = resolveExistingPath(goalRoot);
  const resolvedEngramRoot = resolveExistingPath(path.join(os.homedir(), ".engram"));
  const resolvedParent = resolveExistingPath(path.dirname(resolved));
  const fileStats = lstatIfExists(resolved);
  if (fileStats?.isSymbolicLink()) {
    throw new Error("JORGEX_GOAL_DB must not point to a symlink.");
  }
  if (fileStats?.isFile() && fileStats.nlink > 1) {
    throw new Error("JORGEX_GOAL_DB must not point to a hard link.");
  }
  const resolvedFile = fileStats ? fs.realpathSync(resolved) : resolved;

  if (!isContainedIn(resolvedParent, resolvedGoalRoot)) {
    throw new Error(`JORGEX_GOAL_DB must stay inside ${goalRoot}. Refusing: ${requested}`);
  }
  if (!isContainedIn(resolvedFile, resolvedGoalRoot)) {
    throw new Error(`JORGEX_GOAL_DB must stay inside ${goalRoot}. Refusing: ${requested}`);
  }
  if (isContainedIn(resolvedParent, resolvedEngramRoot) || isContainedIn(resolvedFile, resolvedEngramRoot)) {
    throw new Error("JORGEX_GOAL_DB must not point inside ~/.engram.");
  }

  return resolved;
}

function lstatIfExists(input: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function resolveExistingPath(input: string): string {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    missing.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return missing.reduceRight((base, part) => path.join(base, part), real);
}

function isContainedIn(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "goal";
}

function extractSessionClient(client: unknown) {
  if (typeof client !== "object" || client === null) return undefined;
  const session = (client as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return undefined;
  const promptAsync = (session as { promptAsync?: unknown }).promptAsync;
  return typeof promptAsync === "function"
    ? { promptAsync: (input: { prompt: string; sessionID?: string }) => promptAsync.call(session, input) }
    : undefined;
}
