import fs from "node:fs";
import path from "node:path";
import type { SelectableRuntimeId, SharedProjectionAdapter } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";
import { readPiMcpConfig, resolvePiAdapterConfigPath } from "../lib/pi-mcp-config.js";

/** Origen efectivo declarado por el recibo separado de providers (solo lectura). */
export interface PiProviderReceiptReport {
  kind: "registry" | "derived";
  detail: string;
}

/**
 * Lectura read-only del recibo separado de providers. Devuelve null cuando no
 * existe recibo; lanza ante binding inválido, recibo malformado o drift.
 * No toca red ni repara nada.
 */
export async function readPiProviderReceiptReport(input: {
  homeDir: string;
  agentDir: string;
}): Promise<PiProviderReceiptReport | null> {
  // Import dinámico: evita el ciclo estático con pi-provider-receipt (que
  // consume isNamedPiSource de este adapter).
  const { piProviderReceiptPath, verifyPiProviderReceipt } = await import("../lib/pi-provider-receipt.js");
  if (fs.lstatSync(piProviderReceiptPath(input.homeDir), { throwIfNoEntry: false }) === undefined) return null;
  const verification = verifyPiProviderReceipt({ homeDir: input.homeDir, agentDir: input.agentDir });
  if (verification.kind === "absent") return null;
  const gentle = verification.receipt?.providers.find((entry) => entry.name === "gentle-engram");
  const version = gentle?.version ?? "unknown";
  return verification.kind === "derived"
    ? { kind: "derived", detail: `variante temporal derivada del oficial v${version} (patch #1567)` }
    : { kind: "registry", detail: `artefacto oficial de registry v${version}` };
}

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
 *   versiones provider-managed: se observan, no se fijan; solo bare o
 *   selector npm seguro de versión/tag/rango, sin file:/link:/workspace:/
 *   patch:/URL/git/paths/archivo (.tgz/.tar/.tar.gz)/alias npm redirigidos;
 *   toda reclamación del nombre protegido con selector inseguro falla).
 * - mcp.json contiene `mcpServers.engram` exactamente como upstream main:
 *   `{ command === engramBin absoluto, args === ["mcp","--tools=agent"],
 *   lifecycle === "lazy", directTools === false }`. Sin wrappers. Toda
 *   coexistencia con `servers.engram` legacy es conflicto fail-closed.
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

function isSafePiVersionSpec(spec: string): boolean {
  // Bare o selector npm seguro de versión/tag/rango (provider-managed, sin
  // pin Stack): se acepta y se observa. Rechaza procedencia redirigida
  // (file:/link:/workspace:/patch:/URL/git/paths/alias npm) que contiene
  // `/`, `\`, `:`, `#`, `?` o empieza por `.`, además de selectores que
  // terminan en archivo (.tgz/.tar/.tar.gz, case-insensitive); el resto usa
  // whitelist de caracteres de versión/tag/rango sin fijar versión del
  // provider.
  if (spec === "" || /[\r\n]/.test(spec)) return false;
  if (spec.includes("/") || spec.includes("\\") || spec.includes(":") || spec.includes("#") || spec.includes("?")) {
    return false;
  }
  if (spec.startsWith(".")) return false;
  const lower = spec.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar")) return false;
  return /^[A-Za-z0-9._\-^~><=| +*xXv]+$/.test(spec);
}

function claimsProtectedName(source: string, name: string): boolean {
  // Reclama el nombre protegido aunque el selector sea inseguro: bare
  // `npm:<name>` o cualquier `npm:<name>@<spec>`, seguro o no.
  return source === `npm:${name}` || source.startsWith(`npm:${name}@`);
}

export function isNamedPiSource(source: string, name: string): boolean {
  if (source === `npm:${name}`) return true;
  const prefix = `npm:${name}@`;
  if (!source.startsWith(prefix)) return false;
  return isSafePiVersionSpec(source.slice(prefix.length));
}

function isGentleSource(source: string): boolean {
  return isNamedPiSource(source, "gentle-engram");
}

