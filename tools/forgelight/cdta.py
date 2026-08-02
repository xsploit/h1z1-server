"""Strict reader for H1Z1 Forgelight ``CDTA`` collision meshes.

The game stores the authoritative static collision asset named by an ADR's
``<CollisionData fileName=...>`` element in this format.  This module only
decodes explicit triangle geometry; the trailing PhysX cooked payload is
validated and skipped because the H1Emu server and Recast need vertices and
indices, not a platform-specific PhysX blob.

Known, proven layouts:

* v1: common header, vertex count, float32 XYZ vertices, triangle count,
  uint16 triangle indices, cooked-payload byte count and payload.
* v2: common header, two opaque uint32 fields, followed by the same mesh.

Compound and alternate layouts deliberately fail closed until their byte
layout is covered by a corpus-backed parser.  Production extraction must
surface those failures; it must never substitute the ADR render ``<Base>``.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct
from typing import Final

import numpy as np


MAGIC: Final[bytes] = b"CDTA"
SUPPORTED_VERSIONS: Final[frozenset[int]] = frozenset((1, 2))
COMMON_HEADER_BYTES: Final[int] = 20
V2_OPAQUE_BYTES: Final[int] = 8


class CDTAError(ValueError):
    """The asset is malformed or violates a validated CDTA invariant."""


class UnsupportedCDTA(CDTAError):
    """The asset uses a real but not-yet-proven CDTA layout."""


@dataclass(frozen=True)
class CDTAMesh:
    positions: np.ndarray
    indices: np.ndarray
    cooked_payload_bytes: int


@dataclass(frozen=True)
class CDTA:
    version: int
    asset_hash: int
    shape_count: int
    reserved: int
    v2_opaque: tuple[int, int] | None
    meshes: tuple[CDTAMesh, ...]


def _read_u32(data: bytes, offset: int, source: str) -> tuple[int, int]:
    if offset + 4 > len(data):
        raise CDTAError(f"{source}: truncated uint32 at byte {offset}")
    return struct.unpack_from("<I", data, offset)[0], offset + 4


def _checked_span(
    data: bytes, offset: int, count: int, stride: int, label: str, source: str
) -> tuple[int, int]:
    if count < 0 or stride < 0:
        raise CDTAError(f"{source}: invalid {label} span")
    size = count * stride
    end = offset + size
    if end < offset or end > len(data):
        raise CDTAError(
            f"{source}: truncated {label} at byte {offset}: "
            f"need {size} bytes, have {len(data) - offset}"
        )
    return offset, end


def parse_cdta(data: bytes, source: str = "<bytes>") -> CDTA:
    """Decode one validated, explicit-triangle CDTA collision asset.

    Arrays use little-endian dtypes and deterministic source ordering.
    Returned arrays are read-only.  Unsupported compound/alternate layouts
    raise :class:`UnsupportedCDTA`; malformed data raises :class:`CDTAError`.
    """

    if len(data) < COMMON_HEADER_BYTES:
        raise CDTAError(
            f"{source}: truncated header: {len(data)} < {COMMON_HEADER_BYTES} bytes"
        )
    if data[:4] != MAGIC:
        raise CDTAError(f"{source}: bad magic {data[:4]!r}, expected {MAGIC!r}")

    version, asset_hash, shape_count, reserved = struct.unpack_from("<IIII", data, 4)
    if version not in SUPPORTED_VERSIONS:
        raise UnsupportedCDTA(f"{source}: unsupported CDTA version {version}")
    if shape_count != 1:
        raise UnsupportedCDTA(
            f"{source}: compound CDTA shapeCount={shape_count} is not decoded yet"
        )

    offset = COMMON_HEADER_BYTES
    v2_opaque: tuple[int, int] | None = None
    if version == 2:
        opaque_a, offset = _read_u32(data, offset, source)
        opaque_b, offset = _read_u32(data, offset, source)
        v2_opaque = (opaque_a, opaque_b)

    vertex_count, offset = _read_u32(data, offset, source)
    if vertex_count == 0:
        raise CDTAError(f"{source}: explicit collision mesh has zero vertices")
    vertex_offset, offset = _checked_span(
        data, offset, vertex_count, 12, "vertices", source
    )
    positions = np.frombuffer(
        data, dtype="<f4", count=vertex_count * 3, offset=vertex_offset
    ).reshape(vertex_count, 3)
    if not np.isfinite(positions).all():
        raise CDTAError(f"{source}: collision vertices contain NaN or infinity")

    triangle_count, offset = _read_u32(data, offset, source)
    if triangle_count == 0:
        raise CDTAError(f"{source}: explicit collision mesh has zero triangles")
    index_count = triangle_count * 3
    index_offset, offset = _checked_span(
        data, offset, index_count, 2, "uint16 triangle indices", source
    )
    indices_u16 = np.frombuffer(
        data, dtype="<u2", count=index_count, offset=index_offset
    )
    max_index = int(indices_u16.max(initial=0))
    if max_index >= vertex_count:
        raise CDTAError(
            f"{source}: triangle index {max_index} is outside {vertex_count} vertices"
        )
    indices = indices_u16.astype(np.uint32, copy=True)

    cooked_payload_bytes, offset = _read_u32(data, offset, source)
    _, offset = _checked_span(
        data,
        offset,
        cooked_payload_bytes,
        1,
        "cooked PhysX payload",
        source,
    )
    if offset != len(data):
        raise UnsupportedCDTA(
            f"{source}: alternate/trailing CDTA layout leaves "
            f"{len(data) - offset} unparsed bytes"
        )

    positions.setflags(write=False)
    indices.setflags(write=False)
    return CDTA(
        version=version,
        asset_hash=asset_hash,
        shape_count=shape_count,
        reserved=reserved,
        v2_opaque=v2_opaque,
        meshes=(
            CDTAMesh(
                positions=positions,
                indices=indices,
                cooked_payload_bytes=cooked_payload_bytes,
            ),
        ),
    )


def merge_meshes(cdta: CDTA) -> tuple[np.ndarray, np.ndarray]:
    """Merge decoded shapes without changing source triangle ordering."""

    if not cdta.meshes:
        raise CDTAError("CDTA contains no decoded meshes")
    positions: list[np.ndarray] = []
    indices: list[np.ndarray] = []
    base = 0
    for mesh in cdta.meshes:
        positions.append(mesh.positions)
        indices.append(mesh.indices + np.uint32(base))
        base += len(mesh.positions)
    merged_positions = np.concatenate(positions).astype(np.float32, copy=False)
    merged_indices = np.concatenate(indices).astype(np.uint32, copy=False)
    return merged_positions, merged_indices
