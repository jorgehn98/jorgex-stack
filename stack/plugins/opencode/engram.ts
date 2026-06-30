/**
 * Engram — OpenCode plugin adapter
 *
 * Thin layer that connects OpenCode's event system to the Engram Go binary.
 * The Go binary runs as a local HTTP server and handles all persistence.
 *
 * Flow:
 *   OpenCode events → this plugin → HTTP calls → engram serve → SQLite
 *
 * Session resilience:
 *   Uses `ensureSession()` before any DB write. This means sessions are
 *   created on-demand — even if the plugin was loaded after the session
 *   started (restart, reconnect, etc.). The session ID comes from OpenCode's
 *   hooks (input.sessionID) rather than relying on a session.created event.
 */

import type { Plugin } from "@opencode-ai/plugin"

declare const Bun: {
  which?: (bin: string) => string | null
  spawnSync: (args: string[], options?: Record<string, unknown>) => { exitCode: number; stdout?: { toString(): string } | string }
  spawn: (args: string[], options?: Record<string, unknown>) => unknown
  file: (path: string) => { exists: () => Promise<boolean> }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const ENGRAM_PORT = parseInt(process.env.ENGRAM_PORT ?? "7437")
const ENGRAM_URL = `http://127.0.0.1:${ENGRAM_PORT}`
// "{{ENGRAM_BIN}}" lo resuelve el instalador con el binario detectado (D7).
const ENGRAM_BIN = "{{ENGRAM_BIN}}"

export function resolveEngramBin(installerBin = ENGRAM_BIN): string {
  const envBin = process.env.ENGRAM_BIN
  if (envBin) return envBin

  const bun = globalThis as typeof globalThis & { Bun?: { which?: (bin: string) => string | null } }
  const bunBin = bun.Bun?.which?.("engram")
  if (bunBin) return bunBin

  return installerBin !== "{{ENGRAM_BIN}}" ? installerBin : "engram"
}

// Engram's own MCP tools — don't count these as "tool calls" for session stats
const ENGRAM_TOOLS = new Set([
  "mem_search",
  "mem_save",
  "mem_update",
  "mem_delete",
  "mem_suggest_topic_key",
  "mem_save_prompt",
  "mem_session_summary",
  "mem_context",
  "mem_stats",
  "mem_timeline",
  "mem_get_observation",
  "mem_session_start",
  "mem_session_end",
])

// ─── Memory Instructions ─────────────────────────────────────────────────────
// These get injected into the agent's context so it knows to call mem_save.
// El placeholder ENGRAM_PROTOCOL lo resuelve el instalador con el contenido
// del protocolo canónico (stack/system-prompt/engram-protocol.md) — única
// fuente, alineada automáticamente con lo que reciben Claude Code y Codex.

const MEMORY_INSTRUCTIONS = "{{ENGRAM_PROTOCOL}}"

// ─── HTTP Client ─────────────────────────────────────────────────────────────

async function engramFetch(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<any> {
  try {
    const res = await fetch(`${ENGRAM_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    // Engram server not running — silently fail
    return null
  }
}

async function isEngramRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGRAM_URL}/health`, {
      signal: AbortSignal.timeout(500),
    })
    return res.ok
  } catch {
    return false
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractProjectName(directory: string): string {
  // Try git remote origin URL
  try {
    const result = Bun.spawnSync(["git", "-C", directory, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    if (result.exitCode === 0) {
      const url = result.stdout?.toString().trim()
      if (url) {
        const name = url.replace(/\.git$/, "").split(/[/:]/).pop()
        if (name) return name
      }
    }
  } catch {}

  // Fallback: git root directory name (works in worktrees)
  try {
    const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    if (result.exitCode === 0) {
      const root = result.stdout?.toString().trim()
      if (root) return root.split(/[\\/]/).pop() ?? "unknown"
    }
  } catch {}

  // Final fallback: cwd basename
  return directory.split(/[\\/]/).pop() ?? "unknown"
}

function truncate(str: string, max: number): string {
  if (!str) return ""
  return str.length > max ? str.slice(0, max) + "..." : str
}

/**
 * Strip <private>...</private> tags before sending to engram.
 * Double safety: the Go binary also strips, but we strip here too
 * so sensitive data never even hits the wire.
 */
function stripPrivateTags(str: string): string {
  if (!str) return ""
  return str.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]").trim()
}

function logToOpenCode(client: unknown, level: string, message: string, extra?: unknown): void {
  try {
    (client as any)?.app?.log({ body: { service: "engram", level, message, extra } })
  } catch {}
}

// ─── Plugin Export ───────────────────────────────────────────────────────────

export const Engram: Plugin = async (ctx) => {
  const oldProject = ctx.directory.split(/[\\/]/).pop() ?? "unknown"
  const project = extractProjectName(ctx.directory)
  const client = (ctx as { client?: unknown }).client
  const engramBin = resolveEngramBin()

  // Track tool counts per session (in-memory only, not critical)
  const toolCounts = new Map<string, number>()

  // Track which sessions we've already ensured exist in engram
  const knownSessions = new Set<string>()

  // Track sub-agent session IDs so we can suppress their tool-hook registrations.
  // Sub-agents (Task() calls) have a parentID or a title ending in " subagent)".
  // We must not register them as top-level Engram sessions — they cause session
  // inflation (e.g. 170 sessions for 1 real conversation, issue #116).
  const subAgentSessions = new Set<string>()

  /**
   * Ensure a session exists in engram. Idempotent — calls POST /sessions
   * which uses INSERT OR IGNORE. Safe to call multiple times.
   *
   * Silently skips sub-agent sessions (tracked in `subAgentSessions`).
   */
  async function ensureSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false
    if (knownSessions.has(sessionId)) return true
    // Do not register sub-agent sessions in Engram (issue #116).
    if (subAgentSessions.has(sessionId)) return false
    const session = await engramFetch("/sessions", {
      method: "POST",
      body: {
        id: sessionId,
        project,
        directory: ctx.directory,
      },
    })

    if (session === null) return false

    knownSessions.add(sessionId)
    return true
  }

  // Try to start engram server if not running
  const running = await isEngramRunning()
  if (!running) {
    try {
      Bun.spawn([engramBin, "serve"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
      await new Promise((r) => setTimeout(r, 500))
    } catch {
      // Binary not found or can't start — plugin will silently no-op
    }
  }

  // Migrate project name if it changed (one-time, idempotent)
  // Must run AFTER server startup to ensure the endpoint is available
  if (oldProject !== project) {
    await engramFetch("/projects/migrate", {
      method: "POST",
      body: { old_project: oldProject, new_project: project },
    })
  }

  // Auto-import: if .engram/manifest.json exists in the project repo,
  // run `engram sync --import` to load any new chunks into the local DB.
  // This is how git-synced memories get loaded when cloning a repo or
  // pulling changes. Each chunk is imported only once (tracked by ID).
  try {
    const manifestFile = `${ctx.directory}/.engram/manifest.json`
    const file = Bun.file(manifestFile)
    if (await file.exists()) {
      Bun.spawn([engramBin, "sync", "--import"], {
        cwd: ctx.directory,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
    }
  } catch {
    // Manifest doesn't exist or binary not found — silently skip
  }

  const safe = <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try { await fn(...args) }
      catch (error) { void logToOpenCode(client, "error", `Engram hook ${name} failed`, error) }
    }

  return {
    // ─── Event Listeners ───────────────────────────────────────────

    event: safe("event", async ({ event }: { event: { type: string; properties?: unknown } }) => {
      // --- Session Created ---
      if (event.type === "session.created") {
        // Bug fix (#116): session data is nested under event.properties.info,
        // not event.properties directly.
        const info = (event.properties as any)?.info
        const sessionId = info?.id
        const parentID = info?.parentID
        const title: string = info?.title ?? ""

        // Sub-agent sessions (created via Task()) must NOT be registered as
        // top-level Engram sessions. They cause massive session inflation
        // (e.g. 170 sessions for 1 real conversation).
        //
        // Detection heuristics:
        //   - parentID is set on all Task() sub-agent sessions
        //   - title ends with " subagent)" as a secondary signal
        const isSubAgent = !!parentID || title.endsWith(" subagent)")

        if (sessionId && !isSubAgent) {
          await ensureSession(sessionId)
        } else if (sessionId && isSubAgent) {
          // Remember this as a sub-agent session so tool-hook calls
          // to ensureSession() are also suppressed for it.
          subAgentSessions.add(sessionId)
        }
      }

      // --- Session Deleted ---
      if (event.type === "session.deleted") {
        // Same properties.info path as session.created.
        const info = (event.properties as any)?.info
        const sessionId = info?.id
        if (sessionId) {
          toolCounts.delete(sessionId)
          knownSessions.delete(sessionId)
          subAgentSessions.delete(sessionId)
        }
      }

    }),

    // ─── User Prompt Capture ──────────────────────────────────────
    // chat.message is called once per user message, before the LLM sees it.
    // input.sessionID is always reliable here (no knownSessions workaround).
    // output.message is typed as UserMessage (role:"user" already guaranteed).
    // output.parts contains TextPart[] with the actual message text.

    "chat.message": safe("chat.message", async (input: any, output: any) => {
      // Skip sub-agent sessions — they inflate session counts (issue #116)
      if (subAgentSessions.has(input.sessionID)) return

      const sessionId = input.sessionID

      // Extract text from parts (type:"text")
      const content = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text ?? "")
        .join("\n")
        .trim()

      // Also fallback to summary if parts yield nothing
      const fallback = !content && output.message.summary
        ? `${output.message.summary.title ?? ""}\n${output.message.summary.body ?? ""}`.trim()
        : ""

      const finalContent = content || fallback

      // Only capture non-trivial prompts (>10 chars)
      if (finalContent.length > 10) {
        const sessionReady = await ensureSession(sessionId)
        if (sessionReady) {
          await engramFetch("/prompts", {
            method: "POST",
            body: {
              session_id: sessionId,
              content: stripPrivateTags(truncate(finalContent, 2000)),
              project,
            },
          })
        }
      }
    }),

    // ─── Tool Execution Hook ─────────────────────────────────────
    // Count tool calls per session (for session end stats).
    // Also ensures the session exists — handles plugin reload / reconnect.
    // Passive capture: when a Task tool completes, POST its output to
    // the passive capture endpoint so the server extracts learnings.

    "tool.execute.after": safe("tool.execute.after", async (input: any, output: any) => {
      if (ENGRAM_TOOLS.has(input.tool.toLowerCase())) return

      // input.sessionID comes from OpenCode — always available
      const sessionId = input.sessionID
      const sessionReady = sessionId ? await ensureSession(sessionId) : false
      if (sessionReady && sessionId) {
        toolCounts.set(sessionId, (toolCounts.get(sessionId) ?? 0) + 1)
      }

      // Passive capture: extract learnings from Task tool output
      // (OpenCode reports the tool name in lowercase: "task")
      if (input.tool.toLowerCase() === "task" && output && sessionId) {
        const text = typeof output === "string" ? output : JSON.stringify(output)
        if (text.length > 50 && sessionReady) {
          await engramFetch("/observations/passive", {
            method: "POST",
            body: {
              session_id: sessionId,
              content: stripPrivateTags(text),
              project,
              source: "task-complete",
            },
          })
        }
      }
    }),

    // ─── System Prompt: Always-on memory instructions ──────────
    // Injects MEMORY_INSTRUCTIONS into the system prompt of every message.
    // This ensures the agent ALWAYS knows about Engram, even after compaction.
    //
    // We append to the last existing system entry instead of pushing a new one.
    // Some models (Qwen3.5, Mistral/Ministral via llama.cpp) reject multiple
    // system messages — their Jinja chat templates only allow a single system
    // block at the beginning. By concatenating, we avoid adding extra system
    // messages that would break these models. See: GitHub issue #23.

    "experimental.chat.system.transform": safe("experimental.chat.system.transform", async (_input: any, output: any) => {
      if (output.system.length > 0) {
        output.system[output.system.length - 1] += "\n\n" + MEMORY_INSTRUCTIONS
      } else {
        output.system.push(MEMORY_INSTRUCTIONS)
      }
    }),

    // ─── Compaction Hook: Persist memory + inject context ──────────
    // Compaction is triggered by the system (not the agent) when context
    // gets too long. The old agent "dies" and a new one starts with the
    // compacted summary. This is our chance to:
    // 1. Auto-save a session checkpoint (the agent can't do this itself)
    // 2. Inject context from previous sessions into the compaction prompt
    // 3. Tell the compressor to remind the new agent to save memories

    "experimental.session.compacting": safe("experimental.session.compacting", async (input: any, output: any) => {
      if (input.sessionID) {
        await ensureSession(input.sessionID)
      }

      // Inject context from previous sessions
      const data = await engramFetch(
        `/context?project=${encodeURIComponent(project)}`
      )
      if (data?.context) {
        output.context.push(data.context)
      }

      // Tell the compressor to instruct the new agent to persist the
      // compacted summary to Engram. The new agent reads the compacted
      // summary and this instruction, then saves it as a session summary.
      output.context.push(
        `CRITICAL INSTRUCTION FOR COMPACTED SUMMARY:\n` +
        `The agent has access to Engram persistent memory via MCP tools.\n` +
        `You MUST include the following instruction at the TOP of the compacted summary:\n\n` +
        `"FIRST ACTION REQUIRED: Call mem_session_summary with the content of this compacted summary. ` +
        `Use project '${project}' if the tool accepts it. This preserves what was accomplished before compaction. ` +
        `Do this BEFORE any other work. After that, delegate to the global engram subagent to recover only the relevant previous context."\n\n` +
        `This is NOT optional. Without this, everything done before compaction is lost from memory.`
      )
    }),
  }
}
