#!/usr/bin/env python3
"""Maintainer-only generator for the frozen OpenCode static-resource index.

This script is NOT part of the Stack runtime and is never executed by
``install``/``sync``/``doctor``/``uninstall``. It resolves the exact published
artifact, verifies its integrity, and emits a deterministic JSON index that the
runtime bundles in ``dist`` and imports directly.

Guarantees enforced before writing anything:

* official registry metadata identity (package, version, ``gitHead``) matches
  the closed canon;
* the tarball Subresource Integrity matches the closed canon (SHA-512);
* downloaded payload and decompressed tree respect hard caps;
* every tar member has a safe relative path, regular type, and is unique;
* the selected source files are compared byte-exactly against the immutable Git
  commit before their digests are accepted;
* the emitted rows are sorted by target and carry no timestamps.

Usage:
    python3 scripts/regenerate-opencode-static-resources.py           # write
    python3 scripts/regenerate-opencode-static-resources.py --check    # verify
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import PurePosixPath

PACKAGE = "jorgex-stack"
VERSION = "1.9.67"
COMMIT = "6a54caf512125d53ef8c98e137710a4cf8c2a480"
SRI = "sha512-238nlRoeq/FZ0TUhWkp9d7xT4mYly6N2Z5kSXhx2tPIpv3oqo375LvpVp11N58SNPi42Kf7XuYMh72St45CwNg=="

REGISTRY_METADATA = f"https://registry.npmjs.org/{PACKAGE}/{VERSION}"
TARBALL_URL = f"https://registry.npmjs.org/{PACKAGE}/-/{PACKAGE}-{VERSION}.tgz"

MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024

# Projected static resources: canonical source path -> runtime target (relative
# to the OpenCode configDir). Exactly four rows are emitted.
PROJECTED = (
    ("stack/plugins/opencode/hooks.ts", "plugins/hooks.ts"),
    ("stack/plugins/opencode/worktree.ts", "plugins/worktree.ts"),
    ("stack/scripts/post-pr-review.cjs", "scripts/post-pr-review.cjs"),
    ("stack/scripts/repair-worktree-config.cjs", "scripts/repair-worktree-config.cjs"),
)
# Evidence-only: verified against Git but never emitted nor projected.
EVIDENCE = ("stack/plugins/opencode/package.json",)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(REPO_ROOT, "src", "lib", "opencode-static-resources.json")
TARBALL_PREFIX = "package/"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch_metadata() -> dict:
    try:
        with urllib.request.urlopen(REGISTRY_METADATA, timeout=30) as response:
            raw = response.read(MAX_METADATA_BYTES + 1)
    except OSError as error:
        fail(
            f"no se pudo resolver la metadata oficial ({error}); se requiere red explícita"
        )
    if len(raw) > MAX_METADATA_BYTES:
        fail(f"la metadata oficial excede el límite ({MAX_METADATA_BYTES} bytes)")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"la metadata oficial no es JSON interpretable ({error})")


def download_tarball() -> bytes:
    try:
        with urllib.request.urlopen(TARBALL_URL, timeout=60) as response:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    fail(
                        f"el tarball excede el límite de descarga ({MAX_DOWNLOAD_BYTES} bytes)"
                    )
                chunks.append(chunk)
            return b"".join(chunks)
    except OSError as error:
        fail(f"no se pudo descargar el tarball oficial ({error})")


def verify_sri(payload: bytes) -> None:
    algorithm, _, expected = SRI.partition("-")
    if algorithm != "sha512" or not expected:
        fail("SRI canónico no reconocido")
    digest = base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii")
    if digest != expected:
        fail("la integridad del tarball no coincide con el SRI canónico")


def _safe_member_path(name: str) -> str:
    if not name.startswith(TARBALL_PREFIX):
        fail(f"miembro fuera del prefijo esperado: {name}")
    relative = name[len(TARBALL_PREFIX) :]
    pure = PurePosixPath(relative)
    if (
        pure.is_absolute()
        or not relative
        or any(part in ("..", "") for part in pure.parts)
    ):
        fail(f"ruta insegura en el tarball: {name}")
    if "\\" in relative:
        fail(f"ruta con separadores inesperados: {name}")
    return relative


def _decompress_bounded(payload: bytes) -> bytes:
    """Descomprime con lectura acotada: nunca materializa el árbol completo antes
    del cap (defensa contra bombas de descompresión)."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload), mode="rb") as stream:
            raw = stream.read(MAX_DECOMPRESSED_BYTES + 1)
    except (OSError, EOFError) as error:
        fail(f"el tarball no es gzip válido ({error})")
    if len(raw) > MAX_DECOMPRESSED_BYTES:
        fail(
            f"el árbol descomprimido excede el límite ({MAX_DECOMPRESSED_BYTES} bytes)"
        )
    return raw


