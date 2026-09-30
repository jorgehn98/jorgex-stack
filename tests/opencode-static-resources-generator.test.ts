import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import index from "../src/lib/opencode-static-resources.json" with { type: "json" };

/**
 * T07 followup: verificación OFFLINE del generador mantenedor
 * `scripts/regenerate-opencode-static-resources.py` y de la tabla congelada.
 *
 * - No hay red: `fetch_metadata`/`download_tarball`/`git_blob` se sustituyen por
 *   fixtures sintéticos en el namespace de TEST con `unittest.mock`; el SRI
 *   canónico se parchea SOLO en memoria del proceso Python para el archivo
 *   sintético (sin tocar el código ni el JSON de producción).
 * - No se ejecuta SDK/código v1 ni se instalan dependencias: `python3` stdlib.
 * - `--check` real ya fue ejecutado por el implementador; aquí se verifica la
 *   lógica determinista del productor y su rechazo de entradas malformadas.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "regenerate-opencode-static-resources.py");

function python3Available(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_PYTHON = python3Available();

// Tabla literal pre-verificada (paquete publicado 1.9.67, commit 6a54caf…),
// independiente del JSON: rows ordenadas por target, cuatro campos exactos.
const EXPECTED_RESOURCES = [
  {
    source: "stack/plugins/opencode/hooks.ts",
    target: "plugins/hooks.ts",
    size: 21967,
    sha256: "6d166b17b1fd102b0fbd96fea3c22195c03ac0a28e32e6fec5057ddfd0c27a23",
  },
  {
    source: "stack/plugins/opencode/worktree.ts",
    target: "plugins/worktree.ts",
    size: 29583,
    sha256: "6bbd4b8748ca1bf85c7d6740869b63746d7d4ec7e32a7cdec384a066034aca78",
  },
  {
    source: "stack/scripts/post-pr-review.cjs",
    target: "scripts/post-pr-review.cjs",
    size: 7374,
    sha256: "49785ccf30030f4651b5a2683bee3f9705e16984824ec125ab5011e0331bdefa",
  },
  {
    source: "stack/scripts/repair-worktree-config.cjs",
    target: "scripts/repair-worktree-config.cjs",
    size: 6146,
    sha256: "858ecf9abc98cd2e30cd6335622fe44adb9f6171e0ed4b40ff64f1bcc11a74fa",
  },
];

const EXPECTED_PROVENANCE = {
  package: "jorgex-stack",
  version: "1.9.67",
  commit: "6a54caf512125d53ef8c98e137710a4cf8c2a480",
  sri: "sha512-238nlRoeq/FZ0TUhWkp9d7xT4mYly6N2Z5kSXhx2tPIpv3oqo375LvpVp11N58SNPi42Kf7XuYMh72St45CwNg==",
};

interface GroupResult {
  group: string;
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

function runGroup(group: string): GroupResult {
  const stdout = execFileSync("python3", ["-c", PY, SCRIPT, group], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR !== undefined && process.env.TMPDIR !== "" ? process.env.TMPDIR : os.tmpdir(),
      LANG: "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .at(-1);
  if (line === undefined) throw new Error(`python3 ${group}: sin salida JSON`);
  return JSON.parse(line) as GroupResult;
}

function expectAll(result: GroupResult): void {
  const failed = result.checks.filter((check) => !check.ok);
  expect(failed, `checks fallidos (${result.group}): ${JSON.stringify(failed)}`).toEqual([]);
  expect(result.ok, `grupo ${result.group} no verificó`).toBe(true);
}

describe("[T07-delta] índice congelado de recursos estáticos", () => {
  it("coincide con la tabla literal verificada, excluye package.json y ordena por target", () => {
    const data = index as { provenance: typeof EXPECTED_PROVENANCE; resources: typeof EXPECTED_RESOURCES };
    expect(data.provenance).toEqual(EXPECTED_PROVENANCE);
    expect(data.resources).toEqual(EXPECTED_RESOURCES);
    expect(data.resources.map((row) => row.target)).toEqual([...EXPECTED_RESOURCES.map((row) => row.target)].sort());
    expect(data.resources.map((row) => row.source)).not.toContain("stack/plugins/opencode/package.json");
    for (const row of data.resources) {
      expect(Object.keys(row).sort()).toEqual(["sha256", "size", "source", "target"]);
    }
  });
});

describe.skipIf(!HAS_PYTHON)("[T07-delta] generador de recursos estáticos (offline, python3 stdlib)", () => {
  it("build determinista: 4 targets exactos, package.json como evidencia no proyectada, git-byte incorrecto rechazado", () => {
    expectAll(runGroup("build"));
  });

  it("safety: rutas inseguras, miembros duplicados y enlaces no regulares rechazados; árbol válido extrae", () => {
    expectAll(runGroup("safety"));
  });

  it("cap: el límite de descompresión bloquea antes de descomprimir sin gzip.decompress sin cota", () => {
    expectAll(runGroup("cap"));
  });

  it("integrity: SRI real rechaza payload erróneo y --check con build fallido no escribe", () => {
    expectAll(runGroup("integrity"));
  });
});

// Programa Python embebido: importa el generador por ruta y ejecuta un grupo de
// comprobaciones con stubs offline, emitiendo un JSON. String.raw conserva los
// backslashes del caso de ruta insegura.
const PY = String.raw`
import base64, contextlib, gzip, hashlib, importlib.util, io, json, os, sys, tarfile, traceback
from unittest import mock

SCRIPT, GROUP = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("opencode_gen", SCRIPT)
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

checks = []
def check(name, cond, detail=""):
    checks.append({"name": name, "ok": bool(cond), "detail": str(detail)[:500]})

def system_exits(fn):
    try:
        fn()
        return False, "no SystemExit"
    except SystemExit as exc:
        return True, "SystemExit(%s)" % (getattr(exc, "code", None),)
    except BaseException as exc:
        return False, "%s: %s" % (type(exc).__name__, exc)

def tar_bytes(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "file":
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = "package/other"
                tar.addfile(info)
            else:
                info.type = tarfile.LNKTYPE
                info.linkname = "package/other"
                tar.addfile(info)
    return gzip.compress(buf.getvalue())

def sources():
    return [s for s, _ in gen.PROJECTED] + list(gen.EVIDENCE)

def package_data():
    return {s: ("canonical-bytes:" + s).encode("utf-8") for s in sources()}

def package_tar(data, omit=()):
    return tar_bytes([("package/" + s, data[s], "file") for s in sources() if s not in omit])

def sri_of(payload):
    return "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii")

def metadata(sri):
    return {"name": gen.PACKAGE, "version": gen.VERSION, "gitHead": gen.COMMIT, "dist": {"integrity": sri}}

def patch_env(payload, data, integrity, git_blob):
    return [
        mock.patch.object(gen, "SRI", integrity),
        mock.patch.object(gen, "fetch_metadata", lambda: metadata(integrity)),
        mock.patch.object(gen, "download_tarball", lambda: payload),
        mock.patch.object(gen, "git_blob", git_blob),
    ]

def run_group():
    if GROUP == "build":
        data = package_data()
        payload = package_tar(data)
        integrity = sri_of(payload)
        with contextlib.ExitStack() as stack:
            for patcher in patch_env(payload, data, integrity, lambda s: data[s]):
                stack.enter_context(patcher)
            first = gen.build_index()
            second = gen.build_index()
            text = gen.serialize(first)
            text2 = gen.serialize(second)
        rows = first["resources"]
        targets = [row["target"] for row in rows]
        check("dict_deterministic", first == second)
        check("serialize_deterministic", text == text2)
        check("exactly_four", len(rows) == 4, targets)
        check("sorted_by_target", targets == sorted(targets), targets)
        check("exact_targets", set(targets) == set(t for _, t in gen.PROJECTED), targets)
        check("package_json_not_projected", all(row["source"] not in gen.EVIDENCE for row in rows))
        check("row_shape", all(sorted(row.keys()) == ["sha256", "size", "source", "target"] for row in rows))
        check("no_timestamp_keys", all(key not in text.lower() for key in ("timestamp", "generatedat", "\"date\"")))
        check("provenance", first["provenance"] == {"package": gen.PACKAGE, "version": gen.VERSION, "commit": gen.COMMIT, "sri": integrity})
        check("sizes_match_payload", all(row["size"] == len(data[row["source"]]) for row in rows))
        tampered = lambda s: (b"tampered" if s == gen.PROJECTED[0][0] else data[s])
        with contextlib.ExitStack() as stack:
            for patcher in patch_env(payload, data, integrity, tampered):
                stack.enter_context(patcher)
            ok, detail = system_exits(gen.build_index)
        check("git_byte_mismatch_rejected", ok, detail)
        omitted = package_tar(data, omit=(gen.EVIDENCE[0],))
        with contextlib.ExitStack() as stack:
            for patcher in patch_env(omitted, data, sri_of(omitted), lambda s: data[s]):
                stack.enter_context(patcher)
            ok, detail = system_exits(gen.build_index)
        check("evidence_required", ok, detail)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(gen, "SRI", integrity))
            stack.enter_context(mock.patch.object(gen, "fetch_metadata", lambda: metadata("sha512-AAAA")))
            stack.enter_context(mock.patch.object(gen, "download_tarball", lambda: payload))
            stack.enter_context(mock.patch.object(gen, "git_blob", lambda s: data[s]))
            ok, detail = system_exits(gen.build_index)
        check("metadata_sri_mismatch_rejected", ok, detail)
    elif GROUP == "safety":
        for bad in ("../evil", "/etc/passwd", "other/x", "package/a\\b"):
            ok, detail = system_exits(lambda value=bad: gen._safe_member_path(value))
            check("unsafe_path:" + bad, ok, detail)
        dup = tar_bytes([("package/x.txt", b"one", "file"), ("package/x.txt", b"two", "file")])
        ok, detail = system_exits(lambda: gen.extract_tree(dup))
        check("duplicate_member_rejected", ok, detail)
        link = tar_bytes([("package/link", b"", "symlink")])
        ok, detail = system_exits(lambda: gen.extract_tree(link))
        check("symlink_member_rejected", ok, detail)
        hard = tar_bytes([("package/hard", b"", "hardlink")])
        ok, detail = system_exits(lambda: gen.extract_tree(hard))
        check("hardlink_member_rejected", ok, detail)
        good = package_tar(package_data())
        files = gen.extract_tree(good)
        check("valid_tree_extracts", gen.PROJECTED[0][0] in files)
    elif GROUP == "cap":
        payload = gzip.compress(b"\x00" * 4096)
        bomb = mock.Mock(side_effect=AssertionError("unbounded gzip.decompress used"))
        with mock.patch.object(gen, "MAX_DECOMPRESSED_BYTES", 128), mock.patch.object(gen.gzip, "decompress", bomb):
            ok, detail = system_exits(lambda: gen.extract_tree(payload))
        check("decompressed_cap_blocks", ok, detail)
        check("gzip_decompress_not_called", bomb.call_count == 0, "calls=%d" % bomb.call_count)
    elif GROUP == "integrity":
        ok, detail = system_exits(lambda: gen.verify_sri(b"not-the-published-tarball"))
        check("real_sri_wrong_payload_rejected", ok, detail)
        payload_ok = b"known-good-payload"
        try:
            with mock.patch.object(gen, "SRI", sri_of(payload_ok)):
                gen.verify_sri(payload_ok)
            passed = True
        except BaseException:
            passed = False
        check("sri_valid_payload_passes", passed)
        sentinel = os.path.join(os.environ.get("TMPDIR") or "/tmp", "jx-gen-check-%d.json" % os.getpid())
        with open(sentinel, "w", encoding="utf-8") as handle:
            handle.write("SENTINEL\n")
        with mock.patch.object(gen, "OUTPUT_PATH", sentinel), mock.patch.object(gen, "build_index", mock.Mock(side_effect=SystemExit(1))), mock.patch.object(sys, "argv", ["generator", "--check"]):
            ok, detail = system_exits(gen.main)
        with open(sentinel, "r", encoding="utf-8") as handle:
            preserved = handle.read()
        os.remove(sentinel)
        check("check_failed_build_preserves_output", ok and preserved == "SENTINEL\n", detail)

try:
    run_group()
except BaseException as exc:
    checks.append({"name": "harness", "ok": False, "detail": "%s: %s\n%s" % (type(exc).__name__, exc, traceback.format_exc()[:800])})

print(json.dumps({"group": GROUP, "ok": all(item["ok"] for item in checks), "checks": checks}))
`;
