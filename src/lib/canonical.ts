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
export function isBrowseCommand(value: unknown, command: string): boolean {
  if (typeof value !== "string") return false;
  if (value === command) return true;
  if (path.isAbsolute(value)) return path.basename(value) === command;
  const shim = path.win32.parse(value);
  return path.win32.isAbsolute(value) && shim.name === command && [".cmd", ".exe"].includes(shim.ext.toLowerCase());
}

/** Entrada MCP que versiones anteriores del Stack registraron; se retira al migrar a browse. */
export const LEGACY_BROWSER_CONTROL_SERVER = "browser-control";
export const LEGACY_BROWSER_CONTROL_INVOCATION = { command: "browser-control-mcp", args: [] } as const;

export const BROWSE_INCOMPATIBLE_WARNING = "el MCP 'browse' existente no equivale al launcher nativo (remoto, deshabilitado u otro comando); se conserva intacto y sin reclamar. Browse queda bajo tu configuración y Stack no proyecta su guía.";

export const BROWSE_GUIDANCE = [
  "## Browse",
  "",
  "- Drive the user's real Chromium-family browser through the `browse` MCP (stdio `browse mcp`) and its extension; logins and open tabs are already there. `browse doctor` and `browse status` diagnose setup and connection.",
  "- Inspect with a fresh snapshot before acting, use the narrowest stable control and verify with a new page read.",
  "- Ask before adopting an existing tab or authenticated profile. Give a session an `allowedOrigins` allowlist before typing stored secrets; never put credentials in execute source.",
  "- When only a person can proceed (login, 2FA, passkey, captcha, payment), call `handoff` and wait. Never solve a captcha yourself or retry-loop a blocked site.",
  "- Leave the browser tidy: `tabs_cleanup` or `session_reset` when finished. Do not fall back to Playwright or DevTools outside the `browse` integration.",
].join("\n");
