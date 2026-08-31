import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isRunnableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBashExecutable(): string {
  const candidates: string[] = [];
  const gitExecPath = spawnSync("git", ["--exec-path"], {
    encoding: "utf8",
    maxBuffer: 100_000,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000,
    windowsHide: true,
  });
  if (gitExecPath.status === 0 && typeof gitExecPath.stdout === "string") {
    const execPath = gitExecPath.stdout.trim();
    if (execPath.length > 0) {
      const gitRoot = path.resolve(execPath, "..", "..", "..");
      candidates.push(
        path.join(gitRoot, "bin", "bash.exe"),
        path.join(gitRoot, "usr", "bin", "bash.exe"),
        path.join(gitRoot, "bin", "bash"),
      );
    }
  }

  const bashName = process.platform === "win32" ? "bash.exe" : "bash";
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (entry.length > 0) candidates.push(path.join(entry, bashName));
  }

  const executable = candidates.find(isRunnableFile);
  if (executable === undefined) {
    throw new Error("No se encontró Bash ejecutable (se probó Git --exec-path y PATH).");
  }
  return executable;
}
