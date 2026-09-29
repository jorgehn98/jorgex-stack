import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { smokePiProviderRuntime } from "../src/lib/pi-provider-smoke.js";
const agentDir = process.env.JORGEX_PI_PROVIDER_LIVE_AGENT;
const piExecutable = process.env.JORGEX_PI_BIN;
const engramBin = process.env.JORGEX_ENGRAM_BIN;
it.skipIf(!agentDir || !piExecutable || !engramBin)("loads the nested provider roots with real Pi without loading personal settings", async () => {
  expect(path.relative(os.tmpdir(), agentDir!).startsWith("..")).toBe(false);
  const modules = path.join(agentDir!, "npm", "node_modules");
  const result = await smokePiProviderRuntime({
    piExecutable: piExecutable!, engramBin: engramBin!, scratchRoot: agentDir!,
    jorgexPackageRoot: path.join(modules, "jorgex-pi"),
    providerRoots: { "gentle-engram": path.join(modules, "gentle-engram"), "pi-mcp-adapter": path.join(modules, "pi-mcp-adapter") },
  });
  expect(result.commands).toEqual(expect.arrayContaining(["mcp-adapter", "mcp", "permission-system"]));
}, 30_000);
