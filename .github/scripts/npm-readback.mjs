import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DEADLINE_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function registryMetadataUrl(packageName, version) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

function isRetriableStatus(status) {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function assertPublicMetadata(metadata, packageName, version) {
  if (!isRecord(metadata)) {
    throw new Error("La metadata de npm no es un objeto.");
  }

  if (metadata.name !== packageName) {
    throw new Error("La metadata de npm contiene un nombre distinto.");
  }

  if (metadata.version !== version) {
    throw new Error("La metadata de npm contiene una versión distinta.");
  }

  const tarball = isRecord(metadata.dist) ? metadata.dist.tarball : undefined;
  if (typeof tarball !== "string") {
    throw new Error("La metadata de npm no contiene un tarball.");
  }

  let tarballUrl;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    throw new Error("La metadata de npm contiene un tarball inválido.");
  }

  if (tarballUrl.protocol !== "https:") {
    throw new Error("La metadata de npm debe contener un tarball HTTPS.");
  }
}

function retryDelay(retryCount, retryDelayMs) {
  // La primera repetición usa el intervalo base; después el intervalo se duplica
  // cada dos lecturas hasta el límite configurado.
  return Math.min(retryDelayMs * (2 ** Math.floor(retryCount / 2)), MAX_RETRY_DELAY_MS);
}

/**
 * Consulta el documento exacto de npm para una versión ya aceptada por `npm publish`.
 * No publica, no ejecuta comandos y no modifica Git.
 */
export async function waitForNpmAvailability({
  packageName,
  version,
  fetch,
  sleep,
  now,
  deadlineAt,
  retryDelayMs,
}) {
  if (typeof packageName !== "string" || packageName === "") {
    throw new Error("El nombre del paquete es obligatorio.");
  }
  if (typeof version !== "string" || version === "") {
    throw new Error("La versión del paquete es obligatoria.");
  }
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
    throw new Error("El deadline y el intervalo de reintento deben ser válidos.");
  }

  const url = registryMetadataUrl(packageName, version);
  let retryCount = 0;
  let attempts = 0;
  let lastFailure;

  const pending = () => ({
    status: "pending",
    reason: "unconfirmed",
    attempts,
    lastFailure,
  });

  while (now() < deadlineAt) {
    const remainingMs = deadlineAt - now();
    let response;

    try {
      attempts += 1;
      response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remainingMs)),
      });
    } catch {
      lastFailure = { category: "network" };
      const delayMs = retryDelay(retryCount, retryDelayMs);
      retryCount += 1;
      if (delayMs > deadlineAt - now()) return pending();
      await sleep(delayMs);
      continue;
    }

    if (response.status === 200) {
      const metadata = await response.json();
      assertPublicMetadata(metadata, packageName, version);
      return { status: "public" };
    }

    if (!isRetriableStatus(response.status)) {
      throw new Error(`El registry de npm respondió HTTP ${response.status}.`);
    }

    lastFailure = { category: "registry", status: response.status };
    const delayMs = retryDelay(retryCount, retryDelayMs);
    retryCount += 1;
    if (delayMs > deadlineAt - now()) return pending();
    await sleep(delayMs);
  }

  return pending();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readPackageMetadata() {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const packageName = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";

  if (packageName === "" || version === "") {
    throw new Error("package.json debe contener name y version válidos.");
  }

  return { packageName, version };
}

function appendSummary(message) {
  const summaryPath = (process.env.GITHUB_STEP_SUMMARY ?? "").trim();
  if (summaryPath !== "") fs.appendFileSync(summaryPath, `${message}\n`, "utf8");
}

export function reportNpmReadbackResult({ packageName, version, result, warn, appendSummary }) {
  if (result.status !== "pending") return;

  const lastFailure = result.lastFailure?.category === "registry"
    ? `última lectura HTTP ${result.lastFailure.status}`
    : "última lectura de red o timeout";
  const warning = `npm readback sin confirmar para ${packageName}@${version} antes del deadline tras ${result.attempts} intentos; ${lastFailure}. La publicación aceptada y su tag no cambian.`;

  warn(`::warning::${warning}`);
  appendSummary(`### npm readback\n\n> ${warning}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) {
    throw new Error("Uso: node .github/scripts/npm-readback.mjs [package-name version]");
  }

  const { packageName, version } = args.length === 2
    ? { packageName: args[0], version: args[1] }
    : readPackageMetadata();

  const result = await waitForNpmAvailability({
    packageName,
    version,
    fetch: globalThis.fetch,
    sleep,
    now: Date.now,
    deadlineAt: Date.now() + DEFAULT_DEADLINE_MS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  });

  if (result.status === "public") {
    const message = `npm readback confirmado: ${packageName}@${version} ya es público.`;
    console.log(message);
    appendSummary(`### npm readback\n\n${message}`);
    return;
  }

  reportNpmReadbackResult({
    packageName,
    version,
    result,
    warn: console.warn,
    appendSummary,
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
