/**
 * Contrato central del proyecto (PRD §5): cada runtime implementa un Adapter
 * que declara DÓNDE va cada cosa y CÓMO se escribe. Los componentes
 * (src/components/) iteran (componente × adapter) sin switches por runtime.
 */

import type { WritingStyleSnapshot } from "../lib/writing-style.js";
import type { RuntimeDetection } from "../lib/detect.js";
import type { CanonicalAgent, CanonicalHooks, CanonicalMcp } from "../lib/canonical.js";
import type { AgentModelChoices } from "../lib/agent-model.js";
import type { LocalQualityCapabilityReport } from "../lib/quality-capabilities.js";
import type { SystemPromptSections } from "../lib/system-prompt-sections.js";

export type RuntimeId = "claude-code" | "codex" | "opencode" | "pi";
export type SelectableRuntimeId = RuntimeId;

export type InstallMode = "human" | "programmatic";

export type SubagentConcurrency = "serial" | "parallel";

/**
 * Evidencia de major OpenCode EXCLUSIVAMENTE para el sandbox --target-dir (en
 * tests, `JORGEX_OPENCODE_TARGET_MAJOR=2`); allí es obligatoria. Fuera de
 * target se ignora: una instalación real siempre prueba el binario detectado y
 * esta evidencia no acredita capacidad ni sirve de bypass.
 */
export interface OpenCodeTargetEvidenceOption {
  opencodeTargetMajor?: number;
}

export type InstallModePreference =
  | { mode: "human"; subagentConcurrency: "serial" }
  | { mode: "programmatic"; subagentConcurrency: SubagentConcurrency };

export interface McpOwnershipChange {
  server: string;
  owned: boolean;
}

export interface PrimaryModelOwnershipChange {
  field: string;
  owned: boolean;
}

/** Acción de instalación planificada. El pipeline la compara con el disco antes de aplicar. */
export type FileAction =
  | {
      kind: "write";
      target: string;
      content: string;
      mcpOwnership?: McpOwnershipChange[];
      primaryModelOwnership?: PrimaryModelOwnershipChange[];
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
  /** Modo de instalación resuelto para este run. */
  mode?: InstallMode;
  /** Concurrencia de subagentes resuelta para este run. */
  subagentConcurrency?: SubagentConcurrency;
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
  /** Campos del primary model que una escritura previa del stack creó. */
  ownedPrimaryModelFields?: ReadonlySet<string>;
  /**
   * Opt-in para re-aplicar el bloque de permisos gestionados sobre una
   * config existente: sin flag se preserva byte a byte y solo se avisa
   * cuando difiere; con flag se reemplaza el bloque entero (con backup
   * previo en el pipeline). Nunca default — lo fija runInstall desde
   * InstallOptions.
   */
  upgradePermissions?: boolean;
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
  commandsDir: string;
  /** null si el runtime no tiene plugins TS (Claude Code, Codex). */
  pluginsDir: string | null;
  scriptsDir: string;
  /** Solo Claude Code: modos del main agent (output styles). null en el resto. */
  outputStylesDir: string | null;
  /** Solo Codex: profiles (<nombre>.config.toml). null en el resto. */
  profilesDir: string | null;
}

/**
 * Secciones retiradas (provider-only): Stack ya no las inyecta en ningún
 * runtime — el provider oficial (`engram setup` + plugin/MCP/skills oficiales)
 * es el único owner. Lista acotada SOLO para migración: sync/install/uninstall
 * eliminan idempotentemente los bloques que versiones anteriores instalaron.
 * No añadir secciones activas aquí.
 */
export const LEGACY_SYSTEM_PROMPT_SECTIONS = ["engram-protocol"] as const;

/**
 * Contrato mínimo de los recursos que todos los runtimes pueden proyectar.
 * Pi lo usa sin participar aún en el ciclo de vida completo de Adapter.
 */
export interface SharedProjectionAdapter {
  id: SelectableRuntimeId;
  paths(configDir: string): AdapterPaths;
  /** Transforma un command canónico al dialecto del runtime (placeholders de input, etc.). */
  renderCommand(file: string, content: string): { file: string; content: string };
  /** Adapta los bloques a un formato legado cuando el runtime aún lo requiere. */
  adaptSystemPromptSections?(sections: SystemPromptSections): SystemPromptSections;
}

export interface Adapter extends SharedProjectionAdapter {
  id: RuntimeId;
  name: string;
  /** Basenames de plugins que este runtime excluye del plan Stack (p.ej. legacy retirado). */
  excludedPluginBasenames?: readonly string[];
  detect(): RuntimeDetection;
  /** Diagnóstico local de capabilities; nunca certifica enforcement del runtime. */
  reportCapabilities(configDir: string): LocalQualityCapabilityReport;
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
   * las autentica como recursos current-only. Opcional: los runtimes sin assets
   * no lo definen, y no se relaja `planPlugins` por extensión.
   */
  planAdditionalResources?(ctx: InstallContext): FileAction[];
  /**
   * Inversa para uninstall: devuelve los archivos COMPARTIDOS con el usuario
   * (system prompt, configs, hooks) reescritos sin nuestras secciones/claves.
   * Un write con content vacío significa "borrar el archivo". Los targets de
   * estas acciones marcan además qué archivos del plan normal NO se borran.
   */
  planUnmerge(mcp: CanonicalMcp, hooks: CanonicalHooks, ctx: InstallContext): FileAction[];
}
