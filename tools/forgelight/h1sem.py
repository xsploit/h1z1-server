"""H1SEM1 v1 per-triangle navigation semantic sidecar codec.

H1SEM1 binds build-time navigation semantics to one exact H1COL2 collision
artifact without changing the runtime H1COL2 format.  Values are deliberately
kept independent from Recast's internal ``RC_WALKABLE_AREA`` marker:

    0  INVALID (never accepted in triangle data)
    1  TERRAIN
    2  ROAD
    3  FLOOR_EXTERIOR
    4  FLOOR_INTERIOR
    5  STAIR
    6  RAMP
    7  THRESHOLD
    8  OBSTACLE_STATIC
    9  DOOR_PANEL_DYNAMIC
    10 EXCLUDE
    11 UNKNOWN

The 64-byte little-endian header is followed by ``meshCount + 1`` uint32
prefix offsets and then one uint8 semantic ID per collision triangle.  Empty
meshes are representable because offsets are monotonic, not strictly
increasing.  Production validation additionally rejects TERRAIN (terrain is a
separate heightmap source) and UNKNOWN (classification must fail closed).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import struct
from typing import Sequence


MAGIC = b"H1SEM1\0\0"
VERSION = 1
HEADER_BYTES = 64
SEMANTIC_SCHEMA_VERSION = 1
MAX_U32 = 0xFFFFFFFF

_HEADER = struct.Struct("<8s6I32s")
_OFFSET = struct.Struct("<I")


class H1SEM1Error(ValueError):
    """Raised when an H1SEM1 artifact violates the v1 contract."""


class SemanticId(IntEnum):
    """Stable H1SEM1 semantic IDs; zero is a sentinel, not triangle data."""

    INVALID = 0
    TERRAIN = 1
    ROAD = 2
    FLOOR_EXTERIOR = 3
    FLOOR_INTERIOR = 4
    STAIR = 5
    RAMP = 6
    THRESHOLD = 7
    OBSTACLE_STATIC = 8
    DOOR_PANEL_DYNAMIC = 9
    EXCLUDE = 10
    UNKNOWN = 11


_VALID_TRIANGLE_IDS = frozenset(range(SemanticId.TERRAIN, SemanticId.UNKNOWN + 1))
_PRODUCTION_FORBIDDEN_IDS = frozenset(
    (SemanticId.TERRAIN, SemanticId.UNKNOWN)
)


@dataclass(frozen=True)
class H1SEM1Document:
    """Validated decoded H1SEM1 data."""

    h1col2_sha256: bytes
    mesh_offsets: tuple[int, ...]
    semantic_ids: bytes

    @property
    def mesh_count(self) -> int:
        return len(self.mesh_offsets) - 1

    @property
    def total_triangle_count(self) -> int:
        return len(self.semantic_ids)

    @property
    def mesh_triangle_counts(self) -> tuple[int, ...]:
        return tuple(
            end - start
            for start, end in zip(self.mesh_offsets, self.mesh_offsets[1:])
        )

    def semantics_for_mesh(self, mesh_index: int) -> bytes:
        if mesh_index < 0 or mesh_index >= self.mesh_count:
            raise IndexError(f"mesh index {mesh_index} outside {self.mesh_count} meshes")
        start = self.mesh_offsets[mesh_index]
        end = self.mesh_offsets[mesh_index + 1]
        return self.semantic_ids[start:end]


def _validate_digest(digest: bytes | bytearray | memoryview, label: str) -> bytes:
    if not isinstance(digest, (bytes, bytearray, memoryview)):
        raise H1SEM1Error(f"{label} must be raw 32-byte SHA256 data")
    raw = bytes(digest)
    if len(raw) != 32:
        raise H1SEM1Error(
            f"{label} must be raw 32-byte SHA256 data, got {len(raw)} bytes"
        )
    return raw


def _validate_u32(value: int, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise H1SEM1Error(f"{label} must be an integer")
    if value < 0 or value > MAX_U32:
        raise H1SEM1Error(f"{label} must fit uint32, got {value}")
    return value


def _validate_semantic_ids(
    semantic_ids: bytes, *, strict_production: bool
) -> None:
    for triangle_index, semantic_id in enumerate(semantic_ids):
        if semantic_id not in _VALID_TRIANGLE_IDS:
            raise H1SEM1Error(
                f"invalid semantic id {semantic_id} at triangle {triangle_index}"
            )
        if strict_production and semantic_id in _PRODUCTION_FORBIDDEN_IDS:
            name = SemanticId(semantic_id).name.lower()
            raise H1SEM1Error(
                f"production H1SEM1 cannot contain {name} semantic id "
                f"at triangle {triangle_index}"
            )


def _validate_expected_counts(
    expected: Sequence[int] | None,
    actual: Sequence[int],
) -> None:
    if expected is None:
        return
    expected_counts = tuple(
        _validate_u32(count, f"mesh triangle count {index}")
        for index, count in enumerate(expected)
    )
    if len(expected_counts) != len(actual):
        raise H1SEM1Error(
            "mesh triangle count cardinality mismatch: "
            f"expected {len(expected_counts)} meshes, artifact has {len(actual)}"
        )
    for mesh_index, (expected_count, actual_count) in enumerate(
        zip(expected_counts, actual)
    ):
        if expected_count != actual_count:
            raise H1SEM1Error(
                f"mesh {mesh_index} triangle count mismatch: "
                f"expected {expected_count}, artifact has {actual_count}"
            )


def encode_h1sem1(
    h1col2_sha256: bytes | bytearray | memoryview,
    mesh_semantics: Sequence[Sequence[int] | bytes | bytearray | memoryview],
    *,
    mesh_triangle_counts: Sequence[int] | None = None,
    strict_production: bool = False,
) -> bytes:
    """Encode a deterministic H1SEM1 v1 artifact.

    ``mesh_triangle_counts`` should be supplied by the H1COL2 producer when
    available.  It makes the sidecar-to-mesh cardinality check explicit rather
    than relying only on the lengths of ``mesh_semantics``.
    """

    digest = _validate_digest(h1col2_sha256, "H1COL2 SHA256")
    try:
        mesh_count = len(mesh_semantics)
    except TypeError as error:
        raise H1SEM1Error("mesh semantics must be a sized sequence") from error
    _validate_u32(mesh_count, "mesh count")

    offsets = [0]
    flattened = bytearray()
    for mesh_index, values in enumerate(mesh_semantics):
        try:
            semantic_bytes = bytes(values)
        except (TypeError, ValueError) as error:
            raise H1SEM1Error(
                f"mesh {mesh_index} semantics must contain uint8 values"
            ) from error
        _validate_semantic_ids(
            semantic_bytes, strict_production=strict_production
        )
        next_offset = len(flattened) + len(semantic_bytes)
        _validate_u32(next_offset, "total triangle count")
        flattened.extend(semantic_bytes)
        offsets.append(next_offset)

    actual_counts = tuple(
        end - start for start, end in zip(offsets, offsets[1:])
    )
    _validate_expected_counts(mesh_triangle_counts, actual_counts)

    header = _HEADER.pack(
        MAGIC,
        VERSION,
        HEADER_BYTES,
        SEMANTIC_SCHEMA_VERSION,
        mesh_count,
        len(flattened),
        0,
        digest,
    )
    encoded_offsets = b"".join(_OFFSET.pack(offset) for offset in offsets)
    return header + encoded_offsets + bytes(flattened)


def decode_h1sem1(
    data: bytes | bytearray | memoryview,
    *,
    expected_h1col2_sha256: bytes | bytearray | memoryview | None = None,
    expected_mesh_triangle_counts: Sequence[int] | None = None,
    strict_production: bool = False,
) -> H1SEM1Document:
    """Decode and fully validate one H1SEM1 v1 artifact."""

    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise H1SEM1Error("H1SEM1 data must be bytes-like")
    raw = bytes(data)
    if len(raw) < HEADER_BYTES:
        raise H1SEM1Error(
            f"truncated H1SEM1 header: expected {HEADER_BYTES} bytes, got {len(raw)}"
        )

    (
        magic,
        version,
        header_bytes,
        schema_version,
        mesh_count,
        total_triangle_count,
        reserved,
        digest,
    ) = _HEADER.unpack_from(raw)

    if magic != MAGIC:
        raise H1SEM1Error(f"invalid H1SEM1 magic {magic!r}")
    if version != VERSION:
        raise H1SEM1Error(f"unsupported H1SEM1 version {version}")
    if header_bytes != HEADER_BYTES:
        raise H1SEM1Error(
            f"invalid H1SEM1 header size {header_bytes}, expected {HEADER_BYTES}"
        )
    if schema_version != SEMANTIC_SCHEMA_VERSION:
        raise H1SEM1Error(
            "unsupported H1SEM1 semantic schema version "
            f"{schema_version}"
        )
    if reserved != 0:
        raise H1SEM1Error(f"H1SEM1 reserved field must be zero, got {reserved}")

    offset_count = mesh_count + 1
    expected_length = HEADER_BYTES + offset_count * _OFFSET.size + total_triangle_count
    if len(raw) < expected_length:
        raise H1SEM1Error(
            f"truncated H1SEM1 artifact: expected {expected_length} bytes, "
            f"got {len(raw)}"
        )
    if len(raw) > expected_length:
        raise H1SEM1Error(
            f"trailing H1SEM1 data: expected {expected_length} bytes, "
            f"got {len(raw)}"
        )

    offsets_start = HEADER_BYTES
    offsets = tuple(
        _OFFSET.unpack_from(raw, offsets_start + index * _OFFSET.size)[0]
        for index in range(offset_count)
    )
    if offsets[0] != 0:
        raise H1SEM1Error(f"first mesh offset must be zero, got {offsets[0]}")
    for mesh_index, (start, end) in enumerate(zip(offsets, offsets[1:])):
        if end < start:
            raise H1SEM1Error(
                f"mesh offsets are not monotonic at mesh {mesh_index}: "
                f"{start} then {end}"
            )
    if offsets[-1] != total_triangle_count:
        raise H1SEM1Error(
            f"final mesh offset {offsets[-1]} does not equal total triangle "
            f"count {total_triangle_count}"
        )

    semantics_start = offsets_start + offset_count * _OFFSET.size
    semantic_ids = raw[semantics_start:]
    _validate_semantic_ids(
        semantic_ids, strict_production=strict_production
    )

    actual_counts = tuple(
        end - start for start, end in zip(offsets, offsets[1:])
    )
    _validate_expected_counts(expected_mesh_triangle_counts, actual_counts)

    if expected_h1col2_sha256 is not None:
        expected_digest = _validate_digest(
            expected_h1col2_sha256, "expected H1COL2 SHA256"
        )
        if digest != expected_digest:
            raise H1SEM1Error(
                "H1COL2 SHA256 mismatch: "
                f"artifact={digest.hex()} expected={expected_digest.hex()}"
            )

    return H1SEM1Document(
        h1col2_sha256=digest,
        mesh_offsets=offsets,
        semantic_ids=semantic_ids,
    )
