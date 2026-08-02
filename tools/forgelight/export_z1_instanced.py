"""
Export H1Z1 Z1 static collision as an INSTANCED dataset for the server.

Produces `z1_collision.bin` (format "H1COL2", consumed by the server's
CollisionManager):
  - deduplicated ADR CollisionData meshes (positions + indices)
  - per-instance meshIndex + transform (T/R/S) + precomputed world AABB
The Node server builds one BVH per unique mesh + an XZ broadphase over the
world AABBs, then groundRaycast(x,z) transforms a downward ray per candidate
instance to find the structure surface under an NPC.

Reuses export_z1_collision.py for all the pack1 adaptation patches.

Run from inside a pydmod checkout (see tools/forgelight/README.md). Env vars:
  H1Z1_ASSETS   directory holding Assets_*.pack (default: D:/h1z1/Resources/Assets)
  Z1_ZONE       optional path to a pre-extracted Z1.zone (else pulled from packs)
  COLLISION_OUT output .bin path (default: ./z1_collision.bin) -> copy into
                <h1z1-server>/data/2016/collision/z1_collision.bin
  COLLISION_METADATA_OUT optional deterministic mesh/actor semantic sidecar
"""

import os
import struct
import hashlib
import json
import logging
import warnings
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from collision_classification import classify, semantic_material
from cdta import UnsupportedCDTA, merge_meshes, parse_cdta

logging.disable(logging.WARNING)  # silence dme_loader layout spam
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, module=r"dme_loader\.jenkins"
)

import export_z1_collision as exp  # applies all pack1 patches on import

zc = exp.zone_converter
from zone_loader import Zone  # noqa: E402

MAGIC = b"H1COL2\x00\x00"
BIN = Path(os.environ.get("COLLISION_OUT", "z1_collision.bin"))
METADATA_OUT = os.environ.get("COLLISION_METADATA_OUT")
FAILURES_OUT = os.environ.get("COLLISION_FAILURES_OUT")

# This is the only non-CDTA CollisionData reference among the 980 actor types
# in Z1's previous runtime collision inventory.  It is a destroyed decorative
# garbage can backed by a PhysX/APEX asset, not an authored navigation surface.
# Record the omission in metadata instead of substituting its render Base.
REVIEWED_COLLISION_SKIPS = {
    "common_props_garbagecan01_destroyed.adr": (
        "Common_Props_GarbageCan01_COL.apx",
        "decorative destroyed prop; APX has no explicit CDTA triangle contract",
    )
}


def load_zone(mgr):
    """Load Z1.zone from Z1_ZONE if set/exists, else straight from the packs."""
    zpath = os.environ.get("Z1_ZONE")
    if zpath and Path(zpath).exists():
        with open(zpath, "rb") as f:
            return Zone.load(f)
    asset = mgr.get_raw("Z1.zone")
    if asset is None:
        raise FileNotFoundError("Z1.zone not found in the loaded packs")
    return Zone.load(BytesIO(asset.get_data()))


def _load_asset_bytes(mgr, name):
    asset = mgr.get_raw(name)
    if asset is None:
        raise FileNotFoundError(f"asset not found: {name}")
    return asset.get_data()


def collision_asset_from_adr(mgr, actor_file):
    """Return the exact ADR CollisionData filename, or None for a non-collider."""

    raw = _load_asset_bytes(mgr, actor_file)
    try:
        root = ET.fromstring(raw.decode("utf-8"))
    except (UnicodeDecodeError, ET.ParseError) as error:
        raise ValueError(f"invalid ADR XML {actor_file}: {error}") from error
    if root.tag != "ActorRuntime":
        raise ValueError(f"invalid ADR root for {actor_file}: {root.tag}")
    collision = root.find("CollisionData")
    if collision is None:
        return None
    collision_name = collision.get("fileName")
    if not collision_name:
        raise ValueError(f"CollisionData has no fileName in {actor_file}")
    return collision_name


