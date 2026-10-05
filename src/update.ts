import { runInstall, type InstallOptions } from "./install.js";

export async function runUpdate(opts: InstallOptions): Promise<number> {
  return runInstall({ ...opts, command: "update" });
}
