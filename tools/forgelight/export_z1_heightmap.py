"""Export the native Z1 CNK0 terrain heights to the server heightmap format.

The output is derived from the user's H1Z1 client assets and is intentionally
gitignored. The server decodes each pixel as:

    height_meters = (red - 16) * 8 + green / 32

Run from the pydmod virtual environment with pydmod on PYTHONPATH.
"""

from __future__ import annotations

import argparse
import os
import struct
from glob import glob
from io import BytesIO
from pathlib import Path

from DbgPack import AssetManager
from numba import njit
import numpy as np
from PIL import Image
from cnk_loader import ForgelightChunk
from zone_loader import Zone

MAP_SIZE = 8192
WORLD_HALF = MAP_SIZE // 2
MISSING_HEIGHT = np.iinfo(np.int16).min


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--assets",
        default=os.environ.get("H1Z1_ASSETS", "D:/h1z1/Resources/Assets"),
        help="Directory containing Assets_*.pack",
    )
    parser.add_argument(
        "--output",
        default=os.environ.get("HEIGHTMAP_OUT", "heightmap.png"),
        help="Destination PNG",
    )
    parser.add_argument(
        "--inspect-only",
        action="store_true",
        help="Parse one terrain chunk and print its coordinate coverage",
    )
    parser.add_argument(
        "--inspect-chunk",
        nargs=2,
        type=int,
        metavar=("X", "Y"),
        help="Terrain chunk coordinates to use with --inspect-only",
    )
    parser.add_argument(
        "--validate-topology-only",
        action="store_true",
        help="Parse every native terrain mesh without producing a heightmap",
    )
    return parser.parse_args()


def load_assets(path: str) -> tuple[AssetManager, dict[str, object]]:
    packs = sorted(glob(os.path.join(path, "Assets_*.pack")))
    if not packs:
        raise FileNotFoundError(f"No Assets_*.pack found in {path!r}")
    print(f"[heightmap] loading {len(packs)} pack1 archives")
    manager = AssetManager([Path(pack) for pack in packs])
    index = {name.lower(): asset for name, asset in manager.assets.items()}
    print(f"[heightmap] indexed {len(index)} assets")
    return manager, index


def load_raw(index: dict[str, object], name: str) -> bytes:
    asset = index.get(name.lower())
    if asset is None:
        raise FileNotFoundError(f"{name} not found in client packs")
    return asset.get_data()


def iter_chunk_names(zone: Zone):
    header = zone.header
    for chunk_x in range(header.start_x, header.start_x + header.chunks_x, 4):
        for chunk_y in range(header.start_y, header.start_y + header.chunks_y, 4):
            yield chunk_x, chunk_y, f"Z1_{chunk_x}_{chunk_y}.cnk0"


