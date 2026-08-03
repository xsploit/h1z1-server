"""Prepare per-instance regional bake bounds and transformed route probes.

The input route template is authored once in model-local coordinates.  This
tool reads the exact H1COL2 instance transforms and emits world-space routes
compatible with ``scripts/validateHouse34BInstances.ts`` plus compact regional
bounds for each matching placement.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path
from typing import Callable


def _read_h1col2_instances(path: Path) -> list[tuple[int, tuple[float, ...]]]:
    raw = path.read_bytes()
    if raw[:8] != b"H1COL2\0\0":
        raise ValueError(f"{path} is not an H1COL2 file")
    version, mesh_count, instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise ValueError(f"unsupported H1COL2 version {version}")

    offset = 20
    for mesh_index in range(mesh_count):
        if offset + 9 > len(raw):
            raise ValueError(f"truncated H1COL2 mesh {mesh_index}")
        _kind, vertex_count, index_count = struct.unpack_from("<BII", raw, offset)
        offset += 9 + vertex_count * 12 + index_count * 4

    mesh_bytes = instance_count * 4
    transform_bytes = instance_count * 16 * 4
    if offset + mesh_bytes + transform_bytes != len(raw):
        raise ValueError("invalid H1COL2 instance section length")
    mesh_indices = struct.unpack_from(f"<{instance_count}I", raw, offset)
    offset += mesh_bytes
    transforms = struct.unpack_from(f"<{instance_count * 16}f", raw, offset)
    return [
        (mesh_indices[index], transforms[index * 16 : (index + 1) * 16])
        for index in range(instance_count)
    ]


def transform_point(local: list[float], transform: tuple[float, ...]) -> list[float]:
    if len(local) != 3 or len(transform) != 16:
        raise ValueError("point/transform cardinality mismatch")
    tx, ty, tz, qx, qy, qz, qw, sx, sy, sz = transform[:10]
    vx, vy, vz = local[0] * sx, local[1] * sy, local[2] * sz

    # Mirror ForgelightGeometrySource::rotateByQuaternion exactly:
    # t = 2*cross(q.xyz,v); v' = v + q.w*t + cross(q.xyz,t).
    cx = qy * vz - qz * vy
    cy = qz * vx - qx * vz
    cz = qx * vy - qy * vx
    ux, uy, uz = 2.0 * cx, 2.0 * cy, 2.0 * cz
    c2x = qy * uz - qz * uy
    c2y = qz * ux - qx * uz
    c2z = qx * uy - qy * ux
    return [
        tx + vx + qw * ux + c2x,
        ty + vy + qw * uy + c2y,
        tz + vz + qw * uz + c2z,
    ]


def prepare(
    collision_path: Path,
    metadata_path: Path,
    template_path: Path,
    sample_terrain: Callable[[float, float], float] | None = None,
) -> tuple[list[dict], list[dict], list[dict]]:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    template = json.loads(template_path.read_text(encoding="utf-8"))
    if template.get("schemaVersion") != 1:
        raise ValueError("unsupported model validation template schema")
    actor_file = template.get("actorFile")
    matches = [
        mesh
        for mesh in metadata.get("meshes", [])
        if mesh.get("actorFile") == actor_file
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one metadata mesh for {actor_file}, got {len(matches)}")
    mesh_index = int(matches[0]["meshIndex"])
    margin = float(template.get("boundsMargin", 15.0))
    if not math.isfinite(margin) or margin <= 0:
        raise ValueError("boundsMargin must be positive and finite")

    routes: list[dict] = []
    bakes: list[dict] = []
    skipped: list[dict] = []
    terrain_probes = template.get("terrainProbes", [])
    max_terrain_delta = float(template.get("maxTerrainDelta", 1.5))
    if terrain_probes and sample_terrain is None:
        raise ValueError("terrainProbes require a heightmap terrain sampler")
    for instance_index, (candidate_mesh, transform) in enumerate(
        _read_h1col2_instances(collision_path)
    ):
        if candidate_mesh != mesh_index:
            continue
        probe_deltas = []
        for local_probe in terrain_probes:
            world_probe = transform_point(local_probe, transform)
            terrain_y = sample_terrain(world_probe[0], world_probe[2])
            probe_deltas.append(world_probe[1] - terrain_y)
        if probe_deltas and min(abs(delta) for delta in probe_deltas) > max_terrain_delta:
            skipped.append(
                {
                    "instanceIndex": instance_index,
                    "reason": "terrain-height-mismatch",
                    "terrainDeltas": probe_deltas,
                }
            )
            continue
        min_x, _min_y, min_z, max_x, _max_y, max_z = transform[10:16]
        bakes.append(
            {
                "instanceIndex": instance_index,
                "bounds": [
                    math.floor(min_x - margin),
                    math.floor(min_z - margin),
                    math.ceil(max_x + margin),
                    math.ceil(max_z + margin),
                ],
            }
        )
        for route in template.get("routes", []):
            routes.append(
                {
                    "instanceIndex": instance_index,
                    "label": route["label"],
                    "start": transform_point(route["start"], transform),
                    "end": transform_point(route["end"], transform),
                }
            )
    if not bakes and not skipped:
        raise ValueError(f"H1COL2 contains no instances for {actor_file}")
    return bakes, routes, skipped


def heightmap_sampler(path: Path) -> Callable[[float, float], float]:
    from PIL import Image

    image = Image.open(path).convert("RGB")
    if image.width != image.height or image.width % 2:
        raise ValueError("heightmap must be square with an even dimension")
    world_half = image.width // 2

    def sample(world_x: float, world_z: float) -> float:
        pixel_x = math.floor(world_z + world_half)
        pixel_y = math.floor(world_half - world_x)
        if not (0 <= pixel_x < image.width and 0 <= pixel_y < image.height):
            raise ValueError(f"terrain probe outside heightmap: {world_x},{world_z}")
        red, green, _blue = image.getpixel((pixel_x, pixel_y))
        return (red - 16) * 8 + green / 32

    return sample


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("collision", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("template", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--heightmap", type=Path)
    args = parser.parse_args()
    sampler = heightmap_sampler(args.heightmap) if args.heightmap else None
    bakes, routes, skipped = prepare(
        args.collision, args.metadata, args.template, sampler
    )
    args.output_directory.mkdir(parents=True, exist_ok=True)
    (args.output_directory / "bakes.json").write_text(
        json.dumps(bakes, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_directory / "routes.json").write_text(
        json.dumps(routes, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_directory / "skipped.json").write_text(
        json.dumps(skipped, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "instances": len(bakes),
                "skippedInstances": len(skipped),
                "routes": len(routes),
                "outputDirectory": str(args.output_directory.resolve()),
            }
        )
    )


if __name__ == "__main__":
    main()