function isAdapterSource(source: string): boolean {
  return isNamedPiSource(source, "pi-mcp-adapter");
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
  providerReceipt?: PiProviderReceiptReport;
}> {
  const passed: string[] = [];
  const missing: string[] = [];
  let duplicates = false;
  let providerDetail: string | null = null;
  let providerReceipt: PiProviderReceiptReport | undefined;

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
      // Toda entrada que reclama un nombre protegido con selector inseguro
      // falla cerrado antes de contar singletons; las ajenas se preservan
      // (se ignoran) y solo después se exige exactamente una entrada segura
      // por nombre protegido.
      const unsafeClaimed = sources.filter(
        (source): source is string =>
          source !== null
          && ((claimsProtectedName(source, "gentle-engram") && !isGentleSource(source))
            || (claimsProtectedName(source, "pi-mcp-adapter") && !isAdapterSource(source))),
      );
      if (unsafeClaimed.length > 0) {
        missing.push("packages:invalid");
        packagesDetail = `singleton inválido en settings.json (selector inseguro que reclama nombre protegido: ${unsafeClaimed[0]})`;
      } else {
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

  // --- mcp (the installed adapter's selected config, mcpServers.engram exacto) ---
  let mcpDetail: string | null = null;
  const appendMcpDetail = (detail: string): void => {
    mcpDetail = mcpDetail === null ? detail : `${mcpDetail}; ${detail}`;
  };
  if (typeof args.engramBin !== "string" || args.engramBin === "") {
    missing.push("mcp:missing");
    mcpDetail = "mcp inválido en mcp.json (sin engramBin absoluto)";
  } else {
    let mcpPath: string | null = null;
    let mcpName = "mcp.json";
    try {
      mcpPath = resolvePiAdapterConfigPath(args.configDir);
      mcpName = path.basename(mcpPath);
    } catch (error) {
      missing.push("mcp:adapter-metadata");
      mcpDetail = `mcp inválido: metadata instalada de pi-mcp-adapter ausente o inválida (${error instanceof Error ? error.message : String(error)})`;
    }

    // Adapter >=3 no longer reads the old filename.  An old official Engram
    // root is still a duplicate/conflict, not a reason to silently declare
    // the new file healthy.  This check is read-only; migration belongs to
    // the official setup lifecycle.
    if (mcpPath !== null && mcpName === "mcp-adapter.json") {
      const legacyPath = path.join(args.configDir, "mcp.json");
      try {
        const legacy = readPiMcpConfig(legacyPath);
        const legacyServers = isRecord(legacy) ? legacy["mcpServers"] : undefined;
        const legacyAltServers = isRecord(legacy) ? legacy["mcp-servers"] : undefined;
        const legacyEngram = isRecord(legacyServers)
          ? legacyServers["engram"]
          : isRecord(legacyAltServers) ? legacyAltServers["engram"] : undefined;
        if (legacyEngram !== undefined) {
          duplicates = true;
          missing.push("mcp:conflict");
          appendMcpDetail("mcp en conflicto en mcp.json (el adapter instalado lee mcp-adapter.json y conserva una definición Engram legacy; migra la raíz oficial sin duplicarla)");
        }
      } catch (error) {
        const code = errnoCode(error);
        if (code !== "ENOENT") {
          missing.push("mcp:conflict");
          const diagnostic = error instanceof SyntaxError ? "INVALID_JSON" : /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
          appendMcpDetail(`mcp en conflicto en ${legacyPath} (configuración legacy ilegible o inválida: ${diagnostic})`);
        }
      }
    }

    if (mcpPath !== null && !missing.some((entry) => entry === "mcp:adapter-metadata")) {
      try {
        const parsed = readPiMcpConfig(mcpPath);
        if (!isRecord(parsed)) {
          missing.push("mcp:invalid");
          appendMcpDetail(`mcp inválido en ${mcpName} (raíz no objeto)`);
        } else {
          const servers = parsed["mcpServers"];
          if (!isRecord(servers) || servers["engram"] === undefined) {
            missing.push("mcp:missing");
            appendMcpDetail(`mcp ausente en ${mcpName} (falta mcpServers.engram)`);
          } else if (isExactPiEngramMcp(servers["engram"], args.engramBin)) {
            const legacy = isRecord(parsed["servers"]) ? parsed["servers"]["engram"] : undefined;
            if (legacy !== undefined) {
              missing.push("mcp:conflict");
              appendMcpDetail(`mcp en conflicto en ${mcpName} (servers.engram legacy coexiste con mcpServers.engram canónico; conflicto fail-closed sin activar Pi)`);
            } else if (!missing.some((entry) => entry === "mcp:conflict")) {
              passed.push("mcp");
              mcpDetail = null;
            }
          } else {
            const foreign = isRecord(servers["engram"])
              && typeof (servers["engram"] as Record<string, unknown>)["command"] === "string"
              && (servers["engram"] as Record<string, unknown>)["command"] !== args.engramBin
              && !String((servers["engram"] as Record<string, unknown>)["command"]).includes("node")
              && !JSON.stringify(servers["engram"]).includes(args.engramBin);
            missing.push(foreign ? "mcp:conflict" : "mcp:invalid");
            appendMcpDetail(foreign
              ? `mcp en conflicto en ${mcpName} (no apunta al binario oficial ${args.engramBin}); se preserva sin reescribir`
              : `mcp inválido en ${mcpName} (se exige forma directa canónica: command === engramBin absoluto, args === ["mcp","--tools=agent"], lifecycle === "lazy", directTools === false)`);
          }
        }
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          missing.push("mcp:missing");
          appendMcpDetail(`mcp ausente en ${mcpName} (falta mcpServers.engram)`);
        } else if (error instanceof SyntaxError) {
          missing.push("mcp:invalid");
          appendMcpDetail(`mcp inválido en ${mcpName} (JSON/JSONC no parseable)`);
        } else {
          missing.push("mcp:unreadable");
          appendMcpDetail(`mcp ilegible en ${mcpName} (unreadable ${code}, parcial sin activar Pi)`);
        }
      }
    }
  }

  // --- provider receipt (separate provenance contract, read-only) ---
  // Ausencia preserva instalaciones sin el contrato. Malformado o drift falla
  // cerrado y nunca se presenta como setup sano.
  if (typeof args.homeDir === "string" && args.homeDir !== "") {
    try {
      const report = await readPiProviderReceiptReport({ homeDir: args.homeDir, agentDir: args.configDir });
      if (report !== null) {
        providerReceipt = report;
        passed.push(`provider-receipt:${report.kind}`);
      }
    } catch (error) {
      missing.push("provider-receipt:invalid");
      providerDetail = `provider receipt inválido o drifted (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  if (missing.length === 0) {
    return {
      ok: true,
      layers: passed,
      duplicates: false,
      ...(providerReceipt === undefined ? {} : { providerReceipt }),
    };
  }
  const detail = `Pi: setup oficial Engram incompleto (${[
    ...(packagesDetail !== null ? [packagesDetail] : []),
    ...(providerDetail !== null ? [providerDetail] : []),
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
