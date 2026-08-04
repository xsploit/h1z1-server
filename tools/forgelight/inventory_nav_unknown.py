"""Rank the nav_unknown backlog from a semantic collision metadata export.

Reads the metadata v4 JSON produced by export_z1_instanced.py and emits a
deterministic, evidence-first inventory of every mesh that still carries
nav_unknown triangles: exact actor file, collision asset and SHA-256, kind,
triangle counts, instance count, and world impact (unknown triangles times
placed instances). The inventory is the review queue for expanding the
canonical semantic policy; it classifies nothing itself.

Usage:
    python inventory_nav_unknown.py <z1_collision.metadata.json> \
        [--json <out.json>] [--top <n>]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from collections import Counter
from pathlib import Path

from h1sem import SemanticId, decode_h1sem1


def read_mesh_aabbs(collision_path: Path) -> list[dict]:
    """Read per-mesh local AABB dimensions from an H1COL2 v2 binary.

    Geometry evidence only -- no instances or transforms are needed to judge
    whether a mesh is a plausible free-standing blocker, so parsing stops
    after the mesh table.
    """

    raw = collision_path.read_bytes()
    if raw[:8] != b"H1COL2\x00\x00":
        raise ValueError("not an H1COL2 file")
    version, mesh_count, _instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise ValueError(f"unsupported H1COL2 version {version}")
    offset = 20
    aabbs = []
    for _ in range(mesh_count):
        _kind = raw[offset]
        vertex_count, index_count = struct.unpack_from("<II", raw, offset + 1)
        offset += 9
        floats = struct.unpack_from(f"<{vertex_count * 3}f", raw, offset)
        offset += vertex_count * 12 + index_count * 4
        xs = floats[0::3]
        ys = floats[1::3]
        zs = floats[2::3]
        aabbs.append(
            {
                "localDims": [
                    round(max(xs) - min(xs), 3),
                    round(max(ys) - min(ys), 3),
                    round(max(zs) - min(zs), 3),
                ],
                "localMinY": round(min(ys), 3),
            }
        )
    return aabbs


def semantic_histograms_from_sidecar(
    metadata: dict, semantic_bytes: bytes
) -> tuple[list[dict[str, int]], str]:
    """Decode an H1SEM1 sidecar bound to this exact metadata artifact.

    Metadata histograms describe classification at export time and can become
    stale when a later policy emits a replacement sidecar for the same H1COL2
    collision file.  The sidecar is therefore the authoritative source when
    supplied; digest and per-mesh triangle counts are checked before any
    ranking is produced.
    """

    meshes = metadata.get("meshes")
    if not isinstance(meshes, list) or not meshes:
        raise ValueError("metadata has no mesh list")
    collision_sha = metadata.get("collisionSha256")
    if not isinstance(collision_sha, str) or len(collision_sha) != 64:
        raise ValueError("metadata has no valid collisionSha256")

    ordered = sorted(meshes, key=lambda mesh: int(mesh["meshIndex"]))
    actual_indices = [int(mesh["meshIndex"]) for mesh in ordered]
    expected_indices = list(range(len(ordered)))
    if actual_indices != expected_indices:
        raise ValueError("metadata meshIndex values are not contiguous from zero")

    document = decode_h1sem1(
        semantic_bytes,
        expected_h1col2_sha256=bytes.fromhex(collision_sha),
        expected_mesh_triangle_counts=tuple(
            int(mesh["triangleCount"]) for mesh in ordered
        ),
        strict_production=False,
    )
    histograms: list[dict[str, int]] = []
    for mesh_index in range(document.mesh_count):
        counts = Counter(document.semantics_for_mesh(mesh_index))
        histograms.append(
            {
                f"nav_{SemanticId(semantic_id).name.lower()}": count
                for semantic_id, count in sorted(counts.items())
            }
        )
    return histograms, hashlib.sha256(semantic_bytes).hexdigest()


def build_inventory(
    metadata: dict,
    semantic_histograms: list[dict[str, int]] | None = None,
    semantic_sidecar_sha256: str | None = None,
) -> dict:
    """Group and rank meshes that still carry nav_unknown triangles."""

    meshes = metadata.get("meshes")
    if not isinstance(meshes, list) or not meshes:
        raise ValueError("metadata has no mesh list")

    entries = []
    if semantic_histograms is not None and len(semantic_histograms) != len(meshes):
        raise ValueError("semantic histogram count does not match metadata meshes")

    for mesh in meshes:
        mesh_index = int(mesh["meshIndex"])
        histogram = (
            semantic_histograms[mesh_index]
            if semantic_histograms is not None
            else mesh["semanticHistogram"]
        )
        unknown = int(histogram.get("nav_unknown", 0))
        if unknown == 0:
            continue
        triangle_count = int(mesh["triangleCount"])
        instance_count = int(mesh["instanceCount"])
        entries.append(
            {
                "actorFile": mesh["actorFile"],
                "collisionAsset": mesh["collisionAsset"],
                "collisionAssetSha256": mesh["collisionAssetSha256"],
                "kind": int(mesh["kind"]),
                "meshIndex": mesh_index,
                "triangleCount": triangle_count,
                "unknownTriangles": unknown,
                "classifiedTriangles": triangle_count - unknown,
                "instanceCount": instance_count,
                "worldUnknownTriangles": unknown * instance_count,
                "semanticHistogram": dict(
                    sorted(histogram.items())
                ),
            }
        )

    # Deterministic ranking: world impact first, then raw unknown count,
    # then actor name so equal-impact meshes never reorder between runs.
    entries.sort(
        key=lambda entry: (
            -entry["worldUnknownTriangles"],
            -entry["unknownTriangles"],
            entry["actorFile"],
        )
    )

    by_kind: dict[int, dict] = {}
    for entry in entries:
        bucket = by_kind.setdefault(
            entry["kind"],
            {"meshes": 0, "unknownTriangles": 0, "worldUnknownTriangles": 0},
        )
        bucket["meshes"] += 1
        bucket["unknownTriangles"] += entry["unknownTriangles"]
        bucket["worldUnknownTriangles"] += entry["worldUnknownTriangles"]

    # Prefix clusters group actors that plausibly share one reviewed rule
    # (e.g. every Common_Props_Fence_* candidate). Two leading underscore
    # segments keeps Common_Props_* from collapsing into one bucket while
    # still merging obvious families.
    clusters: dict[str, dict] = {}
    for entry in entries:
        stem = entry["actorFile"].rsplit(".", 1)[0]
        prefix = "_".join(stem.split("_")[:3])
        cluster = clusters.setdefault(
            prefix,
            {
                "meshes": 0,
                "unknownTriangles": 0,
                "worldUnknownTriangles": 0,
                "kinds": set(),
            },
        )
        cluster["meshes"] += 1
        cluster["unknownTriangles"] += entry["unknownTriangles"]
        cluster["worldUnknownTriangles"] += entry["worldUnknownTriangles"]
        cluster["kinds"].add(entry["kind"])
    cluster_rows = [
        {
            "prefix": prefix,
            "meshes": data["meshes"],
            "unknownTriangles": data["unknownTriangles"],
            "worldUnknownTriangles": data["worldUnknownTriangles"],
            "kinds": sorted(data["kinds"]),
        }
        for prefix, data in clusters.items()
    ]
    cluster_rows.sort(
        key=lambda row: (-row["worldUnknownTriangles"], row["prefix"])
    )

    total_unknown = sum(entry["unknownTriangles"] for entry in entries)
    return {
        "collisionSha256": metadata.get("collisionSha256"),
        "semanticSidecarSha256": semantic_sidecar_sha256,
        "semanticSource": (
            "h1sem1" if semantic_histograms is not None else "metadata"
        ),
        "semanticMode": metadata.get("semanticMode"),
        "totalTriangles": int(metadata.get("totalTriangleCount", 0)),
        "totalUnknownTriangles": total_unknown,
        "meshesWithUnknown": len(entries),
        "byKind": {str(kind): by_kind[kind] for kind in sorted(by_kind)},
        "prefixClusters": cluster_rows,
        "meshes": entries,
    }


def print_inventory(inventory: dict, top: int) -> None:
    print(
        f"[nav-unknown] source collision {inventory['collisionSha256']} "
        f"mode={inventory['semanticMode']}"
    )
    print(
        f"[nav-unknown] {inventory['totalUnknownTriangles']} of "
        f"{inventory['totalTriangles']} triangles unknown across "
        f"{inventory['meshesWithUnknown']} meshes"
    )
    for kind, bucket in inventory["byKind"].items():
        print(
            f"[nav-unknown] kind {kind}: {bucket['meshes']} meshes, "
            f"{bucket['unknownTriangles']} unknown tris, "
            f"{bucket['worldUnknownTriangles']} world-instanced"
        )
    print(f"[nav-unknown] top prefix clusters by world impact:")
    for row in inventory["prefixClusters"][:top]:
        print(
            f"  {row['prefix']:<44} meshes={row['meshes']:<4} "
            f"unknown={row['unknownTriangles']:<7} "
            f"world={row['worldUnknownTriangles']:<9} kinds={row['kinds']}"
        )
    print(f"[nav-unknown] top meshes by world impact:")
    for entry in inventory["meshes"][:top]:
        print(
            f"  {entry['actorFile']:<52} kind={entry['kind']} "
            f"unknown={entry['unknownTriangles']}/{entry['triangleCount']:<6} "
            f"instances={entry['instanceCount']:<6} "
            f"world={entry['worldUnknownTriangles']}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--collision", type=Path, default=None,
                        help="matching z1_collision.bin; adds local AABB "
                             "geometry evidence per mesh")
    parser.add_argument("--semantics", type=Path, default=None,
                        help="matching H1SEM1 sidecar; overrides potentially "
                             "stale metadata semantic histograms")
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--top", type=int, default=25)
    args = parser.parse_args()

    metadata = json.loads(args.metadata.read_text())
    semantic_histograms = None
    semantic_sidecar_sha256 = None
    if args.semantics:
        semantic_histograms, semantic_sidecar_sha256 = (
            semantic_histograms_from_sidecar(
                metadata, args.semantics.read_bytes()
            )
        )
    inventory = build_inventory(
        metadata,
        semantic_histograms=semantic_histograms,
        semantic_sidecar_sha256=semantic_sidecar_sha256,
    )
    if args.collision:
        collision_bytes = args.collision.read_bytes()
        actual_sha256 = hashlib.sha256(collision_bytes).hexdigest()
        if actual_sha256 != metadata.get("collisionSha256"):
            raise ValueError(
                "collision SHA256 does not match metadata; wrong file?"
            )
        aabbs = read_mesh_aabbs(args.collision)
        if len(aabbs) != int(metadata["meshCount"]):
            raise ValueError(
                "collision mesh count does not match metadata; wrong file?"
            )
        for entry in inventory["meshes"]:
            entry.update(aabbs[entry["meshIndex"]])
    print_inventory(inventory, args.top)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(inventory, indent=2, sort_keys=False))
        print(f"[nav-unknown] wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
