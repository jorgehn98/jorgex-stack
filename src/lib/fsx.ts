import fs from "node:fs";
import path from "node:path";

export function readTextIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
}

export function copyFile(source: string, target: string): void {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

export function sameFileContent(a: string, b: string): boolean {
  try {
    const bufA = fs.readFileSync(a);
    const bufB = fs.readFileSync(b);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}
