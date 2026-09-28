import path from "node:path";
import fs from "node:fs";
import type { Tier } from "../adapters/types.js";
import { isCanonicalSha512Integrity, isStableSemverVersion } from "./npm-provider.js";

/** Agente en formato canónico (stack/agents/README.md). */
export interface CanonicalAgent {
  name: string;
  description: string;
  mode: "primary" | "subagent";
  tier: Tier;
  readonly: boolean;
  bash: "none" | "git-read" | "full";
  spawn: boolean;
  body: string;
}

export function parseCanonicalAgent(source: string, file: string): CanonicalAgent {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) throw new Error(`Agente sin frontmatter: ${file}`);

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }

  const required = ["name", "description", "mode", "tier"] as const;
  for (const key of required) {
    if (!fields[key]) throw new Error(`Agente ${file}: falta '${key}' en el frontmatter`);
  }

  return {
    name: fields.name!,
    description: fields.description!,
    mode: fields.mode === "primary" ? "primary" : "subagent",
    tier: fields.tier as Tier,
    readonly: fields.readonly === "true",
    bash: (fields.bash ?? "full") as CanonicalAgent["bash"],
    spawn: fields.spawn !== "false",
    body: source.slice(match[0].length),
  };
}

export function loadCanonicalAgents(agentsDir: string): CanonicalAgent[] {
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((f) => {
      const file = path.join(agentsDir, f);
      // EOL normalizado: el contenido generado debe ser estable aunque git
      // haya hecho checkout con CRLF.
      const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      return parseCanonicalAgent(source, file);
    });
}

/** Hook canónico (stack/hooks/hooks.json, formato Claude Code + x-command-includes). */
export interface CanonicalHooks {
  hooks: Record<
    string,
    {
      matcher?: string;
      "x-command-includes"?: string;
      hooks: { type: string; command: string; timeout?: number }[];
    }[]
  >;
}

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

export const DEVTOOLS_MCP_SERVER = "chrome-devtools";

/** Versión DevTools realmente observada y verificada (devtools-mcp.json). */
export interface DevtoolsMcpObservedVersion {
  version: string;
  integrity: string;
}

const DEVTOOLS_VERSION_TEMPLATE = "chrome-devtools-mcp@{{VERSION}}";
const DEVTOOLS_VERSION_PREFIX = "chrome-devtools-mcp@";
const DEVTOOLS_EXPECTED_FLAGS = [
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
] as const;
const DEVTOOLS_EXPECTED_TEMPLATE_ARGS = [
  "dlx",
  DEVTOOLS_VERSION_TEMPLATE,
  ...DEVTOOLS_EXPECTED_FLAGS,
] as const;

function assertExactDevtoolsTemplate(server: CanonicalMcpServer): void {
  const args = server.args;
  if (
    server.transport !== "stdio"
    || server.command !== "pnpm"
    || !Array.isArray(args)
    || args.length !== DEVTOOLS_EXPECTED_TEMPLATE_ARGS.length
    || !DEVTOOLS_EXPECTED_TEMPLATE_ARGS.every((expected, index) => args[index] === expected)
  ) {
    throw new Error(
      "DevTools: el servidor canónico debe ser el template exacto flag-only `chrome-devtools-mcp@{{VERSION}}` con los 4 flags aislados.",
    );
  }
}

function assertStableDevtoolsVersion(version: unknown): asserts version is string {
  if (!isStableSemverVersion(version)) {
    throw new Error("DevTools: se requiere una versión observada estable (semver sin prerelease).");
  }
}

function assertValidDevtoolsObservation(observed: unknown): asserts observed is DevtoolsMcpObservedVersion {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    throw new Error("DevTools: falta la versión observada verificada para materializar el servidor habilitado.");
  }
  const record = observed as Record<string, unknown>;
  assertStableDevtoolsVersion(record.version);
  if (!isCanonicalSha512Integrity(record.integrity)) {
    throw new Error("DevTools: la observación requiere semver estable e integridad sha512 SRI canónica.");
  }
}

/**
 * Materializa el template canónico flag-only con la versión observada.
 * Valida el template exacto + flags y la observación `{version,integrity}`
 * (semver estable + SHA512 SRI canónica). Devuelve un clon con
 * `chrome-devtools-mcp@<observed.version>` sin mutar el canon.
 */
export function materializeCanonicalDevtoolsServer(
  server: CanonicalMcpServer & Record<string, unknown>,
  observed: DevtoolsMcpObservedVersion,
): CanonicalMcpServer & Record<string, unknown> {
  assertValidDevtoolsObservation(observed);
  assertExactDevtoolsTemplate(server);
  return {
    ...server,
    args: ["dlx", `${DEVTOOLS_VERSION_PREFIX}${observed.version}`, ...DEVTOOLS_EXPECTED_FLAGS],
  };
}

/**
 * Materializa solo los args del template canónico para una versión estable.
 * Comparte la validación exacta de template + flags con el seam observado;
 * la integridad SRI se valida en el seam `planMcp`, no en el handoff Pi.
 */
export function materializeCanonicalDevtoolsArgsForVersion(
  server: CanonicalMcpServer,
  version: string,
): string[] {
  assertStableDevtoolsVersion(version);
  assertExactDevtoolsTemplate(server);
  return ["dlx", `${DEVTOOLS_VERSION_PREFIX}${version}`, ...DEVTOOLS_EXPECTED_FLAGS];
}

/** El único paquete legacy sin observación fue 1.6.0; solo permite retirar su entrada owned exacta. */
export function materializeCanonicalDevtoolsServerForRemoval(
  server: CanonicalMcpServer & Record<string, unknown>,
  observed?: DevtoolsMcpObservedVersion,
): CanonicalMcpServer & Record<string, unknown> {
  if (observed !== undefined) return materializeCanonicalDevtoolsServer(server, observed);
  return { ...server, args: materializeCanonicalDevtoolsArgsForVersion(server, "1.6.0") };
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

export function loadCanonicalHooks(stackDir: string): CanonicalHooks {
  return JSON.parse(fs.readFileSync(path.join(stackDir, "hooks", "hooks.json"), "utf8")) as CanonicalHooks;
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
