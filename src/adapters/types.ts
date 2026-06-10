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
}

export interface Adapter {
  id: RuntimeId;
  name: string;
  detect(): RuntimeDetection;
  paths(configDir: string): AdapterPaths;
  /** Convierte un agente canónico al formato nativo del runtime. */
  renderAgent(agent: CanonicalAgent, models: RuntimeModelMap): { file: string; content: string };
  /** Traduce hooks.json canónico (formato Claude Code) al mecanismo del runtime. */
  planHooks(canonical: CanonicalHooks, ctx: InstallContext): FileAction[];
  /** Registra MCPs y demás claves gestionadas en la config principal del runtime. */
  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[];
}