def extract_tree(payload: bytes) -> dict[str, bytes]:
    raw = _decompress_bounded(payload)

    files: dict[str, bytes] = {}
    seen: set[str] = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for member in archive.getmembers():
                if member.name in seen:
                    fail(f"miembro duplicado en el tarball: {member.name}")
                seen.add(member.name)
                relative = _safe_member_path(member.name)
                if member.isdir():
                    continue
                if not member.isreg():
                    fail(f"tipo de miembro no regular: {member.name}")
                extracted = archive.extractfile(member)
                if extracted is None:
                    fail(f"no se pudo leer el miembro: {member.name}")
                files[relative] = extracted.read()
    except tarfile.TarError as error:
        fail(f"tarball inválido ({error})")
    return files


def git_blob(source: str) -> bytes:
    try:
        result = subprocess.run(
            ["git", "cat-file", "blob", f"{COMMIT}:{source}"],
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        fail(f"no se pudo invocar git ({error})")
    if result.returncode != 0:
        fail(f"no se pudo leer el blob inmutable {COMMIT}:{source}")
    return result.stdout


def build_index() -> dict:
    metadata = fetch_metadata()
    if metadata.get("name") != PACKAGE or metadata.get("version") != VERSION:
        fail("la metadata oficial no coincide con el paquete/versión cerrados")
    if metadata.get("gitHead") != COMMIT:
        fail("el gitHead oficial no coincide con el commit inmutable cerrado")
    dist = metadata.get("dist")
    if not isinstance(dist, dict) or dist.get("integrity") != SRI:
        fail("el SRI de la metadata oficial no coincide con el canon")

    payload = download_tarball()
    verify_sri(payload)
    files = extract_tree(payload)

    for source in [path for path, _ in PROJECTED] + list(EVIDENCE):
        if source not in files:
            fail(f"falta el recurso en el tarball: {source}")
        if files[source] != git_blob(source):
            fail(
                f"el recurso del tarball no coincide byte a byte con {COMMIT}:{source}"
            )

    rows = [
        {
            "source": source,
            "target": target,
            "size": len(files[source]),
            "sha256": sha256_hex(files[source]),
        }
        for source, target in PROJECTED
    ]
    rows.sort(key=lambda row: row["target"])
    if len(rows) != 4:
        fail("el índice debe contener exactamente cuatro recursos")
    if len({row["target"] for row in rows}) != len(rows):
        fail("recursos duplicados en el índice")

    return {
        "provenance": {
            "package": PACKAGE,
            "version": VERSION,
            "commit": COMMIT,
            "sri": SRI,
        },
        "resources": rows,
    }


def serialize(index: dict) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="verify the on-disk index without writing"
    )
    args = parser.parse_args()

    expected = serialize(build_index())
    if args.check:
        try:
            with open(OUTPUT_PATH, "r", encoding="utf-8") as handle:
                current = handle.read()
        except OSError as error:
            fail(f"no se pudo leer el índice ({error})")
        if current != expected:
            print(
                "error: el índice en disco no coincide con el artefacto verificado",
                file=sys.stderr,
            )
            return 1
        print("ok: el índice coincide con el artefacto verificado")
        return 0

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        handle.write(expected)
    print(f"escrito {os.path.relpath(OUTPUT_PATH, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
