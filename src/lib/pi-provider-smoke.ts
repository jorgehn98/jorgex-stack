import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { resolvePiAdapterConfigPath } from "./pi-mcp-config.js";
import { smokeStagedPiRuntime, type PiStageSmokeResult } from "./pi-stage-smoke.js";

/** Load only the managed integration, never personal extensions, auth, or memory data. */
export async function smokePiProviderRuntime(input: {
  piExecutable: string;
  jorgexPackageRoot: string;
  providerRoots: Record<"gentle-engram" | "pi-mcp-adapter", string>;
  engramBin: string;
  scratchRoot: string;
}): Promise<PiStageSmokeResult> {
  const root = fs.mkdtempSync(path.join(input.scratchRoot, "stage-providers-smoke-"));
  // This is an import/registration probe, not a memory-service health check.
  // An explicit owned endpoint prevents gentle-engram from starting a detached
  // daemon or contacting the user's existing HTTP service during this probe.
  const endpoint = createServer((_request, response) => {
    response.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
    response.end('{"error":"isolated package smoke"}');
  });
  let failed = false;
  let smokeError: unknown;
  try {
    const stageDir = path.join(root, "pi-agent");
    const modules = path.join(stageDir, "npm", "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.mkdirSync(path.join(root, "workspace"));
    const packages: string[] = [];
    for (const [name, source] of Object.entries({ "jorgex-pi": input.jorgexPackageRoot, ...input.providerRoots })) {
      const packageRoot = fs.realpathSync(source);
      const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      if (metadata.name !== name || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
        throw new Error(`Pi provider smoke: invalid ${name} identity`);
      }
      fs.symlinkSync(path.relative(modules, packageRoot), path.join(modules, name), "dir");
      packages.push(`npm:${name}@${metadata.version}`);
    }
    // Select the legacy provider contract explicitly: the newer builtin MCP warns on stderr, which the strict RPC check rejects.
    fs.writeFileSync(path.join(stageDir, "settings.json"), JSON.stringify({ packages, extensions: ["-builtin:mcp"] }));
    fs.writeFileSync(resolvePiAdapterConfigPath(stageDir), JSON.stringify({ mcpServers: {
      engram: { command: input.engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
    } }));
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", () => { endpoint.off("error", reject); resolve(); });
    });
    const address = endpoint.address();
    if (address === null || typeof address === "string") throw new Error("Pi provider smoke: no loopback endpoint");
    return await smokeStagedPiRuntime({
      piExecutable: input.piExecutable, stageDir,
      providerSetup: { engramBin: input.engramBin, engramUrl: `http://127.0.0.1:${address.port}` },
    });
  } catch (error) {
    failed = true;
    smokeError = error;
    throw error;
  } finally {
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    try {
      // Windows can briefly retain directory handles after process teardown.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      const detail = smokeError instanceof Error ? smokeError.message : String(smokeError);
      throw new AggregateError([smokeError, cleanupError],
        `${detail}; Pi provider smoke cleanup failed at ${root}`, { cause: smokeError });
    }
  }
}
