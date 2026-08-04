"""Author one hash-bound explicit-triangle rule from reviewed geometry bounds.

The recipe is model-local and deterministic. Selectors are evaluated in order;
the first matching selector owns a triangle, and every remaining triangle gets
the declared fail-closed default (normally ``nav_obstacle_static``). The tool
can emit the isolated rule, an evidence report, and a canonical candidate
policy without modifying the source policy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

from collision_semantic_policy import (
    MATERIAL_TO_SEMANTIC,
    canonical_policy_bytes,
    semantic_compatible_with_kind,
)


def read_mesh(collision_path: Path, mesh_index: int):
    raw = collision_path.read_bytes()
    if raw[:8] != b"H1COL2\0\0":
        raise ValueError("not an H1COL2 file")
    version, mesh_count, _instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise ValueError(f"unsupported H1COL2 version {version}")
    if not 0 <= mesh_index < mesh_count:
        raise ValueError("mesh index out of range")
    offset = 20
    for index in range(mesh_count):
        kind, vertex_count, index_count = struct.unpack_from("<BII", raw, offset)
        offset += 9
        positions_size = vertex_count * 12
        indices_size = index_count * 4
        if index == mesh_index:
            positions = struct.unpack_from(
                f"<{vertex_count * 3}f", raw, offset
            )
            indices = struct.unpack_from(
                f"<{index_count}I", raw, offset + positions_size
            )
            return raw, kind, positions, indices
        offset += positions_size + indices_size
    raise AssertionError("unreachable")


def triangle_evidence(positions, indices) -> list[dict]:
    evidence = []
    for triangle_index in range(len(indices) // 3):
        vertex_indices = indices[triangle_index * 3 : triangle_index * 3 + 3]
        points = [
            positions[index * 3 : index * 3 + 3] for index in vertex_indices
        ]
        edge_a = [points[1][axis] - points[0][axis] for axis in range(3)]
        edge_b = [points[2][axis] - points[0][axis] for axis in range(3)]
        normal = [
            edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
            edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
            edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0],
        ]
        length = math.sqrt(sum(value * value for value in normal))
        normal_y = normal[1] / length if length > 1e-12 else 0.0
        slope = (
            math.degrees(math.acos(min(1.0, abs(normal_y))))
            if length > 1e-12
            else 90.0
        )
        evidence.append(
            {
                "triangle": triangle_index,
                "centroid": [
                    sum(point[axis] for point in points) / 3.0
                    for axis in range(3)
                ],
                "normalY": normal_y,
                "slopeDegrees": slope,
                "area": length * 0.5,
            }
        )
    return evidence


def _matches(selector: dict, triangle: dict) -> bool:
    bounds = selector.get("centroidBounds")
    if bounds is not None:
        if not isinstance(bounds, list) or len(bounds) != 6:
            raise ValueError("selector centroidBounds must contain 6 numbers")
        x, y, z = triangle["centroid"]
        if not (
            bounds[0] <= x <= bounds[3]
            and bounds[1] <= y <= bounds[4]
            and bounds[2] <= z <= bounds[5]
        ):
            return False
    for field in ("normalY", "slopeDegrees", "area"):
        minimum = selector.get(f"{field}Min")
        maximum = selector.get(f"{field}Max")
        value = triangle[field]
        if minimum is not None and value < float(minimum):
            return False
        if maximum is not None and value > float(maximum):
            return False
    return True


def _ranges(indices: list[int]) -> list[list[int]]:
    if not indices:
        return []
    output = []
    start = previous = indices[0]
    for index in indices[1:]:
        if index != previous + 1:
            output.append([start, previous])
            start = index
        previous = index
    output.append([start, previous])
    return output


def author_rule(kind: int, evidence: list[dict], recipe: dict) -> tuple[dict, dict]:
    selectors = recipe.get("selectors")
    if not isinstance(selectors, list) or not selectors:
        raise ValueError("recipe selectors must be a non-empty list")
    default_semantic = recipe.get("defaultSemantic")
    if default_semantic not in MATERIAL_TO_SEMANTIC:
        raise ValueError("recipe defaultSemantic is invalid")
    if not semantic_compatible_with_kind(
        kind, MATERIAL_TO_SEMANTIC[default_semantic]
    ):
        raise ValueError("recipe defaultSemantic is unsafe for this H1COL2 kind")

    assignments = [default_semantic] * len(evidence)
    claimed = [False] * len(evidence)
    selector_reports = []
    for selector_index, selector in enumerate(selectors):
        semantic = selector.get("semantic")
        if semantic not in MATERIAL_TO_SEMANTIC or semantic == "nav_unknown":
            raise ValueError(f"selector {selector_index} semantic is invalid")
        if not semantic_compatible_with_kind(kind, MATERIAL_TO_SEMANTIC[semantic]):
            raise ValueError(f"selector {selector_index} semantic is unsafe")
        raw_matches = [row["triangle"] for row in evidence if _matches(selector, row)]
        selected = [index for index in raw_matches if not claimed[index]]
        minimum = int(selector.get("minSelectedTriangles", 1))
        if len(selected) < minimum:
            raise ValueError(
                f"selector {selector.get('id', selector_index)} selected "
                f"{len(selected)} triangles, expected at least {minimum}"
            )
        for triangle_index in selected:
            assignments[triangle_index] = semantic
            claimed[triangle_index] = True
        selector_reports.append(
            {
                "id": selector.get("id", str(selector_index)),
                "semantic": semantic,
                "rawMatches": len(raw_matches),
                "selectedTriangles": len(selected),
                "shadowedTriangles": len(raw_matches) - len(selected),
                "triangleRanges": _ranges(selected),
            }
        )

    by_semantic: dict[str, list[int]] = {}
    for triangle_index, semantic in enumerate(assignments):
        by_semantic.setdefault(semantic, []).append(triangle_index)
    selections = [
        {"semantic": semantic, "triangleRanges": _ranges(indices)}
        for semantic, indices in sorted(by_semantic.items())
    ]
    rule = {
        "actorFile": recipe["actorFile"],
        "collisionAssetSha256": recipe["collisionAssetSha256"],
        "kind": kind,
        "selections": selections,
        "strategy": "explicit_triangles",
        "triangleCount": len(evidence),
    }
    report = {
        "schemaVersion": 1,
        "actorFile": recipe["actorFile"],
        "triangleCount": len(evidence),
        "defaultSemantic": default_semantic,
        "selectors": selector_reports,
        "semanticHistogram": {
            semantic: len(indices) for semantic, indices in sorted(by_semantic.items())
        },
    }
    return rule, report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("collision", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("recipe", type=Path)
    parser.add_argument("--rule", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--base-policy", type=Path)
    parser.add_argument("--policy-output", type=Path)
    args = parser.parse_args()

    recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
    if recipe.get("schemaVersion") != 1:
        raise ValueError("unsupported recipe schemaVersion")
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    matches = [
        mesh
        for mesh in metadata.get("meshes", [])
        if mesh.get("actorFile") == recipe.get("actorFile")
    ]
    if len(matches) != 1:
        raise ValueError("recipe actor does not resolve to exactly one metadata mesh")
    mesh = matches[0]
    if mesh.get("collisionAssetSha256") != recipe.get("collisionAssetSha256"):
        raise ValueError("recipe collision asset SHA256 does not match metadata")
    collision_bytes, kind, positions, indices = read_mesh(
        args.collision, int(mesh["meshIndex"])
    )
    if hashlib.sha256(collision_bytes).hexdigest() != metadata.get("collisionSha256"):
        raise ValueError("collision SHA256 does not match metadata")
    if kind != int(mesh["kind"]) or len(indices) // 3 != int(mesh["triangleCount"]):
        raise ValueError("collision mesh does not match metadata")

    rule, report = author_rule(kind, triangle_evidence(positions, indices), recipe)
    args.rule.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.rule.write_text(json.dumps(rule, indent=2) + "\n", encoding="utf-8")
    report["collisionSha256"] = metadata["collisionSha256"]
    report["collisionAssetSha256"] = mesh["collisionAssetSha256"]
    args.evidence.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if bool(args.base_policy) != bool(args.policy_output):
        raise ValueError("--base-policy and --policy-output must be used together")
    if args.base_policy and args.policy_output:
        policy = json.loads(args.base_policy.read_text(encoding="utf-8"))
        policy["rules"] = sorted(
            [
                existing
                for existing in policy["rules"]
                if existing["actorFile"] != rule["actorFile"]
            ]
            + [rule],
            key=lambda existing: existing["actorFile"].casefold(),
        )
        encoded = canonical_policy_bytes(policy)
        args.policy_output.parent.mkdir(parents=True, exist_ok=True)
        args.policy_output.write_bytes(encoded)
        report["candidatePolicySha256"] = hashlib.sha256(encoded).hexdigest()
        args.evidence.write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
