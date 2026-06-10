/**
 * Contrato central del proyecto (PRD §5): cada runtime implementa un Adapter
 * que declara DÓNDE va cada cosa y CÓMO se escribe. Los componentes
 * (src/components/) iteran (componente × adapter) sin switches por runtime.
 */

import type { RuntimeDetection } from "../lib/detect.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import type { RuntimeModelMap } from "../lib/model-map.js";

export type RuntimeId = "claude-code" | "codex" | "opencode";

/** Tier canónico de modelo por agente; el model-map lo resuelve por runtime (PRD §6.1). */
export type Tier = "strong" | "standard" | "cheap";

/** Acción de instalación planificada. El pipeline la compara con el disco antes de aplicar. */
export type FileAction =
  | { kind: "write"; target: string; content: string }
  | { kind: "copy"; target: string; source: string };

export interface InstallContext {
  /** Raíz de la fuente canónica (stack/). */
  stackDir: string;
  /** Dir de config del runtime destino (puede venir de --target-dir en pruebas). */
  configDir: string;
  /** Binario Engram detectado (D7: siempre el existente). null = no instalado. */
  engramBin: string | null;
  models: RuntimeModelMap;
  secrets: Record<string, string | undefined>;
  /** Avisos no fatales que el pipeline muestra al final. */
  warnings: string[];
}

export interface AdapterPaths {
  systemPromptFile: string;
  agentsDir: string;
  skillsDir: string;
  commandsDir: string;
  /** null si el runtime no tiene plugins TS (Claude Code, Codex). */
  pluginsDir: string | null;
  scriptsDir: string;
  /** Solo Claude Code: modos del main agent (output styles). null en el resto. */
  outputStylesDir: string | null;
  /** Solo Codex: profiles (<nombre>.config.toml). null en el resto. */
  profilesDir: string | null;
}

export interface Adapter {
  id: RuntimeId;
  name: string;
  detect(): RuntimeDetection;
  paths(configDir: string): AdapterPaths;
  /**
   * Convierte un agente canónico a uno o varios artefactos nativos del runtime.
   * El orchestrator (primary) es SIEMPRE un modo del agente principal que el
   * usuario pilota, nunca un subagente invocado: OpenCode → primary agent
   * (Tab) · Claude Code → output style (modo persistente, /config) + skill de
   * activación puntual · Codex → profile con developer_instructions + skill.
   * kind "skill": file relativo a skillsDir (p.ej. orchestrator/SKILL.md).
   */
  renderAgent(
    agent: CanonicalAgent,
    models: RuntimeModelMap,
  ): { file: string; content: string; kind: "agent" | "command" | "output-style" | "skill" | "profile" }[];
  /** Transforma un command canónico al dialecto del runtime (placeholders de input, etc.). */
  renderCommand(file: string, content: string): { file: string; content: string };
  /** Traduce hooks.json canónico (formato Claude Code) al mecanismo del runtime. */
  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[];
  /** Registra MCPs y demás claves gestionadas en la config principal del runtime. */
  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[];
  /**
   * Inversa para uninstall: devuelve los archivos COMPARTIDOS con el usuario
   * (system prompt, configs, hooks) reescritos sin nuestras secciones/claves.
   * Un write con content vacío significa "borrar el archivo". Los targets de
   * estas acciones marcan además qué archivos del plan normal NO se borran.
   */
  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[];
}
