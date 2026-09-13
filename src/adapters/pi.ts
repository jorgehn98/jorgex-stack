import path from "node:path";
import type { SelectableRuntimeId, SharedProjectionAdapter } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";

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

  injectEngramProtocol() {
    return true;
  },

  // La guía Context7 se habilita al adoptar su registro HTTP en Pi.
  adaptSystemPromptSections(sections) {
    const modular = { ...sections };
    delete modular.context7;
    return modular;
  },
};
