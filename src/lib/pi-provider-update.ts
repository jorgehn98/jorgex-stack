import fs from "node:fs";
import path from "node:path";
import { inventoryTreeSha256 } from "./pi-staged-lock.js";
import { declaredPiMcpConfigFiles, migrateOfficialPiMcpConfig, resolvePiAdapterConfigPath } from "./pi-mcp-config.js";
import { resolveLatestNpmPackageRelease } from "./npm-provider.js";
import { stagePiProviderPackages } from "./pi-provider-stage.js";
import { activatePiProviderPackages } from "./pi-provider-activation.js";
import { smokePiProviderRuntime } from "./pi-provider-smoke.js";

function isStrictChildPath(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function completeUpdatedPiMcp(configDir: string, engramBin: string): Promise<void> {
  const { verifyOfficialSetup } = await import("../adapters/pi.js");
  const before = await verifyOfficialSetup({ configDir, engramBin });
  if (!before.layers.includes("packages")) throw new Error(before.reason ?? "Setup de paquetes Pi incompleto.");
  migrateOfficialPiMcpConfig({ configDir, engramBin });
  const after = await verifyOfficialSetup({ configDir, engramBin });
  if (!after.ok) throw new Error(after.reason ?? "Configuración MCP Pi no verificada.");
}

/** Deliberate provider update after the managed Pi package/projection gate. */
export async function updatePiProviderPackages(input: {
  homeDir: string; agentDir: string; piExecutable: string; engramBin: string;
}): Promise<{ kind: "updated" | "healthy"; versions: Record<"gentle-engram" | "pi-mcp-adapter", string> }> {
  const { homeDir, agentDir } = input;
  if (!isStrictChildPath(agentDir, homeDir)) throw new Error("Pi provider agent directory is outside HOME");
  const receiptPath = path.join(homeDir, ".jorgex-stack", "pi-receipt.json");
  const settingsPath = path.join(agentDir, "settings.json");
  for (const file of [receiptPath, settingsPath]) {
    if (!fs.lstatSync(file).isFile()) throw new Error("Pi provider update requires regular managed state files");
  }
  const receiptBytes = fs.readFileSync(receiptPath, "utf8");
  const settingsJson = fs.readFileSync(settingsPath, "utf8");
  const modules = path.join(agentDir, "npm", "node_modules");
  const packageLink = path.join(modules, "jorgex-pi");
  if (!fs.lstatSync(packageLink).isSymbolicLink()) throw new Error("Pi provider update requires the managed private link");
  const linkTarget = fs.readlinkSync(packageLink);
  const packageRoot = fs.realpathSync(packageLink);
  const releaseDir = path.dirname(path.dirname(packageRoot));
  if (!isStrictChildPath(releaseDir, path.join(agentDir, "npm", "jorgex-pi-managed", "releases"))
    || packageRoot !== path.join(releaseDir, "node_modules", "jorgex-pi")) {
    throw new Error("Pi provider update found an untrusted private release path");
  }
  const privateTree = inventoryTreeSha256(releaseDir);
  const assertPrivateUnchanged = (): void => {
    if (!fs.lstatSync(receiptPath).isFile() || fs.readFileSync(receiptPath, "utf8") !== receiptBytes
      || !fs.lstatSync(packageLink).isSymbolicLink() || fs.readlinkSync(packageLink) !== linkTarget
      || fs.realpathSync(packageLink) !== packageRoot || inventoryTreeSha256(releaseDir) !== privateTree) {
      throw new Error("Pi private receipt/link/tree drift during provider update");
    }
  };
  const releases = {
    "gentle-engram": await resolveLatestNpmPackageRelease("gentle-engram", fetch),
    "pi-mcp-adapter": await resolveLatestNpmPackageRelease("pi-mcp-adapter", fetch),
  };
  const staged = await stagePiProviderPackages({ ...input, releases });
  assertPrivateUnchanged();
  const providerRoots = Object.fromEntries(staged.packages.map((provider) => [provider.name, provider.packageRoot])) as Record<"gentle-engram" | "pi-mcp-adapter", string>;
  const activeRoots = { "gentle-engram": path.join(modules, "gentle-engram"), "pi-mcp-adapter": path.join(modules, "pi-mcp-adapter") };
  const adapterAgentDir = path.dirname(path.dirname(path.dirname(providerRoots["pi-mcp-adapter"])));
  const selectedConfig = path.basename(resolvePiAdapterConfigPath(adapterAgentDir));
  if (!declaredPiMcpConfigFiles(agentDir).includes(selectedConfig)) {
    throw new Error("The verified Pi package does not declare the candidate provider MCP reader");
  }
  for (const provider of staged.packages) {
    if (inventoryTreeSha256(provider.packageRoot) !== provider.treeSha256) throw new Error("Pi provider stage drift before smoke");
  }
  const smoke = { piExecutable: input.piExecutable, engramBin: input.engramBin, scratchRoot: staged.stageDir, jorgexPackageRoot: packageLink };
  await smokePiProviderRuntime({ ...smoke, providerRoots });
  assertPrivateUnchanged();
  const unchanged = staged.packages.every((provider) => fs.existsSync(activeRoots[provider.name])
    && inventoryTreeSha256(activeRoots[provider.name]) === provider.treeSha256);
  if (!unchanged) {
    await activatePiProviderPackages({
      homeDir, agentDir, stageDir: staged.stageDir, packages: staged.packages, settingsJson,
      verify: async () => {
        assertPrivateUnchanged();
        await smokePiProviderRuntime({ ...smoke, providerRoots: activeRoots });
        assertPrivateUnchanged();
      },
    });
  }
  assertPrivateUnchanged();
  try { await completeUpdatedPiMcp(agentDir, input.engramBin); }
  catch (error) {
    throw new Error(`Pi providers activated and verified; MCP configuration pending with backup preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { kind: unchanged ? "healthy" : "updated", versions: {
    "gentle-engram": releases["gentle-engram"].version, "pi-mcp-adapter": releases["pi-mcp-adapter"].version,
  } };
}

