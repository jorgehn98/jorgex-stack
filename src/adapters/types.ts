/**
 * Contrato central del proyecto (PRD §5): cada runtime implementa un Adapter
 * que declara DÓNDE va cada cosa y CÓMO se escribe. Los componentes
 * (src/components/) iteran (componente × adapter) sin switches por runtime.
 */

export type RuntimeId = "claude-code" | "codex" | "opencode";

/** Tier canónico de modelo por agente; el picker lo resuelve por runtime (PRD §6.1). */
export type Tier = "strong" | "standard" | "cheap";

export interface DetectResult {
  installed: boolean;
  /** Ruta del binario del runtime si se encontró en PATH. */
  binPath?: string;
  /** Directorio de config global del runtime (p.ej. ~/.claude). */
  configDir?: string;
}

export interface AdapterPaths {
  configDir: string;
  /** Archivo donde se inyecta el system prompt (CLAUDE.md / AGENTS.md). */
  systemPromptFile: string;
  agentsDir: string;
  skillsDir: string;
  /** Ausente si el runtime no tiene commands separados (Codex: van como skills). */
  commandsDir?: string;
}

export interface Adapter {
  id: RuntimeId;
  name: string;
  detect(): Promise<DetectResult>;
  paths(): AdapterPaths;
  // Las estrategias de escritura (agentes, hooks, MCP, modelos) se definen
  // en F2–F4, una vez exista filemerge y el primer componente real (PRD §11).
}