def chunk_sample_groups(
    vertices: np.ndarray,
    render_batches: np.ndarray,
    indices: np.ndarray,
    chunk_x: int,
    chunk_y: int,
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
    sample_groups = []
    batch_groups: dict[tuple[int, int], list[np.void]] = {}
    for batch in render_batches:
        vertex_range = (
            int(batch["vertex_offset"]),
            int(batch["vertex_count"]),
        )
        batch_groups.setdefault(vertex_range, []).append(batch)
    if len(batch_groups) != 16:
        raise ValueError(
            f"Expected 16 terrain tile vertex ranges, got {len(batch_groups)}"
        )
    batch_count = len(batch_groups)

    for batch_index, (vertex_range, batches) in enumerate(batch_groups.items()):
        batch_vertices = vertices[vertex_range[0] : vertex_range[0] + vertex_range[1]]
        if not len(batch_vertices):
            continue
        local_offset_x = ((batch_count - 1 - batch_index) % 4 + 1) * 64
        local_offset_z = ((batch_count - 1 - batch_index) >> 2) * 64 + 64
        world_x = np.fromiter(
            (
                vertex["x"] - local_offset_x + 64 * (chunk_y + 4)
                for vertex in batch_vertices
            ),
            dtype=np.int32,
            count=len(batch_vertices),
        )
        world_z = np.fromiter(
            (
                vertex["y"] - local_offset_z + 64 * (chunk_x + 4)
                for vertex in batch_vertices
            ),
            dtype=np.int32,
            count=len(batch_vertices),
        )
        heights = batch_vertices["height_near"]
        triangle_indices = np.concatenate(
            [
                indices[
                    batch["index_offset"] : batch["index_offset"] + batch["index_count"]
                ]
                for batch in batches
            ]
        )
        if len(triangle_indices) % 3:
            raise ValueError("Detailed terrain index count is not triangular")
        triangles = triangle_indices.reshape(-1, 3).astype(np.int32)
        triangles = triangles[np.all(triangles < 0xFFF0, axis=1)]
        if triangles.max(initial=0) >= len(batch_vertices):
            raise ValueError(
                f"terrain tile {batch_index} index "
                f"{triangles.max(initial=0)} exceeds "
                f"{len(batch_vertices) - 1}; batches="
                + ",".join(
                    f"{int(item['unknown'])}:"
                    f"{int(item['index_offset'])}:"
                    f"{int(item['index_count'])}"
                    for item in batches
                )
            )
        sample_groups.append(
            (
                world_z + WORLD_HALF,
                WORLD_HALF - world_x,
                heights,
                triangles,
            )
        )

    return sample_groups


def chunk_samples(
    sample_groups: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    pixel_x, pixel_y, heights = tuple(
        np.concatenate([group[index] for group in sample_groups]) for index in range(3)
    )
    coordinates = np.column_stack((pixel_x, pixel_y))
    unique_coordinates, inverse = np.unique(coordinates, axis=0, return_inverse=True)
    upper_heights = np.full(
        len(unique_coordinates), np.iinfo(np.int16).min, dtype=np.int16
    )
    np.maximum.at(upper_heights, inverse, heights)
    return unique_coordinates[:, 0], unique_coordinates[:, 1], upper_heights


VERTEX_DTYPE = np.dtype(
    [
        ("x", "<i2"),
        ("y", "<i2"),
        ("height_far", "<i2"),
        ("height_near", "<i2"),
        ("color1", "<u4"),
        ("color2", "<u4"),
    ]
)
BATCH_DTYPE = np.dtype(
    [
        ("unknown", "<u4"),
        ("index_offset", "<u4"),
        ("index_count", "<u4"),
        ("vertex_offset", "<u4"),
        ("vertex_count", "<u4"),
    ]
)


def find_vertex_section(data: bytes, start: int) -> tuple[np.ndarray, np.ndarray, int]:
    for count_offset in range(start, len(data) - 8):
        (vertex_count,) = struct.unpack_from("<I", data, count_offset)
        if not 1_000 <= vertex_count <= 500_000:
            continue
        vertex_offset = count_offset + 4
        batch_count_offset = vertex_offset + vertex_count * VERTEX_DTYPE.itemsize
        if batch_count_offset + 4 > len(data):
            continue
        (batch_count,) = struct.unpack_from("<I", data, batch_count_offset)
        if not 1 <= batch_count <= 512:
            continue
        batch_offset = batch_count_offset + 4
        batch_end = batch_offset + batch_count * BATCH_DTYPE.itemsize
        if batch_end > len(data):
            continue
        batches = np.frombuffer(
            data,
            dtype=BATCH_DTYPE,
            count=batch_count,
            offset=batch_offset,
        )
        if (
            np.any(batches["vertex_count"] == 0)
            or np.any(batches["vertex_offset"] + batches["vertex_count"] > vertex_count)
            or int(batches["vertex_count"].sum()) < vertex_count // 2
        ):
            continue
        vertices = np.frombuffer(
            data,
            dtype=VERTEX_DTYPE,
            count=vertex_count,
            offset=vertex_offset,
        )
        if (
            np.abs(vertices["x"].astype(np.int32)).max() > 1024
            or np.abs(vertices["y"].astype(np.int32)).max() > 1024
        ):
            continue
        return vertices, batches, count_offset
    raise ValueError("Could not locate the CNK0 vertex and render-batch section")


def find_index_section(
    data: bytes,
    start: int,
    vertex_count_offset: int,
    batches: np.ndarray,
) -> tuple[np.ndarray, int]:
    for count_offset in range(start, vertex_count_offset - 4):
        byte_count = vertex_count_offset - count_offset - 4
        if byte_count < 2_000 or byte_count % 2:
            continue
        index_count = byte_count // 2
        if index_count > 2_000_000:
            continue
        (stored_count,) = struct.unpack_from("<I", data, count_offset)
        if stored_count != index_count:
            continue
        indices = np.frombuffer(
            data,
            dtype="<u2",
            count=index_count,
            offset=count_offset + 4,
        )
        if np.any(batches["index_offset"] + batches["index_count"] > index_count):
            continue
        valid_candidate = True
        for batch in batches:
            batch_indices = indices[
                batch["index_offset"] : batch["index_offset"] + batch["index_count"]
            ]
            ordinary_indices = batch_indices[batch_indices < 0xFFF0]
            if np.any(ordinary_indices >= batch["vertex_count"]):
                valid_candidate = False
                break
        if valid_candidate:
            return indices, count_offset
    raise ValueError("Could not locate the CNK0 terrain index section")


def describe_vertex_candidates(data: bytes, start: int) -> list[str]:
    candidates: list[str] = []
    for count_offset in range(start, len(data) - 8):
        (vertex_count,) = struct.unpack_from("<I", data, count_offset)
        if not 10_000 <= vertex_count <= 200_000:
            continue
        vertex_offset = count_offset + 4
        vertex_end = vertex_offset + vertex_count * VERTEX_DTYPE.itemsize
        if vertex_end + 32 > len(data):
            continue
        sample = np.frombuffer(
            data,
            dtype=VERTEX_DTYPE,
            count=min(vertex_count, 128),
            offset=vertex_offset,
        )
        if (
            np.count_nonzero(np.abs(sample["x"].astype(np.int32)) <= 1024)
            < len(sample) * 0.95
            or np.count_nonzero(np.abs(sample["y"].astype(np.int32)) <= 1024)
            < len(sample) * 0.95
        ):
            continue
        following = struct.unpack_from("<8I", data, vertex_end)
        all_vertices = np.frombuffer(
            data,
            dtype=VERTEX_DTYPE,
            count=vertex_count,
            offset=vertex_offset,
        )
        batch_debug = ""
        batch_count = following[0]
        if 1 <= batch_count <= 512:
            possible_batches = np.frombuffer(
                data,
                dtype=BATCH_DTYPE,
                count=batch_count,
                offset=vertex_end + 4,
            )
            valid_batches = (
                possible_batches["vertex_offset"] + possible_batches["vertex_count"]
                <= vertex_count
            )
            batch_debug = (
                f" batch_valid={np.count_nonzero(valid_batches)}/"
                f"{batch_count} batch_first={possible_batches[:5].tolist()}"
            )
        candidates.append(
            f"@{count_offset} count={vertex_count} "
            f"x=[{all_vertices['x'].min()},{all_vertices['x'].max()}] "
            f"y=[{all_vertices['y'].min()},{all_vertices['y'].max()}] "
            f"h=[{all_vertices['height_near'].min()},"
            f"{all_vertices['height_near'].max()}] "
            f"first_xy={list(zip(all_vertices['x'][:8], all_vertices['y'][:8]))} "
            f"next={following}{batch_debug}"
        )
        if len(candidates) == 20:
            break
    return candidates


def load_chunk_geometry(
    raw_chunk: bytes, chunk_x: int, chunk_y: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray, bytes, int]:
    decompressed = ForgelightChunk.decompress(BytesIO(raw_chunk)).getvalue()
    last_tile = struct.pack("<ii", chunk_x + 3, chunk_y + 3)
    last_tile_offset = decompressed.find(last_tile, 8)
    if last_tile_offset < 0:
        raise ValueError(f"Last tile header missing for chunk {chunk_x},{chunk_y}")
    try:
        vertices, batches, section_offset = find_vertex_section(
            decompressed, last_tile_offset
        )
    except ValueError:
        print(
            "[heightmap] plausible vertex sections: "
            + " | ".join(describe_vertex_candidates(decompressed, last_tile_offset))
        )
        raise
    indices, _ = find_index_section(
        decompressed, last_tile_offset, section_offset, batches
    )
    return vertices, batches, indices, decompressed, section_offset


@njit
def rasterize_triangles(
    pixel_x: np.ndarray,
    pixel_y: np.ndarray,
    heights: np.ndarray,
    triangles: np.ndarray,
    x_min: int,
    x_max: int,
    y_min: int,
    y_max: int,
) -> np.ndarray:
    raster = np.full(
        (y_max - y_min + 1, x_max - x_min + 1),
        np.int16(-32768),
        dtype=np.int16,
    )
    for triangle in triangles:
        x0 = int(pixel_x[triangle[0]])
        y0 = int(pixel_y[triangle[0]])
        x1 = int(pixel_x[triangle[1]])
        y1 = int(pixel_y[triangle[1]])
        x2 = int(pixel_x[triangle[2]])
        y2 = int(pixel_y[triangle[2]])
        denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if denominator == 0:
            continue
        triangle_x_min = max(x_min, min(x0, x1, x2))
        triangle_x_max = min(x_max, max(x0, x1, x2))
        triangle_y_min = max(y_min, min(y0, y1, y2))
        triangle_y_max = min(y_max, max(y0, y1, y2))
        for y in range(triangle_y_min, triangle_y_max + 1):
            for x in range(triangle_x_min, triangle_x_max + 1):
                weight0 = (y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)
                weight1 = (y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)
                weight2 = denominator - weight0 - weight1
                if denominator > 0:
                    inside = weight0 >= 0 and weight1 >= 0 and weight2 >= 0
                else:
                    inside = weight0 <= 0 and weight1 <= 0 and weight2 <= 0
                if not inside:
                    continue
                height = round(
                    (
                        weight0 * int(heights[triangle[0]])
                        + weight1 * int(heights[triangle[1]])
                        + weight2 * int(heights[triangle[2]])
                    )
                    / denominator
                )
                raster_y = y - y_min
                raster_x = x - x_min
                if height > raster[raster_y, raster_x]:
                    raster[raster_y, raster_x] = np.int16(height)
    return raster


def rasterize_tile_mesh(
    pixel_x: np.ndarray,
    pixel_y: np.ndarray,
    heights: np.ndarray,
    triangles: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x_min = max(0, int(pixel_x.min()))
    x_max = min(MAP_SIZE - 1, int(pixel_x.max()))
    y_min = max(0, int(pixel_y.min()))
    y_max = min(MAP_SIZE - 1, int(pixel_y.max()))
    raster = rasterize_triangles(
        pixel_x,
        pixel_y,
        heights,
        triangles,
        x_min,
        x_max,
        y_min,
        y_max,
    )
    local_y, local_x = np.nonzero(raster != MISSING_HEIGHT)
    return (
        local_x + x_min,
        local_y + y_min,
        raster[local_y, local_x],
    )


def main() -> None:
    args = parse_args()
    _, index = load_assets(args.assets)
    zone = Zone.load(BytesIO(load_raw(index, "Z1.zone")))
    header = zone.header
    chunk_names = list(iter_chunk_names(zone))
    print(
        "[heightmap] zone "
        f"start=({header.start_x},{header.start_y}) "
        f"chunks=({header.chunks_x},{header.chunks_y}) "
        f"terrain_files={len(chunk_names)}"
    )

    if args.inspect_only:
        chunk_x, chunk_y, name = (
            next(
                chunk for chunk in chunk_names if chunk[:2] == tuple(args.inspect_chunk)
            )
            if args.inspect_chunk
            else chunk_names[0]
        )
        raw_chunk = load_raw(index, name)
        (
            vertices,
            batches,
            indices,
            decompressed,
            section_offset,
        ) = load_chunk_geometry(raw_chunk, chunk_x, chunk_y)
        try:
            sample_groups = chunk_sample_groups(
                vertices, batches, indices, chunk_x, chunk_y
            )
        except ValueError as error:
            raise ValueError(f"{name}: {error}") from error
        pixel_x, pixel_y, heights = chunk_samples(sample_groups)
        print(
            f"[heightmap] {name}: raw={len(raw_chunk)} "
            f"decompressed={len(decompressed)} geometry@{section_offset} "
            f"vertices={len(vertices)} batches={len(batches)} "
            f"samples={len(heights)} "
            f"pixels_x=[{pixel_x.min()},{pixel_x.max()}] "
            f"pixels_y=[{pixel_y.min()},{pixel_y.max()}] "
            f"height=[{heights.min() / 32:.2f},{heights.max() / 32:.2f}]m"
        )
        batch_groups: dict[tuple[int, int], list[np.void]] = {}
        for batch in batches:
            batch_groups.setdefault(
                (
                    int(batch["vertex_offset"]),
                    int(batch["vertex_count"]),
                ),
                [],
            ).append(batch)
        for group_index, group_batches in enumerate(batch_groups.values()):
            print(
                f"[heightmap] tile {group_index} batches="
                + ",".join(
                    f"{int(batch['unknown'])}:{int(batch['index_count'])}"
                    for batch in group_batches
                )
            )
        rasterized_pixels = 0
        reconstruction_errors = []
        for group in sample_groups:
            grid_x, grid_y, interpolated = rasterize_tile_mesh(*group)
            rasterized_pixels += len(interpolated)
            raster_lookup = {
                int(y) * MAP_SIZE + int(x): int(value)
                for x, y, value in zip(grid_x, grid_y, interpolated)
            }
            reconstruction_errors.extend(
                abs(raster_lookup[int(y) * MAP_SIZE + int(x)] - int(value))
                for x, y, value in zip(*group[:3])
                if int(y) * MAP_SIZE + int(x) in raster_lookup
            )
        reconstruction_errors = np.asarray(reconstruction_errors) / 32
        print(
            f"[heightmap] topology raster pixels={rasterized_pixels} "
            f"native reconstruction max={reconstruction_errors.max():.3f}m"
        )
        return

    if args.validate_topology_only:
        for number, (chunk_x, chunk_y, name) in enumerate(chunk_names, 1):
            vertices, batches, indices, _, _ = load_chunk_geometry(
                load_raw(index, name), chunk_x, chunk_y
            )
            try:
                chunk_sample_groups(vertices, batches, indices, chunk_x, chunk_y)
            except ValueError as error:
                raise ValueError(f"{name}: {error}") from error
            if number % 64 == 0 or number == len(chunk_names):
                print(f"[heightmap] validated {number}/{len(chunk_names)} chunks")
        return

    height_units = np.full((MAP_SIZE, MAP_SIZE), MISSING_HEIGHT, dtype=np.int16)
    native_duplicate_conflicts = 0
    raster_seam_conflicts = 0
    for number, (chunk_x, chunk_y, name) in enumerate(chunk_names, 1):
        vertices, batches, indices, _, _ = load_chunk_geometry(
            load_raw(index, name), chunk_x, chunk_y
        )
        try:
            sample_groups = chunk_sample_groups(
                vertices, batches, indices, chunk_x, chunk_y
            )
        except ValueError as error:
            raise ValueError(f"{name}: {error}") from error
        pixel_x, pixel_y, heights = chunk_samples(sample_groups)
        valid = (
            (pixel_x >= 0)
            & (pixel_x < MAP_SIZE)
            & (pixel_y >= 0)
            & (pixel_y < MAP_SIZE)
        )
        pixel_x = pixel_x[valid]
        pixel_y = pixel_y[valid]
        heights = heights[valid]
        previous = height_units[pixel_y, pixel_x]
        native_duplicate_conflicts += int(
            np.count_nonzero((previous != MISSING_HEIGHT) & (previous != heights))
        )
        for group_index, sample_group in enumerate(sample_groups):
            try:
                grid_x, grid_y, interpolated = rasterize_tile_mesh(*sample_group)
            except RuntimeError as error:
                raise RuntimeError(
                    f"{name} terrain tile {group_index} cannot be rasterized"
                ) from error
            previous = height_units[grid_y, grid_x]
            raster_seam_conflicts += int(
                np.count_nonzero(
                    (previous != MISSING_HEIGHT) & (previous != interpolated)
                )
            )
            height_units[grid_y, grid_x] = interpolated
        height_units[pixel_y, pixel_x] = heights
        if number % 64 == 0 or number == len(chunk_names):
            print(f"[heightmap] decoded {number}/{len(chunk_names)} chunks")

    missing = height_units == MISSING_HEIGHT
    missing_count = int(np.count_nonzero(missing))
    coverage = 1 - missing_count / height_units.size
    print(
        f"[heightmap] coverage={coverage:.6%} "
        f"missing={missing_count} "
        f"native_duplicate_conflicts={native_duplicate_conflicts} "
        f"raster_seam_conflicts={raster_seam_conflicts}"
    )
    if missing_count:
        raise RuntimeError(
            "Chunk triangulation did not cover the complete map; "
            "refusing to invent terrain outside native sample hulls"
        )

    biased = height_units.astype(np.int32) + WORLD_HALF
    if biased.min() < 0 or biased.max() > 65535:
        raise RuntimeError(
            f"Height range cannot be encoded: [{biased.min()}, {biased.max()}]"
        )
    red = (biased >> 8).astype(np.uint8)
    green = (biased & 0xFF).astype(np.uint8)
    blue = np.zeros_like(red)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.merge(
        "RGB",
        (Image.fromarray(red), Image.fromarray(green), Image.fromarray(blue)),
    ).save(output, optimize=True)
    print(
        f"[heightmap] wrote {output} " f"({output.stat().st_size / 1_000_000:.1f} MB)"
    )


if __name__ == "__main__":
    main()
