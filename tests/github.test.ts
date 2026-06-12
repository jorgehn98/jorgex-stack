import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  latestGithubRelease,
  latestGithubCommit,
  downloadRepoTarball,
  githubRateLimited,
  ghPresentButTokenFailed,
  __resetGithubState,
} from "../src/lib/github.js";

/**
 * Resuelve la ruta al ejecutable tar que entiende rutas Windows nativas.
 * En Windows con Git-MSYS instalado, "tar" apunta al tar MSYS que interpreta
 * "C:" como hostname de red y falla. El bsdtar del sistema (System32) sí
 * acepta rutas Windows. En Linux/macOS devuelve "tar" directamente.
 */
function resolveWindowsTar(): string {
  if (process.platform !== "win32") return "tar";
  const winTar = [process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe"].join(
    path.sep,
  );
  try {
    execFileSync(winTar, ["--version"], { stdio: "pipe" });
    return winTar;
  } catch {
    return "tar"; // fallback
  }
}

const TAR = resolveWindowsTar();

/**
 * Crea un fixture .tar.gz real con un directorio raíz rootName/ para simular
 * el formato de descarga de GitHub (GitHub empaqueta como "repo-sha/...").
 * Usa el tar resuelto por resolveWindowsTar() para manejar rutas Windows.
 */
function makeFixtureTarball(rootDir: string, tarPath: string, rootName: string): void {
  execFileSync(TAR, ["-czf", tarPath, "-C", path.dirname(rootDir), rootName], { stdio: "pipe" });
}

/**
 * PATH con el directorio del tar correcto al frente.
 * downloadRepoTarball llama a execFileSync("tar", ...) sin env explícito, por lo
 * que hereda process.env.PATH. Stubeando PATH ponemos el bsdtar de System32 antes
 * del tar MSYS de Git para que la extracción en los tests también funcione.
 */
function pathWithWindowsTar(): string {
  if (process.platform !== "win32") return process.env["PATH"] ?? "";
  const sys32 = [process.env["SystemRoot"] ?? "C:\\Windows", "System32"].join(path.sep);
  return sys32 + path.delimiter + (process.env["PATH"] ?? "");
}

// ---------------------------------------------------------------------------
// Generador de tarballs maliciosos en puro Node.js (sin dependencias externas).
//
// Construye buffers de 512 bytes por entrada (formato POSIX ustar) y los
// comprime con zlib.gzipSync. No usa fs.symlinkSync (EPERM en Windows) —
// los bytes se arman directamente, lo que hace los fixtures portables.
// ---------------------------------------------------------------------------

/** Escribe una cadena ASCII en un Buffer en la posición indicada (null-padded). */
function writeField(buf: Buffer, offset: number, len: number, value: string): void {
  buf.fill(0, offset, offset + len);
  buf.write(value, offset, "ascii");
}

/** Escribe un número como octal con terminador (formato POSIX tar). */
function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  // Formato: dígitos octales + espacio-null o null, relleno de ceros a la izquierda.
  const s = value.toString(8).padStart(len - 1, "0") + "\0";
  buf.write(s.slice(0, len), offset, "ascii");
}

/** Calcula el checksum POSIX: suma de todos los bytes del header con el campo
 *  checksum (offset 148, 8 bytes) tratado como espacios (0x20). */
function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  }
  return sum;
}

