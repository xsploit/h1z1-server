"""Produce conservative review proposals for every nav_unknown collision mesh.

This is the geometry-analysis seam of the Navigation Crawl. It binds the
H1COL2 collision, metadata, and H1SEM1 sidecar by SHA-256 and triangle counts,
then emits compact exact-index evidence. It never edits semantic policy.

Kind-0 composites receive flat-band and stair/ramp candidates. The highest
flat band is always marked roof-ambiguous. Kind-2 meshes receive a conservative
static-blocker candidate, with overhead-looking actor names held for review.

Usage:
    python propose_navigation_archetypes.py z1_collision.bin \
        z1_collision.metadata.json candidate.semantics.bin --json out.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path

from h1sem import SemanticId, decode_h1sem1


SCHEMA_VERSION = 1
_OVERHEAD_TOKENS = (
    "ceiling", "fan", "sconce", "chandelier", "lightfixture", "vent",
    "awning", "sign_hanging", "hanging",
)


def compress_ranges(indices: list[int]) -> list[list[int]]:
    """Return inclusive, stable ranges for sorted unique triangle indices."""

    if not indices:
        return []
    ordered = sorted(set(indices))
    result: list[list[int]] = []
    start = end = ordered[0]
    for value in ordered[1:]:
        if value == end + 1:
            end = value
            continue
        result.append([start, end])
        start = end = value
    result.append([start, end])
    return result


def _triangle_evidence(positions, triangle_indices, triangle: int) -> dict:
    ia, ib, ic = triangle_indices[triangle * 3 : triangle * 3 + 3]
    points = [
        positions[index * 3 : index * 3 + 3]
        for index in (ia, ib, ic)
    ]
    a, b, c = points
    e1 = [b[axis] - a[axis] for axis in range(3)]
    e2 = [c[axis] - a[axis] for axis in range(3)]
    normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
    ]
    length = math.sqrt(sum(value * value for value in normal))
    unit_y = normal[1] / length if length > 1e-12 else 0.0
    slope = math.degrees(math.acos(min(1.0, abs(unit_y))))
    centroid = [sum(point[axis] for point in points) / 3 for axis in range(3)]
    return {
        "triangle": triangle,
        "centroid": centroid,
        "normalY": unit_y,
        "slopeDegrees": slope,
        "area": length * 0.5,
    }


def _summarize_group(kind: str, rows: list[dict], *, ambiguous: bool) -> dict:
    indices = [row["triangle"] for row in rows]
    centroids = [row["centroid"] for row in rows]
    return {
        "kind": kind,
        "triangleCount": len(rows),
        "triangleRanges": compress_ranges(indices),
        "centroidBounds": [
            round(min(point[0] for point in centroids), 4),
            round(min(point[1] for point in centroids), 4),
            round(min(point[2] for point in centroids), 4),
            round(max(point[0] for point in centroids), 4),
            round(max(point[1] for point in centroids), 4),
            round(max(point[2] for point in centroids), 4),
        ],
        "totalArea": round(sum(row["area"] for row in rows), 4),
        "ambiguous": ambiguous,
    }


def propose_mesh(
    mesh: dict,
    kind: int,
    positions,
    triangle_indices,
    semantic_ids: bytes,
    *,
    band_height: float = 0.5,
) -> dict:
    """Create compact, deterministic evidence for one mesh."""

    unknown = [
        index
        for index, semantic_id in enumerate(semantic_ids)
        if semantic_id == SemanticId.UNKNOWN
    ]
    if not unknown:
        raise ValueError(f"{mesh['actorFile']} has no unknown triangles")
    evidence = [
        _triangle_evidence(positions, triangle_indices, triangle)
        for triangle in unknown
    ]
    actor_lower = mesh["actorFile"].casefold()
    risk_signals = [
        f"actor-name-contains:{token}"
        for token in _OVERHEAD_TOKENS
        if token in actor_lower
    ]

    base = {
        "actorFile": mesh["actorFile"],
        "meshIndex": int(mesh["meshIndex"]),
        "kind": kind,
        "collisionAsset": mesh["collisionAsset"],
        "collisionAssetSha256": mesh["collisionAssetSha256"],
        "instanceCount": int(mesh["instanceCount"]),
        "triangleCount": len(triangle_indices) // 3,
        "unknownTriangles": len(unknown),
        "unknownTriangleRanges": compress_ranges(unknown),
        "riskSignals": risk_signals,
    }
    if kind == 2:
        return {
            **base,
            "decision": "REVIEW",
            "proposalKind": "static-blocker-candidate",
            "suggestedDefaultSemantic": "nav_obstacle_static",
            "confidence": "low" if risk_signals else "high",
            "groups": [],
            "reviewReason": (
                "overhead-looking actor requires exclude-versus-obstacle review"
                if risk_signals
                else "kind-2 geometry is non-walkable, but policy admission is explicit"
            ),
        }

    if kind != 0:
        return {
            **base,
            "decision": "BLOCKED",
            "proposalKind": "unsupported-kind",
            "suggestedDefaultSemantic": None,
            "confidence": "none",
            "groups": [],
            "reviewReason": f"automatic evidence rules do not cover H1COL2 kind {kind}",
        }

    flat_by_band: dict[int, list[dict]] = defaultdict(list)
    stair_by_band: dict[int, list[dict]] = defaultdict(list)
    min_y = min(positions[1::3])
    for row in evidence:
        band = int((row["centroid"][1] - min_y) // band_height)
        if row["normalY"] <= -0.95 and row["slopeDegrees"] <= 10:
            flat_by_band[band].append(row)
        elif row["normalY"] <= -0.65 and 10 < row["slopeDegrees"] <= 50:
            stair_by_band[band].append(row)

    groups: list[dict] = []
    highest_flat_band = max(flat_by_band, default=None)
    for band, rows in sorted(flat_by_band.items()):
        is_top = band == highest_flat_band
        group = _summarize_group(
            "roof-or-top-deck-candidate" if is_top else "floor-candidate",
            rows,
            ambiguous=is_top,
        )
        group["elevationBand"] = band
        group["suggestedSemantic"] = (
            None if is_top else "nav_floor_interior"
        )
        groups.append(group)
    for band, rows in sorted(stair_by_band.items()):
        group = _summarize_group("stair-or-ramp-candidate", rows, ambiguous=True)
        group["elevationBand"] = band
        group["suggestedSemantic"] = None
        groups.append(group)

    selected = sum(group["triangleCount"] for group in groups)
    if highest_flat_band is not None:
        risk_signals.append("highest-flat-band-is-roof-ambiguous")
    decision = "REVIEW" if groups else "BLOCKED"
    return {
        **base,
        "decision": decision,
        "proposalKind": "composite-surface-candidates",
        "suggestedDefaultSemantic": "nav_obstacle_static",
        "confidence": "review-required" if groups else "none",
        "groups": groups,
        "unassignedUnknownTriangles": len(unknown) - selected,
        "reviewReason": (
            "candidate surfaces require authored bounds, route probes, and roof review"
            if groups
            else "no downward-wound floor or stair candidates were detected"
        ),
    }


def _parse_collision(raw: bytes, wanted: set[int]) -> dict[int, tuple]:
    if raw[:8] != b"H1COL2\x00\x00":
        raise ValueError("not an H1COL2 file")
    version, mesh_count, _instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise ValueError(f"unsupported H1COL2 version {version}")
    offset = 20
    result = {}
    for mesh_index in range(mesh_count):
        kind = raw[offset]
        vertex_count, index_count = struct.unpack_from("<II", raw, offset + 1)
        offset += 9
        positions_offset = offset
        indices_offset = positions_offset + vertex_count * 12
        if mesh_index in wanted:
            positions = struct.unpack_from(
                f"<{vertex_count * 3}f", raw, positions_offset
            )
            indices = struct.unpack_from(f"<{index_count}I", raw, indices_offset)
            result[mesh_index] = (kind, positions, indices)
        offset = indices_offset + index_count * 4
    missing = sorted(wanted - result.keys())
    if missing:
        raise ValueError(f"collision is missing requested mesh indices {missing[:10]}")
    return result


def build_report(
    collision_bytes: bytes,
    metadata: dict,
    semantic_bytes: bytes,
    *,
    kinds: set[int] | None = None,
    limit: int | None = None,
    band_height: float = 0.5,
) -> dict:
    collision_sha = hashlib.sha256(collision_bytes).hexdigest()
    if collision_sha != metadata.get("collisionSha256"):
        raise ValueError("collision SHA256 does not match metadata")
    meshes = sorted(metadata["meshes"], key=lambda mesh: int(mesh["meshIndex"]))
    document = decode_h1sem1(
        semantic_bytes,
        expected_h1col2_sha256=bytes.fromhex(collision_sha),
        expected_mesh_triangle_counts=tuple(int(mesh["triangleCount"]) for mesh in meshes),
        strict_production=False,
    )
    selected = []
    for mesh in meshes:
        mesh_index = int(mesh["meshIndex"])
        semantics = document.semantics_for_mesh(mesh_index)
        unknown = semantics.count(SemanticId.UNKNOWN)
        kind = int(mesh["kind"])
        if unknown and (kinds is None or kind in kinds):
            selected.append((mesh, unknown))
    selected.sort(
        key=lambda item: (
            -(item[1] * int(item[0]["instanceCount"])),
            -item[1],
            item[0]["actorFile"],
        )
    )
    if limit is not None:
        selected = selected[:limit]
    geometry = _parse_collision(
        collision_bytes, {int(mesh["meshIndex"]) for mesh, _ in selected}
    )
    proposals = []
    for mesh, _unknown in selected:
        mesh_index = int(mesh["meshIndex"])
        kind, positions, indices = geometry[mesh_index]
        if kind != int(mesh["kind"]):
            raise ValueError(f"kind mismatch for {mesh['actorFile']}")
        proposals.append(
            propose_mesh(
                mesh,
                kind,
                positions,
                indices,
                document.semantics_for_mesh(mesh_index),
                band_height=band_height,
            )
        )
    decisions = defaultdict(int)
    for proposal in proposals:
        decisions[proposal["decision"]] += 1
    return {
        "schemaVersion": SCHEMA_VERSION,
        "collisionSha256": collision_sha,
        "semanticSidecarSha256": hashlib.sha256(semantic_bytes).hexdigest(),
        "bandHeight": band_height,
        "totals": {
            "proposals": len(proposals),
            "unknownTriangles": sum(item[1] for item in selected),
            "worldUnknownTriangles": sum(
                unknown * int(mesh["instanceCount"])
                for mesh, unknown in selected
            ),
            "decisions": dict(sorted(decisions.items())),
        },
        "proposals": proposals,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("collision", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("semantics", type=Path)
    parser.add_argument("--json", type=Path, required=True)
    parser.add_argument("--kind", type=int, action="append", dest="kinds")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--band-height", type=float, default=0.5)
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    if args.band_height <= 0:
        parser.error("--band-height must be positive")
    report = build_report(
        args.collision.read_bytes(),
        json.loads(args.metadata.read_text()),
        args.semantics.read_bytes(),
        kinds=set(args.kinds) if args.kinds else None,
        limit=args.limit,
        band_height=args.band_height,
    )
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n")
    totals = report["totals"]
    print(
        f"[nav-proposals] proposals={totals['proposals']} "
        f"unknown={totals['unknownTriangles']} decisions={totals['decisions']}"
    )
    print(f"[nav-proposals] wrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

