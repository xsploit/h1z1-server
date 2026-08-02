"""Fail-closed publication for hash-bound ForgeLight artifact bundles.

All payloads are fully written and fsynced to sibling temporary files before
any final path changes. Payload files are replaced in caller order and metadata
is replaced last as the readiness marker. A process failure during replacement
can leave mixed payload versions, but the old metadata then cannot match their
hashes, so strict consumers reject the bundle instead of trusting it.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
import os
from pathlib import Path, PurePath
import tempfile


class ArtifactBundleError(ValueError):
    """Raised when an artifact publication request violates the contract."""


Replace = Callable[[str | bytes | os.PathLike[str] | os.PathLike[bytes],
                    str | bytes | os.PathLike[str] | os.PathLike[bytes]], None]


def _validated_name(name: str, label: str) -> str:
    if not isinstance(name, str) or not name:
        raise ArtifactBundleError(f"{label} must be a non-empty basename")
    path = PurePath(name)
    if path.is_absolute() or path.name != name or name in (".", ".."):
        raise ArtifactBundleError(f"{label} must be a basename, got {name!r}")
    if "/" in name or "\\" in name:
        raise ArtifactBundleError(f"{label} must not contain path separators")
    return name


def _validated_bytes(value: bytes | bytearray | memoryview, label: str) -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise ArtifactBundleError(f"{label} must be bytes-like")
    return bytes(value)


def _write_sibling_temp(directory: Path, final_name: str, data: bytes) -> Path:
    descriptor, temporary = tempfile.mkstemp(
        dir=directory,
        prefix=f".{final_name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    return temporary_path


def _fsync_directory(directory: Path) -> None:
    """Best-effort directory durability where the platform permits it."""

    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_artifact_bundle(
    directory: str | os.PathLike[str],
    artifacts: Mapping[str, bytes | bytearray | memoryview],
    metadata_name: str,
    metadata_bytes: bytes | bytearray | memoryview,
    *,
    replace: Replace = os.replace,
) -> tuple[Path, ...]:
    """Publish one same-directory bundle, with metadata replaced last.

    Mapping iteration order defines payload replacement order. The caller must
    build and validate metadata against the exact supplied payload bytes before
    calling this function.
    """

    root = Path(directory)
    if not root.exists() or not root.is_dir():
        raise ArtifactBundleError(f"bundle directory does not exist: {root}")

    metadata = _validated_name(metadata_name, "metadata name")
    if not artifacts:
        raise ArtifactBundleError("artifact bundle must contain payload files")

    normalized: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for raw_name, raw_bytes in artifacts.items():
        name = _validated_name(raw_name, "artifact name")
        folded = name.casefold()
        if folded in seen:
            raise ArtifactBundleError(f"duplicate artifact name {name!r}")
        if folded == metadata.casefold():
            raise ArtifactBundleError("metadata must not also be a payload file")
        seen.add(folded)
        normalized.append((name, _validated_bytes(raw_bytes, name)))
    metadata_data = _validated_bytes(metadata_bytes, metadata)

    staged: list[tuple[Path, Path]] = []
    try:
        for name, data in normalized:
            staged.append(
                (_write_sibling_temp(root, name, data), root / name)
            )
        metadata_temp = _write_sibling_temp(root, metadata, metadata_data)
        staged.append((metadata_temp, root / metadata))

        destinations: list[Path] = []
        for temporary, destination in staged:
            replace(temporary, destination)
            destinations.append(destination)
        _fsync_directory(root)
        return tuple(destinations)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
