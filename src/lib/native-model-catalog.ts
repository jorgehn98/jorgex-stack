import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeId } from "../adapters/types.js";
import { planDetectedBinCommand } from "./detect.js";

export interface AvailableModel { id: string; name: string; efforts?: string[] }
export interface ModelCatalog { models: AvailableModel[]; warning?: string }
const failure = () => new Error("Catálogo nativo inaccesible o inválido; revisa conexión, autenticación y versión del runtime. No se ha verificado acceso a ningún modelo.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw failure();
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw failure();
  return value.map(identifier);
}

/** Deliberately discard response headers, bodies and every non-display field. */
export function normalizeModels(runtime: RuntimeId, value: unknown): AvailableModel[] {
  const rows = runtime === "claude-code" ? value : record(value)[runtime === "pi" ? "models" : "data"];
  if (!Array.isArray(rows)) throw failure();
  return rows.map((row) => {
    const item = record(row);
    const id = runtime === "claude-code" ? identifier(item.value)
      : runtime === "codex" ? identifier(item.model)
      : `${identifier(runtime === "pi" ? item.provider : item.providerID)}/${identifier(item.id)}`;
    const name = identifier(runtime === "claude-code" || runtime === "codex" ? item.displayName : item.name);
    let efforts: string[] | undefined;
    if (runtime === "claude-code" && item.supportedEffortLevels !== undefined) efforts = strings(item.supportedEffortLevels);
    if (runtime === "codex" && item.supportedReasoningEfforts !== undefined) {
      if (!Array.isArray(item.supportedReasoningEfforts)) throw failure();
      efforts = item.supportedReasoningEfforts.map((effort) => identifier(record(effort).reasoningEffort));
    }
    if (runtime === "opencode") {
      if (!Array.isArray(item.variants)) throw failure();
      efforts = item.variants.map((variant) => identifier(record(variant).id));
    }
    return { id, name, ...(efforts !== undefined ? { efforts } : {}) };
  });
}
export type CatalogRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export async function listCodexModels(request: CatalogRequest): Promise<AvailableModel[]> {
  const models: AvailableModel[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = record(await request("model/list", { cursor, limit: 100 }));
    models.push(...normalizeModels("codex", page));
    cursor = page.nextCursor === null || page.nextCursor === undefined ? null : identifier(page.nextCursor);
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error("Paginación del catálogo inválida o excesiva.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

export async function listPiModels(request: CatalogRequest): Promise<AvailableModel[]> {
  const models = normalizeModels("pi", await request("get_available_models", {}));
  const state = record(await request("get_state", {}));
  if (state.model) {
    const active = record(state.model);
    const current = models.find((model) => model.id === `${identifier(active.provider)}/${identifier(active.id)}`);
    if (current) current.efforts = strings(record(await request("get_available_thinking_levels", {})).levels);
  }
  return models;
}

/** One owned stdio process, no threads/turns/prompts and no persistent session. */
export async function stdioCatalog(runtime: "codex" | "pi", bin: string, cwd: string, signal: AbortSignal): Promise<AvailableModel[]> {
  if (signal.aborted) throw failure();
  const invocation = planDetectedBinCommand(bin, runtime === "codex" ? ["app-server"] : ["--mode", "rpc", "--no-session"]);
  if (!invocation) throw failure();
  const child = spawn(invocation.command, invocation.args, { cwd, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  let buffered = 0;
  let pending: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    pending?.reject(failure());
    if (child.pid) {
      if (process.platform === "win32") {
        const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { timeout: 3000, stdio: "ignore", windowsHide: true });
        if (result.error || result.status !== 0) child.kill("SIGKILL");
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  child.on("error", stop);
  child.stdin.on("error", stop);
  child.on("exit", stop);
  child.stdout.on("data", (chunk: Buffer) => { buffered += chunk.length; if (buffered > 4 * 1024 * 1024) stop(); });
  lines.on("line", (line) => {
    let response: Record<string, unknown>;
    try { response = record(JSON.parse(line)); } catch { stop(); return; }
    if (!pending || String(response.id) !== pending.id) return;
    const waiter = pending;
    pending = undefined;
    if (response.error || (runtime === "pi" && response.success !== true)) waiter.reject(failure());
    else waiter.resolve(runtime === "pi" ? response.data : response.result);
  });
  const request: CatalogRequest = (method, params) => new Promise((resolve, reject) => {
    if (signal.aborted || stopped) { reject(failure()); return; }
    const id = String(++nextId);
    pending = { id, resolve, reject };
    child.stdin.write(JSON.stringify(runtime === "pi" ? { id, type: method, ...params } : { id, method, params }) + "\n");
  });
  try {
    if (runtime === "codex") {
      await request("initialize", { clientInfo: { name: "jorgex-stack", title: "Stack model selector", version: "1" } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      return await listCodexModels(request);
    }
    return await listPiModels(request);
  } finally {
    stop(); lines.close(); child.stdin.destroy(); child.stdout.destroy();
    signal.removeEventListener("abort", stop);
    // Reaping is bounded even when a platform refuses to terminate a process.
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}

export async function discoverModels(runtime: RuntimeId, bin: string, cwd = process.cwd(), server = "http://127.0.0.1:4096"): Promise<ModelCatalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let models: AvailableModel[];
    if (runtime === "claude-code") {
      // Keep the stream open without ever sending a user message to an LLM.
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const prompt = (async function* () { await done; })();
      const client = query({ prompt, options: { cwd, pathToClaudeCodeExecutable: bin, persistSession: false, abortController: controller, settingSources: ["user", "project", "local"], stderr: () => {} } });
      let rejectTimeout!: (error: Error) => void;
      const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      const close = () => { finish(); client.close(); };
      const abort = () => { rejectTimeout(failure()); close(); };
      controller.signal.addEventListener("abort", abort, { once: true });
      try { models = normalizeModels(runtime, await Promise.race([client.supportedModels(), timeout])); }
      finally { close(); controller.signal.removeEventListener("abort", abort); }
    } else if (runtime === "opencode") {
      const url = new URL(server);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw failure();
      url.pathname = "/api/model"; url.search = "";
      url.searchParams.set("location[directory]", cwd);
      const response = await fetch(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw failure();
      const reader = response.body?.getReader();
      if (!reader) throw failure();
      let text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length > 4 * 1024 * 1024) throw failure();
        }
        models = normalizeModels(runtime, JSON.parse(text + decoder.decode()));
      } finally { await reader.cancel(); }
    } else models = await stdioCatalog(runtime, bin, cwd, controller.signal);
    return { models, ...(runtime === "pi" ? { warning: "Pi: niveles solo del modelo activo; no se ha cambiado el principal." } : runtime === "opencode" ? { warning: "OpenCode: API experimental, snapshot por ubicación; plugins pueden seguir cargando. Variantes no equivalen a una escala universal." } : runtime === "codex" ? { warning: "Codex: app-server model/list experimental; no acredita entitlement." } : {}) };
  } catch { return { models: [], warning: failure().message }; }
  finally { clearTimeout(timer); controller.abort(); }
}
