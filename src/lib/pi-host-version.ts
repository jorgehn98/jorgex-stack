import fs from "node:fs";
import path from "node:path";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiHostVersionInspection {
  version: string | null;
  diagnostic: string | null;
}

function invalidManagedPi(diagnostic: string): PiHostVersionInspection {
  return { version: null, diagnostic };
}

function readJsonFile(file: string): unknown {
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
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

function managedPiVersion(executable: string, resolved: string): PiHostVersionInspection {
  const binDir = path.dirname(resolved);
  if (path.basename(resolved) !== "pi" || path.basename(binDir) !== "bin") {
    return invalidManagedPi("launcher gestionado de Pi no reconocido");
  }
  const agentDir = path.dirname(binDir);
  const installDir = path.join(agentDir, "install");
  try {
    if (!fs.lstatSync(executable).isSymbolicLink()) {
      return invalidManagedPi("el entrypoint gestionado de Pi no es un symlink");
    }
    const metadata = readJsonFile(path.join(installDir, "managed-install.json"));
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
      return invalidManagedPi("install/managed-install.json falta o no es JSON válido");
    }
    const entrypoint = Reflect.get(metadata, "entrypoint");
    if (Reflect.get(metadata, "kind") !== "pi-managed-install"
      || Reflect.get(metadata, "schemaVersion") !== 1
      || Reflect.get(metadata, "layout") !== "releases-v1"
      || entrypoint === null || typeof entrypoint !== "object" || Array.isArray(entrypoint)
      || Reflect.get(entrypoint, "type") !== "symlink"
      || Reflect.get(entrypoint, "path") !== executable) {
      return invalidManagedPi("install/managed-install.json no coincide con el entrypoint de Pi");
    }

    const currentPath = path.join(installDir, "current-version");
    const currentStat = fs.lstatSync(currentPath, { throwIfNoEntry: false });
    if (!currentStat?.isFile() || currentStat.isSymbolicLink() || currentStat.size > 128) {
      return invalidManagedPi("install/current-version falta o no es un archivo regular acotado");
    }
    const version = fs.readFileSync(currentPath, "utf8").trim();
    if (version === "." || version === ".." || !/^[0-9A-Za-z._+-]+$/.test(version)) {
      return invalidManagedPi("install/current-version contiene una versión inválida");
    }
    const releaseDir = path.join(installDir, "releases", version);
    if (fs.realpathSync(releaseDir) !== releaseDir) {
      return invalidManagedPi("install/releases contiene un enlace fuera del release gestionado");
    }
    const packageDir = path.join(releaseDir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.realpathSync(packageDir) !== packageDir) {
      return invalidManagedPi("el paquete Pi del release gestionado es un symlink");
    }
    const packageVersion = piPackageVersion(path.join(packageDir, "package.json"));
    return packageVersion === version
      ? { version, diagnostic: null }
      : invalidManagedPi("el manifest de @earendil-works/pi-coding-agent no coincide con install/current-version");
  } catch {
    return invalidManagedPi("no se pudo leer la metadata del release Pi gestionado");
  }
}

function hasManagedPiMarker(resolved: string): boolean {
  const binDir = path.dirname(resolved);
  if (path.basename(resolved) !== "pi" || path.basename(binDir) !== "bin") return false;
  const installDir = path.join(path.dirname(binDir), "install");
  try {
    return fs.lstatSync(path.join(installDir, "managed-install.json"), { throwIfNoEntry: false }) !== undefined
      || fs.lstatSync(path.join(installDir, "current-version"), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

export function inspectPiHostVersion(executable: string): PiHostVersionInspection {
  let resolved: string;
  try {
    resolved = fs.realpathSync(executable);
  } catch {
    return { version: null, diagnostic: "no se pudo resolver el ejecutable Pi" };
  }
  if (hasManagedPiMarker(resolved)) return managedPiVersion(executable, resolved);
  let current = path.dirname(resolved);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const manifest of [
      path.join(current, "package.json"),
      path.join(current, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ]) {
      const version = piPackageVersion(manifest);
      if (version !== null) return { version, diagnostic: null };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { version: null, diagnostic: "no se encontró el manifest del paquete Pi instalado" };
}
