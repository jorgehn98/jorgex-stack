import type { Adapter, FileAction, InstallContext } from "../adapters/types.js";
import {
  DEVTOOLS_MCP_SERVER,
  isCanonicalMcpServerEnabled,
  loadCanonicalMcp,
  materializeCanonicalDevtoolsServer,
} from "../lib/canonical.js";

export function planMcp(adapter: Adapter, ctx: InstallContext): FileAction[] {
  const canonical = loadCanonicalMcp(ctx.stackDir);
  const server = canonical.servers[DEVTOOLS_MCP_SERVER];
  const enabled = server !== undefined && isCanonicalMcpServerEnabled(DEVTOOLS_MCP_SERVER, server, ctx.enabledMcpServers);
  const owned = ctx.ownedMcpServers?.has(DEVTOOLS_MCP_SERVER) === true;
  if (server !== undefined && (enabled || owned)) {
    const observed = ctx.devtoolsMcpObservedVersion;
    if (observed === undefined) {
      throw new Error("DevTools: falta la versión observada verificada para materializar el servidor habilitado.");
    }
    const materialized = materializeCanonicalDevtoolsServer(server, observed);
    return adapter.planMainConfig(
      { servers: { ...canonical.servers, [DEVTOOLS_MCP_SERVER]: materialized } },
      ctx,
    );
  }
  return adapter.planMainConfig(canonical, ctx);
}
