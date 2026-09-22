import fs from "node:fs";
import path from "node:path";
import type { SelectableRuntimeId, SharedProjectionAdapter } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";

export function piSystemPromptFile(targetDir?: string): string {
  const configDir = targetDir === undefined
    ? process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent")
    : path.join(path.resolve(targetDir), "pi-agent");
  return path.join(configDir, "AGENTS.md");
}

/**
 * Proyección mínima de los recursos compartidos que Pi consume fuera de su
 * paquete nativo; el registro gestionado del runtime se mantiene en su
 * lifecycle nativo.
 */
export const piAdapter: SharedProjectionAdapter & {
  readonly id: Extract<SelectableRuntimeId, "pi">;
} = {
  id: "pi",

  paths(configDir) {
    const piConfigDir = path.dirname(piSystemPromptFile());
    const agentsHome = samePath(configDir, piConfigDir) ? HOME : path.join(path.dirname(configDir), "home");
    return {
      systemPromptFile: path.join(configDir, "AGENTS.md"),
      agentsDir: path.join(configDir, "agents"),
      skillsDir: path.join(agentsHome, ".agents", "skills"),
      commandsDir: path.join(configDir, "prompts"),
      pluginsDir: null,
      scriptsDir: path.join(configDir, "scripts"),
      outputStylesDir: null,
      profilesDir: null,
    };
  },

  renderCommand(file, content) {
    return { file, content: content.replace(/\{\{input\}\}/g, "$ARGUMENTS") };
  },

  // La guía Context7 se habilita al adoptar su registro HTTP en Pi.
  adaptSystemPromptSections(sections) {
    const modular = { ...sections };
    delete modular.context7;
    return modular;
  },
};

