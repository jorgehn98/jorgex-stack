import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createGoalStore } from "./goal/store.js";
import { createOpenCodeGoalHooks } from "./goal/opencode-hooks.js";

export function resolveGoalProjectName(directory: string): string {
  try {
    const remote = execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const name = parseRemoteProjectKey(remote);
    if (name) return name;
  } catch {
    // Fallback below.
  }

  try {
    const commonDir = execFileSync("git", ["-C", directory, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const absolute = path.resolve(directory, commonDir);
    return `local:${createHash("sha256").update(absolute.toLowerCase()).digest("hex").slice(0, 16)}`;
  } catch {
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
  const databasePath =
    process.env.JORGEX_GOAL_DB ??
    path.join(os.homedir(), ".jorgex-stack", "goals", "goals.sqlite");
  const store = createGoalStore({ databasePath });
  store.migrate();

  return createOpenCodeGoalHooks({
    store,
    project: resolveGoalProjectName(ctx.directory),
    sessionClient: extractSessionClient(ctx.client),
  });
};

function extractSessionClient(client: unknown) {
  if (typeof client !== "object" || client === null) return undefined;
  const session = (client as { session?: unknown }).session;
  if (typeof session !== "object" || session === null) return undefined;
  const promptAsync = (session as { promptAsync?: unknown }).promptAsync;
  return typeof promptAsync === "function"
    ? { promptAsync: (input: { prompt: string; sessionID?: string }) => promptAsync.call(session, input) }
    : undefined;
}
