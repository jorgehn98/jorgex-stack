import path from "node:path";
import type { SelectableRuntimeId, SharedProjectionAdapter } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";

/**
 * Proyección mínima de los recursos compartidos que Pi consume fuera de su
 * paquete nativo. El registro completo del runtime llegará en otro slice.
 */
export const piAdapter: SharedProjectionAdapter & {
  readonly id: Extract<SelectableRuntimeId, "pi">;
} = {
  id: "pi",

  paths(configDir) {
    const piConfigDir = process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent");
    const agentsHome = samePath(configDir, piConfigDir) ? HOME : path.dirname(configDir);
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
};