/** Construye un header tar de 512 bytes. */
function makeTarHeader(opts: {
  name: string;
  typeflag: "0" | "2" | "5";
  size: number;
  linkname?: string;
}): Buffer {
  const header = Buffer.alloc(512, 0);

  writeField(header, 0, 100, opts.name);
  writeOctal(header, 100, 8, 0o000644); // mode
  writeOctal(header, 108, 8, 0);        // uid
  writeOctal(header, 116, 8, 0);        // gid
  writeOctal(header, 124, 12, opts.size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  // checksum placeholder (spaces) — se calcula abajo
  header.fill(0x20, 148, 156);
  header.write(opts.typeflag, 156, "ascii");
  if (opts.linkname) writeField(header, 157, 100, opts.linkname);
  // USTAR magic
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  const cksum = computeChecksum(header);
  // Formato del checksum: 6 dígitos octales + null + espacio
  header.write(cksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  return header;
}

/** Rellena el contenido de un archivo hasta el siguiente múltiplo de 512. */
function padContent(content: Buffer): Buffer {
  const rem = content.length % 512;
  if (rem === 0) return content;
  const padded = Buffer.alloc(content.length + (512 - rem), 0);
  content.copy(padded);
  return padded;
}

interface TarEntry {
  name: string;
  typeflag: "0" | "2" | "5";
  content?: Buffer;
  linkname?: string;
}

/**
 * Ensambla un tarball (.tar.gz) a partir de entradas en memoria.
 * Devuelve el Buffer comprimido listo para servir como Response.body.
 *
 * Cada entrada de tipo "0" (archivo regular) puede tener `content` (Buffer).
 * Cada entrada de tipo "2" (symlink) debe tener `linkname`.
 * Cada entrada de tipo "5" (directorio) no lleva contenido.
 *
 * El resultado siempre termina con dos bloques de 512 bytes a cero (fin de tar).
 */
function buildTarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];

  for (const entry of entries) {
    const content = entry.typeflag === "0" ? (entry.content ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const header = makeTarHeader({
      name: entry.name,
      typeflag: entry.typeflag,
      size: content.length,
      linkname: entry.linkname,
    });
    parts.push(header);
    if (content.length > 0) {
      parts.push(padContent(content));
    }
  }

  // Fin de archivo: dos bloques de ceros.
  parts.push(Buffer.alloc(1024, 0));

  const tarBuf = Buffer.concat(parts);
  return zlib.gzipSync(tarBuf);
}

/**
 * Recorre recursivamente un directorio y devuelve rutas absolutas de todas
 * las entradas. Incluye symlinks sin seguirlos.
 */
function walkDir(dir: string): string[] {
  const result: string[] = [];
  const visit = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      result.push(full);
      // Entrar en el directorio solo si NO es symlink (para no seguirlo).
      if (e.isDirectory() && !e.isSymbolicLink()) visit(full);
    }
  };
  visit(dir);
  return result;
}

// ---------------------------------------------------------------------------
// Único archivo del repo autorizado a usar vi.stubGlobal / vi.stubEnv.
// afterEach SIEMPRE restaura globals y env para no contaminar otros tests.
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  __resetGithubState();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jx-github-test-"));
  // Anular env vars de token presentes en la máquina del CI / desarrollador
  // para que los tests de "sin token" no fallen por variables heredadas.
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  // En Windows, poner el bsdtar de System32 antes del tar MSYS de Git para
  // que downloadRepoTarball pueda extraer con rutas Windows nativas.
  vi.stubEnv("PATH", pathWithWindowsTar());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// latestGithubRelease
// ---------------------------------------------------------------------------

describe("latestGithubRelease", () => {
  it('200 con tag_name "v1.2.3" → "1.2.3" (strip v)', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBe("1.2.3");
  });

  it('200 con tag_name "1.2.3" (sin v) → "1.2.3"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "1.2.3" }), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBe("1.2.3");
  });

  it("200 sin tag_name → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
  });

  it("500 → null, githubRateLimited() === false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(false);
  });

  it("403 → null Y githubRateLimited() === true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 403 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(true);
  });

  it("429 → null Y githubRateLimited() === true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 429 })),
    );
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
    expect(githubRateLimited()).toBe(true);
  });

  it("fetch lanza → null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await latestGithubRelease("owner/repo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// latestGithubCommit
// ---------------------------------------------------------------------------

describe("latestGithubCommit", () => {
  it('200 [{sha: "abc123"}] → "abc123"', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ sha: "abc123" }]), { status: 200 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBe("abc123");
  });

  it("200 [] (lista vacía) → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBeNull();
  });

  it("!ok → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const result = await latestGithubCommit("owner/repo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token por cabeceras
// Observamos el token a través de las cabeceras que recibe el fetch stubeado,
// llamando a latestGithubRelease como punto de entrada público.
//
// Los mocks se tipan con la firma de fetch para que TypeScript infiera
// mock.calls como [RequestInfo | URL, RequestInit?][] y permita indexar [n][1].
// ---------------------------------------------------------------------------

describe("token: precedencia y caché", () => {
  it("GH_TOKEN='aaa' + GITHUB_TOKEN='bbb' → Authorization Bearer aaa (GH_TOKEN gana)", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer aaa");
  });

  it("solo GITHUB_TOKEN='bbb' → Authorization Bearer bbb", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "bbb");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer bbb");
  });

  it("GH_TOKEN con espacios '  ccc  ' → Bearer ccc (trim aplicado)", async () => {
    vi.stubEnv("GH_TOKEN", "  ccc  ");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer ccc");
  });

  it("caché: segunda llamada usa token congelado aunque cambie el env", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await latestGithubRelease("owner/repo");
    // Cambiamos el env DESPUÉS de que el token ya esté cacheado
    vi.stubEnv("GH_TOKEN", "zzz");
    // Segunda llamada — debe seguir usando "aaa"
    await latestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer aaa");
  });

  it("tras __resetGithubState(), el token se recalcula con el env actual", async () => {
    vi.stubEnv("GH_TOKEN", "aaa");
    vi.stubEnv("GITHUB_TOKEN", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // Primera llamada — cachea "aaa"
    await latestGithubRelease("owner/repo");
    // Reset + cambio de env
    __resetGithubState();
    vi.stubEnv("GH_TOKEN", "zzz");
    // Tras el reset, debe leer "zzz"
    await latestGithubRelease("owner/repo");

    const secondCallHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.["Authorization"]).toBe("Bearer zzz");
  });

  it("sin env vars y PATH vacío (gh no encontrado) → sin header Authorization, ghPresentButTokenFailed() === false", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    // PATH vacío para que lookPath("gh") no encuentre nada
    vi.stubEnv("PATH", "");
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ tag_name: "v1.0.0" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await latestGithubRelease("owner/repo");

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBeUndefined();
    expect(ghPresentButTokenFailed()).toBe(false);
  });

  // La rama "gh auth token" real no se cubre con vi.mock porque githubToken() es
  // privada (solo observable por headers) y mockear lookPath/runDetectedBin
  // requeriría inyección de dependencias o vi.mock del módulo interno.
  // Documentado como deliberadamente no cubierto.
});

