import fs from "node:fs";
import path from "node:path";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function readJsonFile(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function piPackageVersion(file: string): string | null {
  try {
    const value = readJsonFile(file);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const packageName = Reflect.get(value, "name");
    const version = Reflect.get(value, "version");
    return packageName === PI_PACKAGE_NAME && typeof version === "string" && version !== "" && !/\s/.test(version)
      ? version : null;
  } catch {
    return null;
  }
}

function managedPiVersion(executable: string, resolved: string): string | null {
  const binDir = path.dirname(resolved);
  if (path.basename(resolved) !== "pi" || path.basename(binDir) !== "bin") return null;
  const agentDir = path.dirname(binDir);
  const installDir = path.join(agentDir, "install");
  try {
    if (!fs.lstatSync(executable).isSymbolicLink()) return null;
    const metadata = readJsonFile(path.join(installDir, "managed-install.json"));
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const entrypoint = Reflect.get(metadata, "entrypoint");
    if (Reflect.get(metadata, "kind") !== "pi-managed-install"
      || Reflect.get(metadata, "schemaVersion") !== 1
      || Reflect.get(metadata, "layout") !== "releases-v1"
      || entrypoint === null || typeof entrypoint !== "object" || Array.isArray(entrypoint)
      || Reflect.get(entrypoint, "type") !== "symlink"
      || Reflect.get(entrypoint, "path") !== executable) return null;

    const currentPath = path.join(installDir, "current-version");
    const currentStat = fs.lstatSync(currentPath);
    if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.size > 128) return null;
    const version = fs.readFileSync(currentPath, "utf8").trim();
    if (version === "." || version === ".." || !/^[0-9A-Za-z._+-]+$/.test(version)) return null;
    const releaseDir = path.join(installDir, "releases", version);
    if (fs.realpathSync(releaseDir) !== releaseDir) return null;
    const packageDir = path.join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.realpathSync(packageDir) !== packageDir) return null;
    const packageVersion = piPackageVersion(path.join(packageDir, "package.json"));
    return packageVersion === version ? version : null;
  } catch {
    return null;
  }
}

export function detectPiHostVersion(executable: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(executable);
  } catch {
    return null;
  }
  let current = path.dirname(resolved);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const manifest of [
      path.join(current, "package.json"),
      path.join(current, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ]) {
      const version = piPackageVersion(manifest);
      if (version !== null) return version;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return managedPiVersion(executable, resolved);
}
