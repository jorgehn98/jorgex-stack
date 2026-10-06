/**
 * Contrato central del proyecto (PRD §5): cada runtime implementa un Adapter
 * que declara DÓNDE va cada cosa y CÓMO se escribe. Los componentes
 * (src/components/) iteran (componente × adapter) sin switches por runtime.
 */

import type { WritingStyleSnapshot } from "../lib/writing-style.js";
import type { RuntimeDetection } from "../lib/detect.js";
import type { CanonicalAgent, CanonicalMcp } from "../lib/canonical.js";
import type { AgentModelChoices } from "../lib/agent-model.js";
import type { SystemPromptSections } from "../lib/system-prompt-sections.js";

export type RuntimeId = "claude-code" | "codex" | "opencode" | "pi";
export type SelectableRuntimeId = RuntimeId;

/**
 * Evidencia de major OpenCode EXCLUSIVAMENTE para el sandbox --target-dir (en
 * tests, `JORGEX_OPENCODE_TARGET_MAJOR=2`); allí es obligatoria. Fuera de
 * target se ignora: una instalación real siempre prueba el binario detectado y
 * esta evidencia no acredita capacidad ni sirve de bypass.
 */
export interface OpenCodeTargetEvidenceOption {
  opencodeTargetMajor?: number;
}

export interface McpOwnershipChange {
  server: string;
  owned: boolean;
}

export interface ConfigOwnershipChange {
  field: string;
  owned: boolean;
}

/** Acción de instalación planificada. El pipeline la compara con el disco antes de aplicar. */
export type FileAction =
  | {
      kind: "write";
      target: string;
      content: string;
      /**
       * Directories this content needs to exist to be usable. The pipeline
       * creates the missing ones (mode 700) when it applies this action, even
       * if the file itself is already current, and never changes an existing
       * one. They are not owned: uninstall keeps them.
       */
      ensureDirs?: string[];
      mcpOwnership?: McpOwnershipChange[];
      configOwnership?: ConfigOwnershipChange[];
    }
  | { kind: "copy"; target: string; source: string; symlink?: true };

export interface InstallContext {
  ownedFiles?: ReadonlySet<string>;
  writingStyle?: WritingStyleSnapshot;
  /** Raíz de la fuente canónica (stack/). */
  stackDir: string;
  /** Dir de config del runtime destino (puede venir de --target-dir en pruebas). */
  configDir: string;
  /**
   * Señal explícita de sandbox: con --target-dir, TODO lookup de estado usa una
   * raíz sintética confinada al target y jamás consulta XDG_STATE_HOME/HOME
   * personal. No se infiere comparando configDir con la raíz global.
   */
  targetDir?: string;
  /** Binario Engram detectado (D7: siempre el existente). null = no instalado. */
  engramBin: string | null;
  models: AgentModelChoices;
  /** Avisos no fatales que el pipeline muestra al final. */
  warnings: string[];
  /** MCPs opcionales habilitados explícitamente para este runtime. */
  enabledMcpServers?: ReadonlySet<string>;
  /** Native stdio command; the provider owns relay startup and browser attachment. */
  browserControlInvocation?: { command: string; args: readonly string[] };
  /** Registros MCP que una escritura previa del stack creó realmente. */
  ownedMcpServers?: ReadonlySet<string>;
  /** Campos de configuración que una escritura previa del Stack creó. */
  ownedConfigFields?: ReadonlySet<string>;
  /**
   * Solo uninstall (D7): true = conservar TODO lo de Engram (registro MCP,
   * plugin engram.ts, entrada en configs). Es el default — desregistrar
   * Engram exige el sí explícito del usuario. Las memorias (~/.engram) y el
   * binario no se tocan JAMÁS, ni siquiera al desregistrar.
   */
  preserveEngram?: boolean;
}

export interface AdapterPaths {
  systemPromptFile: string;
  sharedPromptFile?: string;
  skillLinksDir?: string;
  agentsDir: string;
  skillsDir: string;
  /** null si el runtime no tiene plugins TS (Claude Code, Codex). */
  pluginsDir: string | null;
  scriptsDir: string;
}

/**
 * Secciones retiradas: Engram pertenece al provider oficial y la guía
 * browser-control se sustituye por el bloque browser. Install/uninstall
 * eliminan idempotentemente los bloques que versiones anteriores instalaron.
 * No añadir secciones activas aquí.
 */
export const LEGACY_SYSTEM_PROMPT_SECTIONS = ["engram-protocol", "browser-control"] as const;

/**
 * Contrato mínimo de los recursos que todos los runtimes pueden proyectar.
 * Todos los adapters comparten esta proyección.
 */
export interface SharedProjectionAdapter {
  id: SelectableRuntimeId;
  paths(configDir: string): AdapterPaths;
  /** Añade orientación propia del runtime a las secciones compartidas. */
  adaptSystemPromptSections?(sections: SystemPromptSections, ctx: InstallContext): SystemPromptSections;
}

export interface Adapter extends SharedProjectionAdapter {
  id: RuntimeId;
  name: string;
  detect(): RuntimeDetection;
  /** Proyecta los seis subagentes en su formato nativo; el principal pertenece al host. */
  renderAgent(
    agent: CanonicalAgent,
    models: AgentModelChoices,
  ): { file: string; content: string; kind: "agent" }[];
  /** Registra MCPs y demás claves gestionadas en la config principal del runtime. */
  planMainConfig(canonical: CanonicalMcp, ctx: InstallContext): FileAction[];
  /**
   * Copias fijas adicionales del runtime (assets propios sin canon legacy, p.ej.
   * los WAV del cliente OpenCode). `buildContentPlan` las incorpora y el pipeline
   * las registra como recursos propios. Opcional para runtimes sin assets.
   */
  planAdditionalResources?(ctx: InstallContext): FileAction[];
  /**
   * Inversa para uninstall: devuelve los archivos COMPARTIDOS con el usuario
   * (system prompt y configs) reescritos sin nuestras secciones/claves.
   * Un write con content vacío significa "borrar el archivo". Los targets de
   * estas acciones marcan además qué archivos del plan normal NO se borran.
   */
  planUnmerge(mcp: CanonicalMcp, ctx: InstallContext): FileAction[];
}