// ---------------------------------------------------------------------------
// downloadRepoTarball — reasons de fallo
// ---------------------------------------------------------------------------

describe("downloadRepoTarball: reasons de fallo", () => {
  it("403 → ok:false, reason contiene 'HTTP 403' y 'rate limit', githubRateLimited()===true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("HTTP 403");
      expect(result.reason).toContain("rate limit");
    }
    expect(githubRateLimited()).toBe(true);
    // destDir limpiado tras fallo
    expect(fs.existsSync(destDir)).toBe(false);
  });

  it("200 con body null → ok:false, reason 'respuesta HTTP sin cuerpo'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("respuesta HTTP sin cuerpo");
    }
  });

  it("fetch lanza TimeoutError → ok:false, reason 'timeout de descarga (120s)'", async () => {
    const timeoutErr = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr; }));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout de descarga (120s)");
    }
  });

  it("fetch lanza Error normal → ok:false, reason empieza por 'fallo de red:'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.startsWith("fallo de red:")).toBe(true);
    }
  });

  it("validateSubdir='../fuera' → ok:false, reason contiene 'escapa del destino'", async () => {
    // Necesitamos que fetch devuelva un tarball válido para llegar a la validación del subdir.
    // Creamos un tarball mínimo real.
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "file.txt"), "hola\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir, "../fuera");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("escapa del destino");
    }
  });

  it("validateSubdir='no-existe' → { ok:true, validated:false } (subdir ausente, sin crash)", async () => {
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "file.txt"), "hola\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir, "no-existe");

    expect(result).toEqual({ ok: true, validated: false });
  });
});

// ---------------------------------------------------------------------------
// downloadRepoTarball — happy path con tarball real
// ---------------------------------------------------------------------------