/**
 * Verificador oficial Pi del post-estado `engram setup pi` (solo lectura).
 *
 * Canonical (`plugin/pi` README, `pi-engram init`):
 * - settings.json declara exactamente un `npm:gentle-engram` + un
 *   `npm:pi-mcp-adapter` (entradas string u objeto con `source`;
 *   versiones provider-managed: se observan, no se fijan).
 * - mcp.json contiene `mcpServers.engram` exactamente como upstream main:
 *   `{ command === engramBin absoluto, args === ["mcp","--tools=agent"],
 *   lifecycle === "lazy", directTools === false }`. Sin wrappers.
 * Respeta PI_CODING_AGENT_DIR; por defecto <home>/.pi/agent.
 * Ausente/duplicado/inválido/ilegible/parcial falla cerrado sin escribir.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function piPackageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return null;
  const source = entry["source"];
  return typeof source === "string" ? source : null;
}

function isGentleSource(source: string): boolean {
  return source === "npm:gentle-engram" || source.startsWith("npm:gentle-engram@");
}

function isAdapterSource(source: string): boolean {
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

function isExactPiEngramMcp(value: unknown, engramBin: string): boolean {
  // Forma directa canónica de upstream main, sin wrappers: exactamente
  // { command === engramBin absoluto, args === ["mcp","--tools=agent"],
  //   lifecycle === "lazy", directTools === false }. Cualquier wrapper
  // (Node/arbitrario/shell) se rechaza aunque sus args contengan tokens
  // confiables; la forma directa sin lifecycle lazy o sin directTools false
  // explícito también se rechaza.
  if (!isRecord(value)) return false;
  if (typeof engramBin !== "string" || engramBin === "" || !path.isAbsolute(engramBin)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 4 || keys[0] !== "args" || keys[1] !== "command" || keys[2] !== "directTools" || keys[3] !== "lifecycle") {
    return false;
  }
  if (value["command"] !== engramBin) return false;
  if (value["lifecycle"] !== "lazy") return false;
  if (value["directTools"] !== false) return false;
  const args = value["args"];
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== "mcp" || args[1] !== "--tools=agent") {
    return false;
  }
  return true;
}

function errnoCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code as string
    : "UNKNOWN";
}

export async function verifyOfficialSetup(args: {
  configDir: string;
  engramBin: string;
  homeDir?: string;
}): Promise<{
  ok: boolean;
  layers: string[];
  duplicates: boolean;
  reason?: string;
}> {
  void args.homeDir;
  const passed: string[] = [];
  const missing: string[] = [];
  let duplicates = false;

  // --- packages (settings.json, singleton gentle + adapter) ---
  let packagesDetail: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(args.configDir, "settings.json"), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      packagesDetail = "packages:invalid";
      missing.push(packagesDetail);
      packagesDetail = "singleton inválido en settings.json (JSON no parseable)";
      throw new Error("__invalid__");
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) {
      missing.push("packages:missing");
      packagesDetail = "singleton incompleto en settings.json (falta packages[])";
    } else {
      const sources = (parsed["packages"] as unknown[]).map(piPackageSource);
      const gentle = sources.filter((source): source is string => source !== null && isGentleSource(source));
      const adapter = sources.filter((source): source is string => source !== null && isAdapterSource(source));
      if (gentle.length === 1 && adapter.length === 1) {
        passed.push("packages");
        packagesDetail = null;
      } else {
        duplicates = gentle.length > 1 || adapter.length > 1;
        if (duplicates) missing.push("packages:duplicate");
        else if (gentle.length === 0 || adapter.length === 0) {
          const absent = [
            ...(gentle.length === 0 ? ["gentle-engram"] : []),
            ...(adapter.length === 0 ? ["pi-mcp-adapter"] : []),
          ].join(" + ");
          missing.push("packages:missing");
          void absent;
        } else {
          missing.push("packages:missing");
        }
        const detail = duplicates
          ? `singleton duplicado en settings.json (gentle-engram x${gentle.length}, pi-mcp-adapter x${adapter.length})`
          : `singleton incompleto en settings.json (falta ${gentle.length === 0 ? "gentle-engram" : "pi-mcp-adapter"})`;
        packagesDetail = detail;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "__invalid__") {
      // Ya registrado arriba.
    } else {
      const code = errnoCode(error);
      if (code === "ENOENT") {
        missing.push("packages:missing");
        packagesDetail = "singleton incompleto en settings.json (ausente)";
      } else {
        missing.push("packages:unreadable");
        packagesDetail = `singleton ilegible en settings.json (unreadable ${code})`;
      }
    }
  }

  // --- mcp (mcp.json, mcpServers.engram exacto) ---
  let mcpDetail: string | null = null;
  if (typeof args.engramBin !== "string" || args.engramBin === "") {
    missing.push("mcp:missing");
    mcpDetail = "mcp inválido en mcp.json (sin engramBin absoluto)";
  } else {
    try {
      const raw = fs.readFileSync(path.join(args.configDir, "mcp.json"), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        missing.push("mcp:invalid");
        mcpDetail = "mcp inválido en mcp.json (JSON no parseable)";
        parsed = null;
        throw new Error("__invalid_mcp__");
      }
      if (!isRecord(parsed)) {
        missing.push("mcp:invalid");
        mcpDetail = "mcp inválido en mcp.json (raíz no objeto)";
      } else {
        const servers = parsed["mcpServers"];
        if (!isRecord(servers) || servers["engram"] === undefined) {
          // Compat: algunos estados usan `servers.engram`; el canónico es
          // `mcpServers.engram` en mcp.json.
          const alt = isRecord(parsed["servers"]) ? (parsed["servers"] as Record<string, unknown>)["engram"] : undefined;
          if (alt === undefined) {
            missing.push("mcp:missing");
            mcpDetail = "mcp ausente en mcp.json (falta mcpServers.engram)";
          } else if (isExactPiEngramMcp(alt, args.engramBin)) {
            passed.push("mcp");
            mcpDetail = null;
          } else {
            missing.push("mcp:invalid");
            mcpDetail = `mcp inválido en mcp.json (se exige forma directa canónica: command === engramBin absoluto, args === ["mcp","--tools=agent"], lifecycle === "lazy", directTools === false)`;
          }
        } else if (isExactPiEngramMcp(servers["engram"], args.engramBin)) {
          passed.push("mcp");
          mcpDetail = null;
        } else {
          const foreign = isRecord(servers["engram"])
            && typeof (servers["engram"] as Record<string, unknown>)["command"] === "string"
            && (servers["engram"] as Record<string, unknown>)["command"] !== args.engramBin
            && !String((servers["engram"] as Record<string, unknown>)["command"]).includes("node")
            && !JSON.stringify(servers["engram"]).includes(args.engramBin);
          missing.push(foreign ? "mcp:conflict" : "mcp:invalid");
          mcpDetail = foreign
            ? `mcp en conflicto en mcp.json (no apunta al binario oficial ${args.engramBin}); se preserva sin reescribir`
            : `mcp inválido en mcp.json (se exige forma directa canónica: command === engramBin absoluto, args === ["mcp","--tools=agent"], lifecycle === "lazy", directTools === false)`;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "__invalid_mcp__") {
        // Ya registrado.
      } else {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          // Solo registrar si no se registró ya como missing/invalid arriba.
          if (mcpDetail === null && !missing.some((entry) => entry.startsWith("mcp:"))) {
            missing.push("mcp:missing");
            mcpDetail = "mcp ausente en mcp.json (falta mcpServers.engram)";
          }
        } else {
          missing.push("mcp:unreadable");
          mcpDetail = `mcp ilegible en mcp.json (unreadable ${code}, parcial sin activar Pi)`;
        }
      }
    }
  }

  if (missing.length === 0) {
    return { ok: true, layers: passed, duplicates: false };
  }
  const detail = `Pi: setup oficial Engram incompleto (${[
    ...(packagesDetail !== null ? [packagesDetail] : []),
    ...(mcpDetail !== null ? [mcpDetail] : []),
  ].join("; ")}; falta: ${missing.join(", ")}).`;
  return {
    ok: false,
    layers: [...passed, ...missing],
    duplicates,
    reason: detail,
  };
}

registerOfficialSetupVerifier("pi", verifyOfficialSetup);
