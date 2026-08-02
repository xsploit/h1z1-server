"""Strict reader for H1Z1 Forgelight ``CDTA`` collision meshes.

The game stores the authoritative static collision asset named by an ADR's
``<CollisionData fileName=...>`` element in this format.  This module only
decodes explicit triangle geometry; each PhysX cooked payload is validated and
skipped because the H1Emu server and Recast need vertices and indices, not a
platform-specific PhysX blob.

Corpus-proven layout (2,411 H1Z1 CDTA assets):

* 16-byte file header: magic, version, collision type, shape count.
* v1 shape: one opaque uint32 followed by the explicit mesh.
* v2 shape: three opaque uint32 values followed by the explicit mesh.
* mesh: vertex count, float32 XYZ vertices, triangle count, uint16 triangle
  indices, cooked-payload byte count, and cooked payload.

All shapes are decoded in source order and the final shape must end exactly at
EOF.  Alternate/trailing and incomplete high-vertex layouts deliberately fail
closed; production extraction must never substitute the ADR render ``<Base>``
or silently return partial collision geometry.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct
from typing import Final

import numpy as np


MAGIC: Final[bytes] = b"CDTA"
SUPPORTED_VERSIONS: Final[frozenset[int]] = frozenset((1, 2))
FILE_HEADER_BYTES: Final[int] = 16
SHAPE_METADATA_WORDS: Final[dict[int, int]] = {1: 1, 2: 3}
UINT16_VERTEX_LIMIT: Final[int] = 1 << 16
COOKED_MESH_SIGNATURE: Final[bytes] = b"NXS\x01MESH"


class CDTAError(ValueError):
    """The asset is malformed or violates a validated CDTA invariant."""


class UnsupportedCDTA(CDTAError):
    """The asset uses a real but not-safely-decodable CDTA layout."""


@dataclass(frozen=True)
class CDTAMesh:
    shape_metadata: tuple[int, ...]
    positions: np.ndarray
    indices: np.ndarray
    cooked_payload_bytes: int


@dataclass(frozen=True)
class CDTA:
    version: int
    collision_type: int
    shape_count: int
    meshes: tuple[CDTAMesh, ...]


def _read_u32(data: bytes, offset: int, source: str) -> tuple[int, int]:
    if offset + 4 > len(data):
        raise CDTAError(f"{source}: truncated uint32 at byte {offset}")
    return struct.unpack_from("<I", data, offset)[0], offset + 4


def _read_u32_tuple(
    data: bytes, offset: int, count: int, label: str, source: str
) -> tuple[tuple[int, ...], int]:
    start, end = _checked_span(data, offset, count, 4, label, source)
    return struct.unpack_from(f"<{count}I", data, start), end


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


def _cooked_payload_anchor(
    data: bytes, index_offset: int
) -> tuple[int, int] | None:
    """Find one unambiguous payload-size word whose NXS blob reaches EOF.

    This is diagnostic only.  The normal grammar never searches for magic
    inside payloads; it follows declared lengths.  The five known >65535-vertex
    files have an incomplete uint16 index stream followed by exactly one such
    cooked-mesh anchor, which lets the rejection explain the proven failure
    instead of misreading payload bytes as indices.
    """

    anchors: list[tuple[int, int]] = []
    cursor = 0
    while True:
        signature_offset = data.find(COOKED_MESH_SIGNATURE, cursor)
        if signature_offset < 0:
            break
        size_offset = signature_offset - 4
        if size_offset >= index_offset:
            payload_bytes = struct.unpack_from("<I", data, size_offset)[0]
            if signature_offset + payload_bytes == len(data):
                anchors.append((size_offset, payload_bytes))
        cursor = signature_offset + 1
    return anchors[0] if len(anchors) == 1 else None


def _reject_unsupported_high_vertex_mesh(
    data: bytes,
    index_offset: int,
    vertex_count: int,
    triangle_count: int,
    shape_count: int,
    source: str,
) -> None:
    if shape_count == 1:
        anchor = _cooked_payload_anchor(data, index_offset)
        if anchor is not None:
            payload_size_offset, _ = anchor
            serialized_index_bytes = payload_size_offset - index_offset
            if serialized_index_bytes >= 0 and serialized_index_bytes % 6 == 0:
                serialized_triangles = serialized_index_bytes // 6
                if serialized_triangles < triangle_count:
                    raise UnsupportedCDTA(
                        f"{source}: incomplete uint16 index stream for "
                        f"vertexCount={vertex_count}: declared {triangle_count} "
                        f"triangles but serialized {serialized_triangles} before "
                        f"cooked payload at byte {payload_size_offset}"
                    )
    raise UnsupportedCDTA(
        f"{source}: vertexCount={vertex_count} exceeds the proven uint16 "
        f"index domain ({UINT16_VERTEX_LIMIT} vertices)"
    )


def parse_cdta(data: bytes, source: str = "<bytes>") -> CDTA:
    """Decode one validated, explicit-triangle CDTA collision asset.

    Arrays use little-endian dtypes and deterministic source ordering.
    Returned arrays are read-only.  Unsupported alternate/incomplete layouts
    raise :class:`UnsupportedCDTA`; malformed data raises :class:`CDTAError`.
    """

    if len(data) < FILE_HEADER_BYTES:
        raise CDTAError(
            f"{source}: truncated header: {len(data)} < {FILE_HEADER_BYTES} bytes"
        )
    if data[:4] != MAGIC:
        raise CDTAError(f"{source}: bad magic {data[:4]!r}, expected {MAGIC!r}")

    version, collision_type, shape_count = struct.unpack_from("<III", data, 4)
    if version not in SUPPORTED_VERSIONS:
        raise UnsupportedCDTA(f"{source}: unsupported CDTA version {version}")
    if shape_count == 0:
        raise CDTAError(f"{source}: CDTA contains zero shapes")

    offset = FILE_HEADER_BYTES
    meshes: list[CDTAMesh] = []
    for shape_index in range(shape_count):
        shape_metadata, offset = _read_u32_tuple(
            data,
            offset,
            SHAPE_METADATA_WORDS[version],
            f"shape {shape_index} metadata",
            source,
        )

        vertex_count, offset = _read_u32(data, offset, source)
        if vertex_count == 0:
            raise CDTAError(
                f"{source}: shape {shape_index} explicit collision mesh has "
                "zero vertices"
            )
        vertex_offset, offset = _checked_span(
            data,
            offset,
            vertex_count,
            12,
            f"shape {shape_index} vertices",
            source,
        )
        positions = np.frombuffer(
            data, dtype="<f4", count=vertex_count * 3, offset=vertex_offset
        ).reshape(vertex_count, 3)
        if not np.isfinite(positions).all():
            raise CDTAError(
                f"{source}: shape {shape_index} collision vertices contain "
                "NaN or infinity"
            )

        triangle_count, offset = _read_u32(data, offset, source)
        if triangle_count == 0:
            raise CDTAError(
                f"{source}: shape {shape_index} explicit collision mesh has "
                "zero triangles"
            )
        index_count = triangle_count * 3
        if vertex_count > UINT16_VERTEX_LIMIT:
            _reject_unsupported_high_vertex_mesh(
                data,
                offset,
                vertex_count,
                triangle_count,
                shape_count,
                source,
            )
        index_offset, offset = _checked_span(
            data,
            offset,
            index_count,
            2,
            f"shape {shape_index} uint16 triangle indices",
            source,
        )
        indices_u16 = np.frombuffer(
            data, dtype="<u2", count=index_count, offset=index_offset
        )
        max_index = int(indices_u16.max(initial=0))
        if max_index >= vertex_count:
            raise CDTAError(
                f"{source}: shape {shape_index} triangle index {max_index} is "
                f"outside {vertex_count} vertices"
            )
        indices = indices_u16.astype(np.uint32, copy=True)

        cooked_payload_bytes, offset = _read_u32(data, offset, source)
        _, offset = _checked_span(
            data,
            offset,
            cooked_payload_bytes,
            1,
            f"shape {shape_index} cooked PhysX payload",
            source,
        )

        positions.setflags(write=False)
        indices.setflags(write=False)
        meshes.append(
            CDTAMesh(
                shape_metadata=shape_metadata,
                positions=positions,
                indices=indices,
                cooked_payload_bytes=cooked_payload_bytes,
            )
        )

    if offset != len(data):
        raise UnsupportedCDTA(
            f"{source}: alternate/trailing CDTA layout leaves "
            f"{len(data) - offset} unparsed bytes at byte {offset}"
        )

    return CDTA(
        version=version,
        collision_type=collision_type,
        shape_count=shape_count,
        meshes=tuple(meshes),
    )


def merge_meshes(cdta: CDTA) -> tuple[np.ndarray, np.ndarray]:
    """Merge decoded shapes without changing source shape/triangle ordering."""

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