def load_actor_collision_mesh(mgr, actor_file):
    """Load authoritative ADR collision without ever falling back to render DME.

    Returns a geometry/provenance mapping.  A real ADR without
    ``CollisionData`` returns ``None`` because it intentionally has no static
    collider.  Unsupported/malformed collision assets raise and are collected
    into the deterministic failure inventory by :func:`main`.
    """

    collision_name = collision_asset_from_adr(mgr, actor_file)
    if collision_name is None:
        return None
    reviewed_skip = REVIEWED_COLLISION_SKIPS.get(actor_file.lower())
    if reviewed_skip and reviewed_skip[0].lower() == collision_name.lower():
        return {
            "skip": True,
            "collisionAsset": collision_name,
            "reason": reviewed_skip[1],
        }
    if not collision_name.lower().endswith(".cdt"):
        raise UnsupportedCDTA(
            f"{actor_file}: unsupported CollisionData asset {collision_name!r}"
        )
    collision_bytes = _load_asset_bytes(mgr, collision_name)
    parsed = parse_cdta(collision_bytes, collision_name)
    positions, indices = merge_meshes(parsed)
    return {
        "skip": False,
        "positions": positions,
        "indices": indices,
        "collisionAsset": collision_name,
        "collisionSha256": hashlib.sha256(collision_bytes).hexdigest(),
        "cdtaVersion": parsed.version,
        "cdtaAssetHash": parsed.asset_hash,
        "shapeCount": parsed.shape_count,
        "triangleCount": int(len(indices) // 3),
    }


def main():
    mgr = exp._patched_get_manager(None)
    zone = load_zone(mgr)
    print(
        f"[inst] zone parsed: {len(zone.objects)} actor types, "
        f"{sum(len(o.instances) for o in zone.objects)} instances"
    )

    # 1) dedup unique actor meshes
    mesh_index = {}  # actor_file -> int index or None
    meshes = []  # list of (pos, idx)
    mesh_actors = []  # actor file per unique mesh, in binary order
    mesh_sources = []  # CollisionData provenance per unique mesh
    mesh_kind = []  # 0 walkable / 1 solid / 2 thin / 3 door, per unique mesh
    local_corners = []  # 8x3 local AABB corners per mesh (for world AABB calc)
    failures = []
    reviewed_skips = []
    no_collision = []
    for o in zone.objects:
        if o.actor_file in mesh_index:
            continue
        try:
            loaded = load_actor_collision_mesh(mgr, o.actor_file)
        except Exception as error:
            mesh_index[o.actor_file] = None
            failures.append(
                {
                    "actorFile": o.actor_file,
                    "errorType": type(error).__name__,
                    "error": str(error),
                }
            )
            continue
        if loaded is None:
            mesh_index[o.actor_file] = None
            no_collision.append(o.actor_file)
            continue
        if loaded["skip"]:
            mesh_index[o.actor_file] = None
            reviewed_skips.append(
                {
                    "actorFile": o.actor_file,
                    "collisionAsset": loaded["collisionAsset"],
                    "reason": loaded["reason"],
                }
            )
            continue
        m = (loaded["positions"], loaded["indices"])
        mesh_index[o.actor_file] = len(meshes)
        meshes.append(m)
        mesh_actors.append(o.actor_file)
        mesh_sources.append(loaded)
        mesh_kind.append(classify(o.actor_file))
        mn, mx = m[0].min(0), m[0].max(0)
        local_corners.append(
            np.array(
                [
                    [x, y, z]
                    for x in (mn[0], mx[0])
                    for y in (mn[1], mx[1])
                    for z in (mn[2], mx[2])
                ],
                dtype=np.float64,
            )
        )
    inventory = {
        "schema": "h1emu-collision-extraction-inventory-v1",
        "geometrySource": "adr_collision_cdta",
        "actorTypes": len(mesh_index),
        "decodedActorTypes": len(meshes),
        "noCollisionActorTypes": len(no_collision),
        "reviewedSkipActorTypes": len(reviewed_skips),
        "failureCount": len(failures),
        "noCollisionActors": sorted(no_collision, key=str.lower),
        "reviewedSkips": sorted(reviewed_skips, key=lambda row: row["actorFile"].lower()),
        "failures": sorted(failures, key=lambda row: row["actorFile"].lower()),
    }
    failure_path = Path(FAILURES_OUT) if FAILURES_OUT else BIN.with_suffix(
        ".extraction.json"
    )
    failure_path.parent.mkdir(parents=True, exist_ok=True)
    failure_path.write_text(
        json.dumps(inventory, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"[inst] collision actors: {len(meshes)} decoded, "
        f"{len(no_collision)} without CollisionData, "
        f"{len(reviewed_skips)} reviewed skips, {len(failures)} failures"
    )
    print(f"[inst] wrote extraction inventory {failure_path}")
    if failures:
        preview = "; ".join(
            f"{row['actorFile']}: {row['error']}" for row in inventory["failures"][:8]
        )
        raise RuntimeError(
            f"collision extraction failed closed for {len(failures)} actor types: {preview}"
        )
    print(
        f"[inst] mesh kinds: {mesh_kind.count(0)} walkable, "
        f"{mesh_kind.count(1)} solid, {mesh_kind.count(2)} thin, "
        f"{mesh_kind.count(3)} door"
    )

    # 2) bake instances (transform via the proven-georeferenced converter math)
    inst_mesh = []
    inst_data = []  # 16 floats: tx ty tz, qx qy qz qw, sx sy sz, minXYZ, maxXYZ
    flat_check = []  # (translationY, aabbYspan) for nominally flat surfaces
    for o in zone.objects:
        mi = mesh_index.get(o.actor_file)
        if mi is None:
            continue
        corners = local_corners[mi]
        is_flat = any(
            k in o.actor_file.lower()
            for k in ("sidewalk", "road", "floor", "foundation")
        )
        for ins in o.instances:
            t = np.array([ins.translation.x, ins.translation.y, ins.translation.z])
            q = np.array(
                zc.get_gltf_rotation((ins.rotation.x, ins.rotation.y, ins.rotation.z))
            )
            s = np.array([ins.scale.x, ins.scale.y, ins.scale.z])
            world = t + Rotation.from_quat(q).apply(s * corners)
            wmin, wmax = world.min(0), world.max(0)
            inst_mesh.append(mi)
            inst_data.append(
                [
                    t[0],
                    t[1],
                    t[2],
                    q[0],
                    q[1],
                    q[2],
                    q[3],
                    s[0],
                    s[1],
                    s[2],
                    wmin[0],
                    wmin[1],
                    wmin[2],
                    wmax[0],
                    wmax[1],
                    wmax[2],
                ]
            )
            if is_flat:
                flat_check.append((t[1], wmax[1] - wmin[1]))

    inst_mesh = np.asarray(inst_mesh, dtype=np.uint32)
    inst_data = np.asarray(inst_data, dtype=np.float32)
    print(f"[inst] baked instances: {len(inst_mesh)}")

    instance_kinds = [
        int(sum(1 for mi in inst_mesh if mesh_kind[mi] == kind)) for kind in range(4)
    ]
    print(
        f"[inst] instance kinds: {instance_kinds[0]} walkable, "
        f"{instance_kinds[1]} solid, {instance_kinds[2]} thin, "
        f"{instance_kinds[3]} door"
    )

    # 3) write binary (format H1COL2: per-mesh kind byte before its geometry)
    BIN.parent.mkdir(parents=True, exist_ok=True)
    with open(BIN, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<III", 2, len(meshes), len(inst_mesh)))
        for (pos, idx), kind in zip(meshes, mesh_kind):
            f.write(struct.pack("<BII", kind, len(pos), len(idx)))
            f.write(pos.astype(np.float32).tobytes())
            f.write(idx.astype(np.uint32).tobytes())
        f.write(inst_mesh.tobytes())
        f.write(inst_data.tobytes())
    print(f"[inst] wrote {BIN}  ({BIN.stat().st_size / 1e6:.1f} MB)")

    # Optional deterministic build-time sidecar.  The H1COL2 runtime format is
    # intentionally compact and does not store actor names, so without this
    # file a later semantic OBJ export can only distinguish the four numeric
    # kinds.  The sidecar is not needed by the server and can be regenerated.
    if METADATA_OUT:
        metadata_path = Path(METADATA_OUT)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        instance_counts = np.bincount(inst_mesh, minlength=len(meshes))
        with open(BIN, "rb") as collision_file:
            collision_sha256 = hashlib.file_digest(
                collision_file, "sha256"
            ).hexdigest()
        metadata = {
            "schema": "h1emu-h1col2-metadata-v2",
            "formatVersion": 2,
            "coordinateSpace": "h1z1-world-y-up-meters",
            "geometrySource": "adr_collision_cdta",
            "renderFallbackCount": 0,
            "collisionFile": BIN.name,
            "collisionSha256": collision_sha256,
            "meshCount": len(meshes),
            "instanceCount": len(inst_mesh),
            "noCollisionActorCount": len(no_collision),
            "reviewedSkips": inventory["reviewedSkips"],
            "meshes": [
                {
                    "meshIndex": index,
                    "actorFile": actor_file,
                    "collisionAsset": mesh_sources[index]["collisionAsset"],
                    "collisionAssetSha256": mesh_sources[index]["collisionSha256"],
                    "cdtaVersion": mesh_sources[index]["cdtaVersion"],
                    "cdtaAssetHash": mesh_sources[index]["cdtaAssetHash"],
                    "shapeCount": mesh_sources[index]["shapeCount"],
                    "triangleCount": mesh_sources[index]["triangleCount"],
                    "kind": mesh_kind[index],
                    "semanticMaterial": semantic_material(
                        actor_file, mesh_kind[index]
                    ),
                    "semanticSource": "actor_default_pending_per_triangle_table",
                    "instanceCount": int(instance_counts[index]),
                }
                for index, actor_file in enumerate(mesh_actors)
            ],
        }
        metadata_path.write_text(
            json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        print(f"[inst] wrote semantic metadata {metadata_path}")

    # 4) sanity: flat surfaces should have small AABB Y span (correct orientation)
    if flat_check:
        fc = np.array(flat_check)
        print(
            f"[inst] flat-surface check ({len(fc)} road/sidewalk/floor/foundation instances):"
        )
        print(
            f"        median AABB Y-span: {np.median(fc[:, 1]):.2f} m (small => correct orientation)"
        )
        print(f"        AABB Y-span 95th pct: {np.percentile(fc[:, 1], 95):.2f} m")
    wmins = inst_data[:, 10:13]
    wmaxs = inst_data[:, 13:16]
    print(f"[inst] world X range: [{wmins[:, 0].min():.0f}, {wmaxs[:, 0].max():.0f}]")
    print(f"[inst] world Y range: [{wmins[:, 1].min():.0f}, {wmaxs[:, 1].max():.0f}]")
    print(f"[inst] world Z range: [{wmins[:, 2].min():.0f}, {wmaxs[:, 2].max():.0f}]")


if __name__ == "__main__":
    main()
