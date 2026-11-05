import path from "node:path";
import fs from "node:fs";

/** Servidor MCP canónico (stack/mcp/servers.json). */
export interface CanonicalMcpServer {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  optional?: boolean;
  defaultEnabled?: boolean;
  note?: string;
}

export interface CanonicalMcp {
  servers: Record<string, CanonicalMcpServer & Record<string, unknown>>;
}

/** Los MCP opcionales no entran en un plan salvo selección explícita por runtime. */
export function isCanonicalMcpServerEnabled(
  name: string,
  server: CanonicalMcpServer,
  enabledServers: ReadonlySet<string> | undefined,
): boolean {
  return !server.optional || server.defaultEnabled === true || enabledServers?.has(name) === true;
}

export function loadCanonicalMcp(stackDir: string): CanonicalMcp {
  return JSON.parse(fs.readFileSync(path.join(stackDir, "mcp", "servers.json"), "utf8")) as CanonicalMcp;
}

/**
 * Permisos por defecto por runtime (stack/config/defaults.json). Cada adapter
 * escribe su bloque SOLO si el usuario aún no tiene esa clave: nunca pisa ni
 * re-impone una config de permisos existente.
 */
export function loadCanonicalDefaults(stackDir: string): Record<string, Record<string, unknown>> {
  const file = path.join(stackDir, "config", "defaults.json");
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  delete parsed["$comment"];
  return parsed;
}

/**
 * Patrones de secretos para los runtimes cuyo comodín `*` también casa `/`
 * (OpenCode v2 y el sistema de permisos de Pi). `*.env.example` se re-permite
 * después: en ambos gana la última coincidencia.
 */
export const SECRET_PATH_PATTERNS = [
  "*.env",
  "*.env.*",
  "*.ssh/*",
  "*.aws/credentials",
  "*.npmrc",
  "*.git-credentials",
  "*id_rsa*",
  "*id_ed25519*",
  "*.pem",
  "*.key",
] as const;
export const SECRET_PATH_EXCEPTION = "*.env.example";

/**
 * El nombre canónico o una ruta absoluta al mismo binario. Un proceso lanzado
 * sin el PATH de la shell interactiva (un servicio) puede resolver el nombre a
 * otra copia, así que fijar la ruta es una personalización legítima. En Windows
 * los gestores de paquetes exponen el binario como shim `.cmd` o `.exe`.
 */
export function isBrowserControlCommand(value: unknown, command: string): boolean {
  if (typeof value !== "string") return false;
  if (value === command) return true;
  if (path.isAbsolute(value)) return path.basename(value) === command;
  const shim = path.win32.parse(value);
  return path.win32.isAbsolute(value) && shim.name === command && [".cmd", ".exe"].includes(shim.ext.toLowerCase());
}

export const BROWSER_CONTROL_INCOMPATIBLE_WARNING = "el MCP 'browser-control' existente no equivale al launcher nativo (remoto, deshabilitado u otro comando); se conserva intacto y sin reclamar. Browser Control queda bajo tu configuración y Stack no proyecta su guía.";

export const BROWSER_CONTROL_GUIDANCE = [
  "## Browser Control",
  "",
  "- Use native MCP stdio (`browser-control-mcp`) or the provider CLI; consult the MCP `skill` tool for its workflow.",
  "- Use the provider's unpacked Chromium extension and explicitly attach an authorized tab. The provider starts its relay on the first operational call, not discovery.",
  "- After updates, reload the extension or restart the relay only when needed and without interrupting another session. Stack does not run a supervisor or service.",
  "- Apply the Browser Use authorization and safety rules to this personal browser. Do not fall back to Playwright or DevTools.",
].join("\n");