describe("downloadRepoTarball: happy path", () => {
  it("tarball válido → { ok:true, validated:true } y archivos extraídos presentes (strip-components)", async () => {
    // Crea el fixture: un tar.gz con directorio raíz "repo-abc123/" (simula el formato de GitHub)
    // --strip-components=1 eliminará ese prefijo al extraer, dejando solo el contenido.
    const rootDir = path.join(tmp, "src", "repo-abc123");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "README.md"), "# test\n");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export {};\n");
    const tarPath = path.join(tmp, "fixture.tar.gz");
    makeFixtureTarball(rootDir, tarPath, "repo-abc123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fs.readFileSync(tarPath), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "abc123", destDir);

    expect(result).toEqual({ ok: true, validated: true });
    // strip-components=1: los archivos deben estar directamente bajo destDir, sin el prefijo repo-abc123/
    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "index.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// downloadRepoTarball — e2e tarball malicioso (invariante de seguridad portable)
//
// Verifica que downloadRepoTarball → tar real → validateExtractedTree bloquea
// tarballs hostiles y nunca deja contenido peligroso fuera de destDir.
//
// Los fixtures se construyen en puro Node.js con buildTarGz() (sin dependencias
// externas y sin fs.symlinkSync, que requiere privilegios en Windows).
//
// Invariante portable (independiente del tar del sistema):
//   - ok:false  → destDir no existe o está vacío (fail-closed).
//   - ok:true   → todo el contenido de destDir está contenido en destDir y
//                 no hay symlinks (plataformas donde tar degrada la entrada).
//   En ningún caso existe contenido fuera de destDir.
// ---------------------------------------------------------------------------

/**
 * Comprueba que ningún archivo creado por la extracción escapó de destDir.
 * Verifica la carpeta del padre de destDir para detectar path-traversal.
 */
function assertNothingEscapedDestDir(destDir: string): void {
  const parent = path.dirname(destDir);
  const destName = path.basename(destDir);
  // Entramos en cada sibling del destDir en el mismo tmp-dir y aseguramos
  // que solo destDir (o su ausencia) existe.
  const siblings = fs.readdirSync(parent).filter((n) => n !== destName);
  // Nada de lo que exista en el padre debe ser "evil.txt" ni "evil"
  for (const s of siblings) {
    expect(s).not.toBe("evil.txt");
    expect(s).not.toBe("evil");
  }
}

/**
 * Si ok:true, verifica que el árbol de destDir no contiene symlinks
 * y que todo está contenido en destDir.
 */
function assertCleanTree(destDir: string): void {
  const resolved = path.resolve(destDir);
  for (const full of walkDir(destDir)) {
    // Verificar con lstat para detectar symlinks sin seguirlos
    const stat = fs.lstatSync(full);
    expect(stat.isSymbolicLink()).toBe(false);
    // Verificar que la ruta está contenida en destDir
    expect(path.resolve(full).startsWith(resolved)).toBe(true);
  }
}

describe("downloadRepoTarball: tarball malicioso — invariante de seguridad", () => {
  // Control positivo: el generador buildTarGz() produce tarballs benignos válidos.
  // Si este test falla, los tests de vectores maliciosos son inconfiables.
  it("control positivo: tarball benigno generado con buildTarGz() → { ok:true, validated:true }", async () => {
    const tarGzBuf = buildTarGz([
      { name: "repo-sha/", typeflag: "5" },
      { name: "repo-sha/README.md", typeflag: "0", content: Buffer.from("# ok\n") },
      { name: "repo-sha/src/", typeflag: "5" },
      { name: "repo-sha/src/index.ts", typeflag: "0", content: Buffer.from("export {};\n") },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(tarGzBuf), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "sha", destDir);

    expect(result).toEqual({ ok: true, validated: true });
    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src", "index.ts"))).toBe(true);
  });

  // Vector 1: path traversal — entrada con nombre "repo-sha/../evil.txt".
  // El tar puede rechazar el tarball completo (ok:false) o degradar la entrada
  // (neutralizarla dentro de destDir). En ningún caso evil.txt escapa a fuera.
  it("vector path-traversal: repo-sha/../evil.txt no escapa de destDir", async () => {
    const tarGzBuf = buildTarGz([
      { name: "repo-sha/", typeflag: "5" },
      // Entrada maliciosa: ruta que intenta escribir fuera del directorio raíz.
      { name: "repo-sha/../evil.txt", typeflag: "0", content: Buffer.from("malicious\n") },
      // Entrada legítima para que el tarball no sea trivialmente vacío.
      { name: "repo-sha/ok.md", typeflag: "0", content: Buffer.from("ok\n") },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(tarGzBuf), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "sha", destDir);

    // Invariante 1: nada escapa de destDir.
    assertNothingEscapedDestDir(destDir);

    if (result.ok) {
      // Plataformas que degradan la entrada: el árbol debe estar limpio.
      assertCleanTree(destDir);
    } else {
      // Fail-closed: destDir no existe o está vacío.
      const destExists = fs.existsSync(destDir);
      if (destExists) {
        const contents = fs.readdirSync(destDir);
        expect(contents).toHaveLength(0);
      }
    }
  });

  // Vector 2: symlink — entrada "repo-sha/link" apunta fuera con linkname "../../target".
  // bsdtar puede rechazarlo (ok:false) o extraerlo; si lo extrae, validateExtractedTree
  // detecta el symlink y falla (ok:false). En ambos casos: fail-closed.
  it("vector symlink: link con linkname ../../target no persiste en destDir", async () => {
    const tarGzBuf = buildTarGz([
      { name: "repo-sha/", typeflag: "5" },
      // Entrada maliciosa: symlink que apunta fuera del árbol.
      { name: "repo-sha/link", typeflag: "2", linkname: "../../target" },
      // Entrada legítima.
      { name: "repo-sha/ok.md", typeflag: "0", content: Buffer.from("ok\n") },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(tarGzBuf), { status: 200 })),
    );
    const destDir = path.join(tmp, "dest");
    fs.mkdirSync(destDir);

    const result = await downloadRepoTarball("owner/repo", "sha", destDir);

    // Invariante 1: nada escapa de destDir.
    assertNothingEscapedDestDir(destDir);

    if (result.ok) {
      // Si tar no rechazó, validateExtractedTree debería haber limpiado.
      // Árbol limpio: sin symlinks.
      assertCleanTree(destDir);
    } else {
      // Fail-closed: destDir no existe o está vacío.
      const destExists = fs.existsSync(destDir);
      if (destExists) {
        const contents = fs.readdirSync(destDir);
        expect(contents).toHaveLength(0);
      }
    }
  });
});
