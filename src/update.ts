import * as p from "@clack/prompts";
import { runInstall, type InstallOptions } from "./install.js";

export async function runUpdate(opts: InstallOptions): Promise<number> {
  return runInstall({ ...opts, command: "update" });
}
/** Read-only discovery: no package resolution, download or implicit native update. */
export async function runUpdateCheck(_localVersion?: string): Promise<number> {
  p.log.info("Update deliberado utiliza los canales oficiales vigentes, sin pins. Ejecuta doctor para comprobar el estado local; --check no descarga ni aplica actualizaciones.");
  return 0;
}
