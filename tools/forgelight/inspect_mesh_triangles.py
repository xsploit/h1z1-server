"""Read-only per-triangle inspection artifact for one H1COL2 mesh.

Maps every triangle of the named actor's collision mesh to its exact
provenance and geometry evidence: global mesh identity (actor file,
collision asset, SHA-256, kind), triangle index, connected component,
local centroid/normal/slope/area, and a local elevation band. Emits a
deterministic JSON artifact that authored per-triangle policy rules can
cite as review evidence. Classifies nothing.

Render-object/material provenance is optional: when a semantic OBJ export
covering this actor is available it can be joined later; this tool records
`renderProvenance: null` rather than inventing any.

Usage:
    python inspect_mesh_triangles.py <z1_collision.bin> \
        <z1_collision.metadata.json> <ActorFile.adr> [--json <out.json>] \
        [--band-height <meters>]
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from pathlib import Path


def load_mesh(collision_path: Path, mesh_index: int):
    raw = collision_path.read_bytes()
    if raw[:8] != b"H1COL2\x00\x00":
        raise ValueError("not an H1COL2 file")
    version, mesh_count, _ = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise ValueError(f"unsupported H1COL2 version {version}")
    if mesh_index >= mesh_count:
        raise ValueError("mesh index out of range")
    offset = 20
    for index in range(mesh_count):
        kind = raw[offset]
        vertex_count, index_count = struct.unpack_from("<II", raw, offset + 1)
        offset += 9
        if index == mesh_index:
            positions = struct.unpack_from(f"<{vertex_count * 3}f", raw, offset)
            indices = struct.unpack_from(
                f"<{index_count}I", raw, offset + vertex_count * 12
            )
            return kind, positions, indices
        offset += vertex_count * 12 + index_count * 4
    raise AssertionError("unreachable")


def connected_components(indices: tuple[int, ...]) -> list[int]:
    """Union-find over exact shared vertex indices; one id per triangle."""

    parent: dict[int, int] = {}

    def find(a: int) -> int:
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    triangle_count = len(indices) // 3
    for tri in range(triangle_count):
        a, b, c = indices[tri * 3 : tri * 3 + 3]
        union(a, b)
        union(b, c)
    # Stable component ids: number components by their smallest vertex root.
    roots = sorted({find(indices[tri * 3]) for tri in range(triangle_count)})
    root_to_id = {root: component for component, root in enumerate(roots)}
    return [root_to_id[find(indices[tri * 3])] for tri in range(triangle_count)]


def inspect(kind: int, positions, indices, band_height: float) -> dict:
    triangle_count = len(indices) // 3
    components = connected_components(indices)
    mesh_min_y = min(positions[1::3])

    triangles = []
    component_stats: dict[int, dict] = {}
    for tri in range(triangle_count):
        ia, ib, ic = indices[tri * 3 : tri * 3 + 3]
        a = positions[ia * 3 : ia * 3 + 3]
        b = positions[ib * 3 : ib * 3 + 3]
        c = positions[ic * 3 : ic * 3 + 3]
        e1 = [b[i] - a[i] for i in range(3)]
        e2 = [c[i] - a[i] for i in range(3)]
        normal = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ]
        length = math.sqrt(sum(n * n for n in normal))
        area = length * 0.5
        unit = [n / length for n in normal] if length > 1e-12 else [0.0, 0.0, 0.0]
        # Slope relative to horizontal: 0 = flat floor/ceiling plane,
        # 90 = vertical wall. Sign of normal Y distinguishes up/down.
        slope = math.degrees(math.acos(min(1.0, abs(unit[1]))))
        centroid = [round((a[i] + b[i] + c[i]) / 3.0, 4) for i in range(3)]
        band = int((centroid[1] - mesh_min_y) // band_height)
        component = components[tri]
        stats = component_stats.setdefault(
            component,
            {
                "triangles": 0,
                "area": 0.0,
                "min": [math.inf] * 3,
                "max": [-math.inf] * 3,
            },
        )
        stats["triangles"] += 1
        stats["area"] += area
        for point in (a, b, c):
            for axis in range(3):
                stats["min"][axis] = min(stats["min"][axis], point[axis])
                stats["max"][axis] = max(stats["max"][axis], point[axis])
        triangles.append(
            {
                "triangle": tri,
                "component": component,
                "centroid": centroid,
                "normal": [round(n, 4) for n in unit],
                "normalY": round(unit[1], 4),
                "slopeDegrees": round(slope, 2),
                "area": round(area, 5),
                "elevationBand": band,
                "renderProvenance": None,
            }
        )

    component_rows = [
        {
            "component": component,
            "triangles": stats["triangles"],
            "totalArea": round(stats["area"], 4),
            "localAabbMin": [round(v, 4) for v in stats["min"]],
            "localAabbMax": [round(v, 4) for v in stats["max"]],
        }
        for component, stats in sorted(component_stats.items())
    ]
    return {
        "kind": kind,
        "triangleCount": triangle_count,
        "componentCount": len(component_rows),
        "meshMinY": round(mesh_min_y, 4),
        "bandHeight": band_height,
        "components": component_rows,
        "triangles": triangles,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("collision", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("actor")
    parser.add_argument("--json", type=Path, default=None)
    parser.add_argument("--band-height", type=float, default=0.5)
    args = parser.parse_args()

    metadata = json.loads(args.metadata.read_text())
    matches = [
        mesh
        for mesh in metadata["meshes"]
        if mesh["actorFile"].casefold() == args.actor.casefold()
    ]
    if len(matches) != 1:
        raise SystemExit(f"expected exactly one mesh for {args.actor}, "
                         f"found {len(matches)}")
    mesh_entry = matches[0]
    kind, positions, indices = load_mesh(
        args.collision, int(mesh_entry["meshIndex"])
    )
    if kind != int(mesh_entry["kind"]):
        raise SystemExit("collision kind does not match metadata; wrong file?")

    report = {
        "actorFile": mesh_entry["actorFile"],
        "collisionAsset": mesh_entry["collisionAsset"],
        "collisionAssetSha256": mesh_entry["collisionAssetSha256"],
        "collisionSha256": metadata["collisionSha256"],
        "meshIndex": mesh_entry["meshIndex"],
        "instanceCount": mesh_entry["instanceCount"],
        **inspect(kind, positions, indices, args.band_height),
    }
    print(
        f"[inspect] {report['actorFile']} kind={report['kind']} "
        f"triangles={report['triangleCount']} "
        f"components={report['componentCount']}"
    )
    for row in report["components"][:20]:
        size = [
            round(row["localAabbMax"][axis] - row["localAabbMin"][axis], 2)
            for axis in range(3)
        ]
        print(
            f"  component {row['component']:<4} tris={row['triangles']:<6} "
            f"area={row['totalArea']:<10} size={size[0]}x{size[1]}x{size[2]} "
            f"y=[{row['localAabbMin'][1]}, {row['localAabbMax'][1]}]"
        )
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2))
        print(f"[inspect] wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
