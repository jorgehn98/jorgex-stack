import { editJsonc, upsertJson } from "../lib/filemerge.js";
import { readTextIfExists } from "../lib/fsx.js";
import { planOwnedProjection } from "../lib/owned-projection.js";
import fs from "node:fs";
import path from "node:path";
import { BROWSER_CONTROL_GUIDANCE } from "../lib/canonical.js";
import type { Adapter } from "./types.js";
import { HOME, samePath } from "../lib/paths.js";
import { detectPi } from "../lib/detect.js";
import { createLocalCapabilityReport } from "../lib/quality-capabilities.js";
import { removeSystemPromptSections } from "../lib/system-prompt-sections.js";
import { registerOfficialSetupVerifier } from "../lib/official-engram-setup.js";
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
export const piAdapter: Adapter = {
  id: "pi",
  name: "Pi",
  detect: detectPi,
  adaptSystemPromptSections(sections) { return { ...sections, browser: BROWSER_CONTROL_GUIDANCE }; },
  reportCapabilities() { return createLocalCapabilityReport("pi", []); },
  planUnmerge(canonical, _hooks, ctx) {
    const prompt = path.join(ctx.configDir, "AGENTS.md");
    const actions = [{ kind: "write" as const, target: prompt, content: removeSystemPromptSections(readTextIfExists(prompt) ?? "") }];
    const target = path.join(ctx.configDir, "mcp.json");
    const raw = readTextIfExists(target);
    if (raw !== null) actions.push({ kind: "write", target, content: editJsonc(raw, (root) => {
      if (!isRecord(root.mcpServers)) throw new Error("Pi: mcpServers inválido; se conserva.");
      for (const name of ctx.ownedMcpServers ?? []) {
        const current = root.mcpServers[name];
        if (!isRecord(current)) continue;
        const canonicalContext = { url: canonical.servers.context7?.url, headers: { CONTEXT7_API_KEY: "" } };
        const canonicalBrowser = { command: "browser-control-mcp", args: [] };
        const expected = name === "context7" ? canonicalContext : name === "browser-control" ? canonicalBrowser : null;
        if (expected && JSON.stringify(current) === JSON.stringify(expected)) delete root.mcpServers[name];
      }
    }) });
    return actions;
  },

  paths(configDir) {
    const piConfigDir = path.dirname(piSystemPromptFile());
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

  renderAgent(agent) {
    const tools = agent.readonly ? "read, grep, find, ls" : "read, grep, find, ls, bash, edit, write";
    return [{
      kind: "agent",
      file: `${agent.name}.md`,
      content: `---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description)}\ntools: ${tools}\nallowedAgents:\nallowNestedSubagents: false\n---\n${agent.body}`,
    }];
  },

  planAdditionalResources(ctx) {
    const source = path.join(ctx.stackDir, "assets", "pi", "jorgex-header.ts");
    fs.readFileSync(source);
    return planOwnedProjection({ kind: "copy", source, target: path.join(ctx.configDir, "extensions", "jorgex-header.ts") }, ctx);
  },

  planMainConfig(canonical, ctx) {
    const target = path.join(ctx.configDir, "mcp.json");
    let created = false;
    const content = upsertJson(readTextIfExists(target), (root) => {
      root.mcpServers ??= {};
      if (!isRecord(root.mcpServers)) throw new Error(`Pi: mcpServers inválido en ${target}`);
      if (root.mcpServers.context7 !== undefined) {
        if (!isRecord(root.mcpServers.context7) || root.mcpServers.context7.url !== canonical.servers.context7?.url) throw new Error(`Pi: Context7 incompatible en ${target}`);
        return;
      }
      const server = canonical.servers.context7;
      if (!server || server.transport !== "http" || !server.url) throw new Error("Pi: falta Context7 HTTP canónico");
      root.mcpServers.context7 = { url: server.url, headers: { CONTEXT7_API_KEY: "" } };
      created = true;
    });
    const ownership = created ? [{ server: "context7", owned: true }] : [];
    const nativeContent = ctx.browserControlInvocation ? upsertJson(content, (root) => {
      const servers = root.mcpServers as Record<string, unknown>;
      if (servers["browser-control"] === undefined) {
        servers["browser-control"] = { command: ctx.browserControlInvocation!.command, args: [...ctx.browserControlInvocation!.args] };
        ownership.push({ server: "browser-control", owned: true });
      } else {
        const current = servers["browser-control"];
        if (!isRecord(current) || current.command !== ctx.browserControlInvocation!.command || JSON.stringify(current.args ?? []) !== JSON.stringify(ctx.browserControlInvocation!.args) || current.enabled === false || current.disabled === true) throw new Error("Pi: Browser Control incompatible; se conserva sin reclamar.");
      }
    }) : content;
    return [{ kind: "write", target, content: nativeContent, mcpOwnership: ownership }];
  },

  renderCommand(file, content) {
    return { file, content: content.replace(/\{\{input\}\}/g, "$ARGUMENTS") };
  },

};


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function verifyOfficialSetup(args: { configDir: string }): Promise<{ ok: boolean; layers: string[]; duplicates: boolean }> {
  const raw = readTextIfExists(path.join(args.configDir, "settings.json"));
  const settings: unknown = raw === null ? {} : JSON.parse(raw);
  const packages = isRecord(settings) && Array.isArray(settings.packages) ? settings.packages : [];
  const gentle = packages.filter((entry: unknown) => (typeof entry === "string" ? entry : isRecord(entry) ? entry.source : undefined) === "npm:gentle-engram");
  return { ok: gentle.length === 1, layers: [gentle.length === 1 ? "native-package" : "native-package:missing-or-pinned"], duplicates: gentle.length > 1 };
}
registerOfficialSetupVerifier("pi", verifyOfficialSetup);
