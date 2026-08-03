"""Rebuild an H1SEM1 sidecar from an existing H1COL2 and exact metadata.

This avoids re-extracting the game packs when only the reviewed semantic policy
changes.  Geometry and actor/hash bindings are still verified mesh by mesh.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

from collision_semantic_policy import classify_mesh_triangles, load_semantic_policy
from h1sem import encode_h1sem1


def read_h1col2(path: Path):
    raw = path.read_bytes()
    if raw[:8] != b"H1COL2\0\0":
        raise RuntimeError("invalid H1COL2 magic")
    version, mesh_count, _instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise RuntimeError(f"unsupported H1COL2 version {version}")
    offset = 20
    meshes = []
    for mesh_index in range(mesh_count):
        kind, vertex_count, index_count = struct.unpack_from("<BII", raw, offset)
        offset += 9
        positions_size = vertex_count * 12
        indices_size = index_count * 4
        end = offset + positions_size + indices_size
        if end > len(raw):
            raise RuntimeError(f"truncated H1COL2 mesh {mesh_index}")
        positions = tuple(
            struct.iter_unpack("<fff", raw[offset : offset + positions_size])
        )
        indices = struct.unpack_from(
            f"<{index_count}I", raw, offset + positions_size
        )
        meshes.append((kind, positions, indices))
        offset = end
    return raw, meshes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collision", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--strict-production", action="store_true")
    args = parser.parse_args()

    collision_bytes, meshes = read_h1col2(args.collision)
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    entries = sorted(metadata["meshes"], key=lambda entry: entry["meshIndex"])
    if len(entries) != len(meshes):
        raise RuntimeError("metadata/H1COL2 mesh count mismatch")
    policy = load_semantic_policy(args.policy)

    classified = []
    counts = []
    for mesh_index, (entry, mesh) in enumerate(zip(entries, meshes)):
        if entry["meshIndex"] != mesh_index:
            raise RuntimeError(f"metadata mesh order mismatch at {mesh_index}")
        kind, positions, indices = mesh
        triangle_count = len(indices) // 3
        if entry["kind"] != kind or entry["triangleCount"] != triangle_count:
            raise RuntimeError(f"metadata geometry mismatch at mesh {mesh_index}")
        classified.append(
            classify_mesh_triangles(
                policy,
                actor_file=entry["actorFile"],
                collision_asset_sha256=entry["collisionAssetSha256"],
                kind=kind,
                positions=positions,
                indices=indices,
                strict_production=args.strict_production,
            )
        )
        counts.append(triangle_count)

    encoded = encode_h1sem1(
        hashlib.sha256(collision_bytes).digest(),
        classified,
        mesh_triangle_counts=counts,
        strict_production=args.strict_production,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(encoded)
    print(
        json.dumps(
            {
                "meshes": len(meshes),
                "triangles": sum(counts),
                "policySha256": policy.sha256,
                "outputSha256": hashlib.sha256(encoded).hexdigest(),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
