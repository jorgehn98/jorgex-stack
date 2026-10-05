import fs from "node:fs";
import type { RuntimeId } from "../adapters/types.js";
import { createBackup } from "./backup.js";
import { assertProjectionPath, diffPlan, applyChanges } from "../install.js";

/** In-memory render inputs only. Preferences live in each runtime's native agent file. */
export interface AgentModel { model?: string; variant?: string }
export interface AgentModelChoices { overrides?: Record<string, AgentModel> }
export function agentModelChoice(models: AgentModelChoices, agentName: string): AgentModel {
  return models.overrides?.[agentName] ?? {};
}

function invalid(): never { throw new Error("Configuración nativa del agente inválida o ambigua; corrige o restaura antes de editar."); }
function scalar(value: string, toml: boolean): string {
  const raw = value.trim();
  if (raw.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
    if (!quoted) return invalid();
    try { const result: unknown = JSON.parse(quoted[1]!); if (typeof result === "string") return result; } catch { /* Never expose malformed preference bytes. */ }
    return invalid();
  }
  if (raw.startsWith("'")) {
    const quoted = /^('(?:[^']|'')*')\s*(?:#.*)?$/.exec(raw);
    if (!quoted) return invalid();
    const inner = quoted[1]!.slice(1, -1);
    if (toml && inner.includes("'")) return invalid();
    return toml ? inner : inner.replace(/''/g, "'");
  }
  const bare = raw.replace(/\s+#.*$/, "");
  if (toml || !bare || /^[\[{>|!&*]/.test(bare) || /:\s/.test(bare) || /^(?:null|true|false|~|[-+]?\d.*)$/i.test(bare)) return invalid();
  return bare;
}
function nativeHeader(runtime: RuntimeId, content: string) {
  if (runtime === "codex") {
    const bodyStart = content.search(/^developer_instructions\s*=/m);
    if (bodyStart < 0) return invalid();
    const header = content.slice(0, bodyStart);
    if (/^\s*\[/m.test(header)) return invalid();
    return { header, before: "", after: content.slice(bodyStart), modelKey: "model", effortKey: "model_reasoning_effort", separator: "=" };
  }
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(content);
  if (!match) return invalid();
  return { header: match[2]! + (match[1]!.endsWith("\r\n") ? "\r\n" : "\n"), before: match[1]!, after: match[3]!.replace(/^\r?\n/, "") + content.slice(match[0].length), modelKey: "model", effortKey: runtime === "pi" ? "thinking" : "effort", separator: ":" };
}
function fields(runtime: RuntimeId, content: string) {
  const parts = nativeHeader(runtime, content);
  const values: Record<string, string> = {};
  const keys = runtime === "opencode" ? parts.modelKey : `${parts.modelKey}|${parts.effortKey}`;
  const regex = new RegExp(`^[ \\t]*(${keys})\\s*${parts.separator}\\s*(.*)$`, "gm");
  for (const match of parts.header.matchAll(regex)) {
    if (Object.hasOwn(values, match[1]!)) return invalid();
    values[match[1]!] = scalar(match[2]!, runtime === "codex");
  }
  let model = values[parts.modelKey];
  let variant = runtime === "opencode" ? undefined : values[parts.effortKey];
  if (runtime === "opencode" && model?.includes("#")) {
    const index = model.lastIndexOf("#"); variant = model.slice(index + 1); model = model.slice(0, index);
  }
  return { parts, regex, selection: { ...(model !== undefined ? { model } : {}), ...(variant !== undefined ? { variant } : {}) } };
}
export function readAgentModel(runtime: RuntimeId, file: string): { content: string; selection: AgentModel } {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("El agente debe ser un archivo regular, no un enlace.");
  const content = fs.readFileSync(file, "utf8");
  return { content, selection: fields(runtime, content).selection };
}

/** Only model/effort fields change; the body, permissions and other agent settings remain byte-identical. */
export function editAgentModel(runtime: RuntimeId, content: string, selection: AgentModel): string {
  const { parts, regex, selection: current } = fields(runtime, content);
  if (current.model === selection.model && current.variant === selection.variant) return content;
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const header = parts.header.replace(new RegExp(regex.source + "\\r?\\n?", "gm"), "");
  const choices: string[] = [];
  const model = runtime === "opencode" && selection.model && selection.variant ? `${selection.model}#${selection.variant}` : selection.model;
  const separator = runtime === "codex" ? " = " : ": ";
  if (model) choices.push(`${parts.modelKey}${separator}${JSON.stringify(model)}`);
  if (runtime !== "opencode" && selection.variant) choices.push(`${parts.effortKey}${separator}${JSON.stringify(selection.variant)}`);
  return parts.before + header + (choices.length ? choices.join(lineEnding) + lineEnding : "") + parts.after;
}
export function saveAgentModel(runtime: RuntimeId, file: string, expected: string, selection: AgentModel, owned: ReadonlySet<string>, boundary: string, backupsRoot: string): void {
  if (!owned.has(file)) throw new Error("Agente ajeno: se conserva sin editar; instala/configura primero el agente gestionado.");
  assertProjectionPath(file, boundary);
  const current = readAgentModel(runtime, file);
  if (current.content !== expected) throw new Error("El agente cambió durante la edición; vuelve a abrirlo antes de guardar.");
  const content = editAgentModel(runtime, expected, selection);
  const changes = diffPlan([{ kind: "write", target: file, content }]);
  if (changes.every((change) => change.status === "unchanged")) return;
  createBackup([file], `model-${runtime}`, backupsRoot);
  applyChanges(changes);
}
