import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { detectEngram } from "./lib/detect.js";
import { stackRoot } from "./lib/paths.js";
import { engramVersion } from "./doctor.js";

interface Upstreams {
  tools: Record<string, { source: string }>;
  skills: Record<string, { source: string; version?: string; modified?: boolean }>;
}

function loadUpstreams(): Upstreams {
  const file = path.join(path.dirname(stackRoot()), "upstreams.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as Upstreams;
}

async function latestGithubRelease(repo: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "jorgex-stack" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
  }
}

async function latestNpmVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * update --check: compara versiones locales vs upstream. `update` sin --check
 * re-aplica el stack (sync) y muestra este informe; aplicar updates de skills
 * de terceros automáticamente queda para v1.x (las 'modified' exigen diff
 * manual — PRD §7.3).
 */
export async function runUpdateCheck(localVersion: string): Promise<number> {
  p.intro("jorgex-stack update --check");
  const upstreams = loadUpstreams();

  // 1. El propio stack (npm).
  const npmLatest = await latestNpmVersion("jorgex-stack");
  if (npmLatest === null) p.log.info(`jorgex-stack: v${localVersion} local (aún no publicado en npm o sin red).`);
  else if (npmLatest === localVersion) p.log.success(`jorgex-stack: v${localVersion} — al día.`);
  else p.log.warn(`jorgex-stack: v${localVersion} local, v${npmLatest} en npm → pnpm dlx jorgex-stack@latest`);

  // 2. Engram (D7: solo informar; actualizar es decisión del usuario).
  const engramRepo = upstreams.tools["engram"]?.source.replace(/^github:/, "");
  if (engramRepo) {
    const bin = detectEngram();
    const local = bin ? engramVersion(bin) : null;
    const latest = await latestGithubRelease(engramRepo);
    if (local === null) p.log.warn("engram: no detectado en esta máquina.");
    else if (latest === null) p.log.info(`engram: ${local} local (no se pudo consultar el upstream).`);
    else if (latest === local) p.log.success(`engram: ${local} — al día.`);
    else
      p.log.warn(
        `engram: ${local} local, ${latest} disponible. Tu instalación NO se toca (D7) — actualiza tú: github.com/${engramRepo}/releases`,
      );
  }

  // 3. Skills de terceros.
  const modified: string[] = [];
  const upstreamed: string[] = [];
  for (const [name, info] of Object.entries(upstreams.skills)) {
    if (info.modified) modified.push(`${name} (${info.source})`);
    else upstreamed.push(`${name} → ${info.source.replace(/^github:/, "github.com/")}`);
  }
  if (modified.length > 0) {
    p.log.warn(`Skills con modificaciones locales (update manual con diff, nunca reemplazo ciego):`);
    for (const m of modified) p.log.message(`  ~ ${m}`);
  }
  if (upstreamed.length > 0) {
    p.log.info(`Skills de terceros sin modificar (${upstreamed.length}) — upstreams registrados en upstreams.json.`);
  }

  p.outro("Check completado.");
  return 0;
}
