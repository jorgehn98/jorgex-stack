/**
 * Contrato de versión del host OpenCode v2 (Spec T12, decisión de Jorge
 * 2026-10-02): los gates de host exigen el contrato API v2 — una versión semver
 * parseable con major 2, la última instalada observada — y NO un pin exacto de
 * release. La versión y el sha256 observados se registran como evidencia de lo
 * ejecutado, nunca como selector de una nueva instalación ni para simular
 * rolling quitando integridad.
 */
export interface OpenCodeHostVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly version: string;
}

/** Parsea `opencode v<major>.<minor>.<patch>`; cualquier otra forma es inválida. */
export function parseOpenCodeHostVersion(observed: string): OpenCodeHostVersion | undefined {
  const raw = observed.trim();
  const match = /^opencode v(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (match === null) return undefined;
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}
