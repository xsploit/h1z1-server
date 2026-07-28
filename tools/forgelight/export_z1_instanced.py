"""
Export H1Z1 Z1 structures as an INSTANCED collision dataset for the server.

Produces `z1_collision.bin` (format "H1COL2", consumed by the server's
CollisionManager):
  - deduplicated unique actor meshes (positions + indices, LOD0)
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
"""
import os
import struct
import logging
from io import BytesIO
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

logging.disable(logging.WARNING)  # silence dme_loader layout spam

import export_z1_collision as exp  # applies all pack1 patches on import
zc = exp.zone_converter
from zone_loader import Zone  # noqa: E402

MAGIC = b"H1COL2\x00\x00"
BIN = Path(os.environ.get("COLLISION_OUT", "z1_collision.bin"))

# Per-mesh kind:
#   0 = walkable ground (NPCs stand on it)
#   1 = SOLID free-standing obstacle (wrecks/boulders/barriers) -> carved into
#       the navmesh near players so NPCs route around it, AND non-walkable
#   2 = NON-WALKABLE but NOT carved (walls/fences/posts). NPCs don't climb onto
#       it, but we don't carve it: walls belong to buildings, and carving them
#       seals the interior/doorways so NPCs could never get inside. NPCs clip
#       through these at ground level instead.
# SOLID is checked before NOCARVE before WALKABLE so e.g. "RoadBarrier" -> solid
# while "sidewalk"/"road" stay walkable. Unrecognised defaults to walkable.
#   3 = DOORWAY (door/gate meshes) -> EXCLUDED from navmesh generation so the
#       opening is passable (doors are openable in-game; the closed-door mesh
#       would otherwise seal the building so NPCs could never path inside).
WALKABLE_KW = ("sidewalk", "road", "floor", "foundation", "bridge", "ramp", "stair")
SOLID_KW = ("wreck", "barrier", "hesco", "sandbag", "boulder", "rock")
THIN_KW = ("fence", "chainlink", "barbedwire", "post")
DOOR_KW = ("door", "gate", "garagedoor")


def classify(actor_file):
    n = actor_file.lower()
    if any(k in n for k in DOOR_KW):  # checked first: "ModularWall_Door" -> door
        return 3
    if any(k in n for k in SOLID_KW):
        return 1
    if "wall" in n:
        return 2
    if any(k in n for k in THIN_KW):
        return 2
    if any(k in n for k in WALKABLE_KW):
        return 0
    return 0


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


def load_actor_mesh(mgr, actor_file):
    """Return (positions Nx3 f32, indices M u32) merged across the DME's meshes, or None."""
    dme = exp._safe_dme_from_adr(mgr, actor_file)
    if dme is None:
        return None
    pos_chunks, idx_chunks, base = [], [], 0
    for mesh in dme.meshes:
        if 0 not in mesh.vertices or len(mesh.vertices[0]) == 0 or len(mesh.indices) == 0:
            continue
        p = np.asarray(mesh.vertices[0], dtype=np.float32).reshape(-1, 3)
        idx = np.asarray(mesh.indices, dtype=np.uint32) + base
        pos_chunks.append(p)
        idx_chunks.append(idx)
        base += len(p)
    if not pos_chunks:
        return None
    return np.concatenate(pos_chunks), np.concatenate(idx_chunks)


def main():
    mgr = exp._patched_get_manager(None)
    zone = load_zone(mgr)
    print(f"[inst] zone parsed: {len(zone.objects)} actor types, "
          f"{sum(len(o.instances) for o in zone.objects)} instances")

    # 1) dedup unique actor meshes
    mesh_index = {}     # actor_file -> int index or None
    meshes = []         # list of (pos, idx)
    mesh_kind = []      # 0 walkable / 1 obstacle, per unique mesh
    local_corners = []  # 8x3 local AABB corners per mesh (for world AABB calc)
    for o in zone.objects:
        if o.actor_file in mesh_index:
            continue
        m = load_actor_mesh(mgr, o.actor_file)
        if m is None:
            mesh_index[o.actor_file] = None
            continue
        mesh_index[o.actor_file] = len(meshes)
        meshes.append(m)
        mesh_kind.append(classify(o.actor_file))
        mn, mx = m[0].min(0), m[0].max(0)
        local_corners.append(np.array(
            [[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])],
            dtype=np.float64))
    print(f"[inst] unique meshes loaded OK: {len(meshes)}  "
          f"(skipped types: {sum(1 for v in mesh_index.values() if v is None)})")
    print(f"[inst] mesh kinds: {mesh_kind.count(0)} walkable, "
          f"{mesh_kind.count(1)} solid, {mesh_kind.count(2)} thin, "
          f"{mesh_kind.count(3)} door")

    # 2) bake instances (transform via the proven-georeferenced converter math)
    inst_mesh = []
    inst_data = []  # 16 floats: tx ty tz, qx qy qz qw, sx sy sz, minXYZ, maxXYZ
    flat_check = []  # (translationY, aabbYspan) for nominally flat surfaces
    for o in zone.objects:
        mi = mesh_index.get(o.actor_file)
        if mi is None:
            continue
        corners = local_corners[mi]
        is_flat = any(k in o.actor_file.lower() for k in ("sidewalk", "road", "floor", "foundation"))
        for ins in o.instances:
            t = np.array([ins.translation.x, ins.translation.y, ins.translation.z])
            q = np.array(zc.get_gltf_rotation((ins.rotation.x, ins.rotation.y, ins.rotation.z)))
            s = np.array([ins.scale.x, ins.scale.y, ins.scale.z])
            world = t + Rotation.from_quat(q).apply(s * corners)
            wmin, wmax = world.min(0), world.max(0)
            inst_mesh.append(mi)
            inst_data.append([t[0], t[1], t[2], q[0], q[1], q[2], q[3],
                              s[0], s[1], s[2], wmin[0], wmin[1], wmin[2],
                              wmax[0], wmax[1], wmax[2]])
            if is_flat:
                flat_check.append((t[1], wmax[1] - wmin[1]))

    inst_mesh = np.asarray(inst_mesh, dtype=np.uint32)
    inst_data = np.asarray(inst_data, dtype=np.float32)
    print(f"[inst] baked instances: {len(inst_mesh)}")

    solid_instances = int(sum(1 for mi in inst_mesh if mesh_kind[mi] == 1))
    print(f"[inst] solid-obstacle instances (carve candidates): {solid_instances}")

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

    # 4) sanity: flat surfaces should have small AABB Y span (correct orientation)
    if flat_check:
        fc = np.array(flat_check)
        print(f"[inst] flat-surface check ({len(fc)} road/sidewalk/floor/foundation instances):")
        print(f"        median AABB Y-span: {np.median(fc[:, 1]):.2f} m (small => correct orientation)")
        print(f"        AABB Y-span 95th pct: {np.percentile(fc[:, 1], 95):.2f} m")
    wmins = inst_data[:, 10:13]
    wmaxs = inst_data[:, 13:16]
    print(f"[inst] world X range: [{wmins[:, 0].min():.0f}, {wmaxs[:, 0].max():.0f}]")
    print(f"[inst] world Y range: [{wmins[:, 1].min():.0f}, {wmaxs[:, 1].max():.0f}]")
    print(f"[inst] world Z range: [{wmins[:, 2].min():.0f}, {wmaxs[:, 2].max():.0f}]")


if __name__ == "__main__":
    main()
