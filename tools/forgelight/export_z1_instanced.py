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
  COLLISION_METADATA_OUT deterministic v4 metadata path (defaults beside H1COL2)
  COLLISION_INSTANCE_IDS_OUT H1CID1 path (must share the H1COL2 directory)
  COLLISION_SEMANTICS_OUT H1SEM1 path (must share the H1COL2 directory)
  COLLISION_SEMANTIC_POLICY exact canonical policy path
  COLLISION_SEMANTIC_MODE diagnostic (default) or strict-production
  COLLISION_DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED explicit true/false evidence flag
"""

import os
import struct
import hashlib
import json
import logging
import warnings
import xml.etree.ElementTree as ET
from collections import Counter
from io import BytesIO
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from artifact_bundle import publish_artifact_bundle
from collision_classification import classify
from collision_semantic_policy import (
    POLICY_SCHEMA,
    SEMANTIC_CONTRACT,
    SEMANTIC_SCHEMA_VERSION,
    SEMANTIC_TO_MATERIAL,
    classify_mesh_triangles,
    decode_semantic_policy,
    load_semantic_policy,
)
from cdta import UnsupportedCDTA, merge_meshes, parse_cdta
from h1sem import SemanticId, decode_h1sem1, encode_h1sem1

logging.disable(logging.WARNING)  # silence dme_loader layout spam
warnings.filterwarnings(
    "ignore", category=RuntimeWarning, module=r"dme_loader\.jenkins"
)

MAGIC = b"H1COL2\x00\x00"
INSTANCE_IDS_MAGIC = b"H1CID1\x00\x00"
METADATA_SCHEMA = "h1emu-h1col2-metadata-v4"
H1CID1_FORMAT = "H1CID1-u32le-v1"
H1SEM1_FORMAT = "H1SEM1-u8le-v1"
COORDINATE_SPACE = "h1z1-world-y-up-meters"
BIN = Path(os.environ.get("COLLISION_OUT", "z1_collision.bin"))
METADATA_OUT = os.environ.get("COLLISION_METADATA_OUT")
FAILURES_OUT = os.environ.get("COLLISION_FAILURES_OUT")
INSTANCE_IDS_OUT = os.environ.get("COLLISION_INSTANCE_IDS_OUT")
SEMANTICS_OUT = os.environ.get("COLLISION_SEMANTICS_OUT")
SEMANTIC_POLICY_PATH = Path(
    os.environ.get(
        "COLLISION_SEMANTIC_POLICY",
        Path(__file__).resolve().parent
        / "policies"
        / "z1_collision.semantic_policy.json",
    )
)
SEMANTIC_MODE = os.environ.get("COLLISION_SEMANTIC_MODE", "diagnostic")
DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED = os.environ.get(
    "COLLISION_DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED", "false"
)

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
    from zone_loader import Zone

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
        "cdtaCollisionType": parsed.collision_type,
        "shapeCount": parsed.shape_count,
        "triangleCount": int(len(indices) // 3),
    }


def zone_instance_id(instance):
    """Read the stable Z1 instance ID across pydmod's zone-version layouts."""

    if instance.unk_int is not None:
        return int(instance.unk_int)
    # pydmod currently stores the v4/v5 ID together with the opaque tail.  The
    # authoritative Rust schema confirms the first four bytes are the ID.
    if instance.unk_data is not None and len(instance.unk_data) >= 4:
        return struct.unpack_from("<I", instance.unk_data, 0)[0]
    raise ValueError("zone instance has no decodable stable ID")


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _canonical_json_bytes(value):
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def parse_strict_bool(value, label):
    """Parse only explicit lowercase JSON boolean spellings."""

    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError(f"{label} must be exactly true or false")


def encode_h1cid1(instance_ids):
    """Encode the deterministic stable-instance-ID sidecar."""

    resolved = []
    for index, value in enumerate(instance_ids):
        integer = int(value)
        if integer != value or integer < 0 or integer > 0xFFFFFFFF:
            raise ValueError(f"instance ID {index} must fit uint32")
        resolved.append(integer)
    if len(set(resolved)) != len(resolved):
        raise ValueError("collision instances contain duplicate zone IDs")
    return (
        INSTANCE_IDS_MAGIC
        + struct.pack("<II", 1, len(resolved))
        + b"".join(struct.pack("<I", value) for value in resolved)
    )


def decode_h1cid1(data, *, expected_count=None):
    """Decode H1CID1 exactly; truncation and trailing bytes fail closed."""

    raw = bytes(data)
    if len(raw) < 16:
        raise ValueError("truncated H1CID1 header")
    magic, version, count = struct.unpack_from("<8sII", raw)
    if magic != INSTANCE_IDS_MAGIC:
        raise ValueError("invalid H1CID1 magic")
    if version != 1:
        raise ValueError(f"unsupported H1CID1 version {version}")
    required = 16 + count * 4
    if len(raw) < required:
        raise ValueError(
            f"truncated H1CID1 artifact: expected {required} bytes, got {len(raw)}"
        )
    if len(raw) > required:
        raise ValueError(
            f"trailing H1CID1 data: expected {required} bytes, got {len(raw)}"
        )
    if expected_count is not None and count != expected_count:
        raise ValueError(
            f"H1CID1 count mismatch: expected {expected_count}, got {count}"
        )
    values = tuple(struct.unpack_from(f"<{count}I", raw, 16)) if count else ()
    if len(set(values)) != len(values):
        raise ValueError("H1CID1 contains duplicate zone IDs")
    return values


def encode_h1col2(meshes, mesh_kinds, instance_mesh_indices, instance_data):
    """Encode the unchanged runtime H1COL2 v2 wire format."""

    if len(meshes) != len(mesh_kinds):
        raise ValueError("H1COL2 mesh/kind cardinality mismatch")
    instance_mesh = np.asarray(instance_mesh_indices, dtype="<u4")
    transforms = np.asarray(instance_data, dtype="<f4")
    if transforms.shape != (len(instance_mesh), 16):
        raise ValueError("H1COL2 instance data must contain 16 floats per instance")
    if len(instance_mesh) and int(instance_mesh.max()) >= len(meshes):
        raise ValueError("H1COL2 instance references an invalid mesh")

    output = BytesIO()
    output.write(MAGIC)
    output.write(struct.pack("<III", 2, len(meshes), len(instance_mesh)))
    for mesh_index, ((positions, indices), raw_kind) in enumerate(
        zip(meshes, mesh_kinds)
    ):
        kind = int(raw_kind)
        if kind != raw_kind or kind not in range(4):
            raise ValueError(f"H1COL2 mesh {mesh_index} has invalid kind {raw_kind}")
        pos = np.asarray(positions, dtype="<f4")
        idx = np.asarray(indices, dtype="<u4")
        if pos.ndim != 2 or pos.shape[1] != 3:
            raise ValueError(f"H1COL2 mesh {mesh_index} positions must be Nx3")
        if idx.ndim != 1 or len(idx) % 3:
            raise ValueError(f"H1COL2 mesh {mesh_index} indices must be triangles")
        if len(idx) and int(idx.max()) >= len(pos):
            raise ValueError(f"H1COL2 mesh {mesh_index} has an invalid index")
        output.write(struct.pack("<BII", kind, len(pos), len(idx)))
        output.write(pos.tobytes())
        output.write(idx.tobytes())
    output.write(instance_mesh.tobytes())
    output.write(transforms.tobytes())
    return output.getvalue()


def _semantic_histogram(values):
    counts = Counter(int(value) for value in values)
    return {
        SEMANTIC_TO_MATERIAL[SemanticId(semantic_id)]: counts[semantic_id]
        for semantic_id in sorted(counts)
    }


def build_collision_artifact_bundle(
    *,
    collision_name,
    instance_ids_name,
    semantics_name,
    policy_name,
    meshes,
    mesh_actors,
    mesh_sources,
    mesh_kinds,
    instance_mesh_indices,
    instance_data,
    instance_ids,
    inventory,
    policy_bytes,
    strict_production=False,
    dynamic_door_obstacles_acknowledged=False,
):
    """Build and validate one same-directory H1COL2 v4 artifact bundle."""

    mesh_count = len(meshes)
    if not (
        len(mesh_actors)
        == len(mesh_sources)
        == len(mesh_kinds)
        == mesh_count
    ):
        raise ValueError("collision mesh metadata cardinality mismatch")
    policy = decode_semantic_policy(policy_bytes)
    collision_bytes = encode_h1col2(
        meshes, mesh_kinds, instance_mesh_indices, instance_data
    )
    collision_digest = hashlib.sha256(collision_bytes).digest()
    collision_sha256 = collision_digest.hex()
    triangle_counts = tuple(len(indices) // 3 for _, indices in meshes)

    mesh_semantics = []
    for actor_file, source, kind, (positions, indices) in zip(
        mesh_actors, mesh_sources, mesh_kinds, meshes
    ):
        mesh_semantics.append(
            classify_mesh_triangles(
                policy,
                actor_file=actor_file,
                collision_asset_sha256=source["collisionSha256"],
                kind=int(kind),
                positions=positions,
                indices=indices,
                strict_production=strict_production,
            )
        )

    semantics_bytes = encode_h1sem1(
        collision_digest,
        mesh_semantics,
        mesh_triangle_counts=triangle_counts,
        strict_production=strict_production,
    )
    decoded_semantics = decode_h1sem1(
        semantics_bytes,
        expected_h1col2_sha256=collision_digest,
        expected_mesh_triangle_counts=triangle_counts,
        strict_production=strict_production,
    )
    if (
        encode_h1sem1(
            decoded_semantics.h1col2_sha256,
            [
                decoded_semantics.semantics_for_mesh(index)
                for index in range(decoded_semantics.mesh_count)
            ],
            mesh_triangle_counts=triangle_counts,
            strict_production=strict_production,
        )
        != semantics_bytes
    ):
        raise RuntimeError("H1SEM1 roundtrip changed encoded bytes")

    instance_ids_bytes = encode_h1cid1(instance_ids)
    decoded_instance_ids = decode_h1cid1(
        instance_ids_bytes, expected_count=len(instance_mesh_indices)
    )
    if encode_h1cid1(decoded_instance_ids) != instance_ids_bytes:
        raise RuntimeError("H1CID1 roundtrip changed encoded bytes")

    flattened_semantics = decoded_semantics.semantic_ids
    semantic_histogram = _semantic_histogram(flattened_semantics)
    unknown_count = flattened_semantics.count(SemanticId.UNKNOWN)
    instance_mesh = np.asarray(instance_mesh_indices, dtype=np.uint32)
    instance_counts = np.bincount(instance_mesh, minlength=mesh_count)
    per_mesh_histograms = [
        _semantic_histogram(decoded_semantics.semantics_for_mesh(index))
        for index in range(mesh_count)
    ]
    policy_sha256 = _sha256(policy.canonical_bytes)
    if policy.canonical_bytes != bytes(policy_bytes):
        raise ValueError("semantic policy payload differs from canonical bytes")

    if not isinstance(dynamic_door_obstacles_acknowledged, bool):
        raise ValueError("dynamic door obstacle acknowledgement must be boolean")
    limitations = [
        "Only exact actor, collision hash, kind, and triangle-count policy bindings may classify kind-0 or kind-2 geometry.",
        "Diagnostic bundles may contain nav_unknown and must not be consumed as production navigation.",
        "H1COL2 remains runtime format v2; H1SEM1 and H1CID1 are build-time sidecars.",
    ]
    if dynamic_door_obstacles_acknowledged:
        limitations.append(
            "Dynamic door-obstacle parity was explicitly acknowledged by the operator; this exporter does not prove runtime DoorEntity blocker coverage."
        )
    else:
        limitations.append(
            "Runtime dynamic door-obstacle parity is unproven; non-streaming navigation paths may bypass DoorEntity blockers."
        )

    metadata = {
        "schema": METADATA_SCHEMA,
        "formatVersion": 2,
        "coordinateSpace": COORDINATE_SPACE,
        "geometrySource": "adr_collision_cdta",
        "renderFallbackCount": 0,
        "semanticMode": "strict-production" if strict_production else "diagnostic",
        "limitations": limitations,
        "dynamicDoorObstaclesAcknowledged": dynamic_door_obstacles_acknowledged,
        "collisionFile": collision_name,
        "collisionSha256": collision_sha256,
        "meshCount": mesh_count,
        "instanceCount": len(instance_mesh_indices),
        "totalTriangleCount": sum(triangle_counts),
        "semanticHistogram": semantic_histogram,
        "unknownCount": unknown_count,
        "instanceIds": {
            "file": instance_ids_name,
            "sha256": _sha256(instance_ids_bytes),
            "format": H1CID1_FORMAT,
            "count": len(decoded_instance_ids),
        },
        "triangleSemantics": {
            "file": semantics_name,
            "sha256": _sha256(semantics_bytes),
            "format": H1SEM1_FORMAT,
            "semanticContract": SEMANTIC_CONTRACT,
            "semanticSchemaVersion": SEMANTIC_SCHEMA_VERSION,
            "collisionSha256": collision_sha256,
            "meshCount": mesh_count,
            "totalTriangleCount": len(flattened_semantics),
            "histogram": semantic_histogram,
            "unknownCount": unknown_count,
        },
        "semanticPolicy": {
            "schema": POLICY_SCHEMA,
            "file": policy_name,
            "sha256": policy_sha256,
        },
        "noCollisionActorCount": int(inventory["noCollisionActorTypes"]),
        "reviewedSkips": inventory["reviewedSkips"],
        "meshes": [
            {
                "meshIndex": index,
                "actorFile": mesh_actors[index],
                "collisionAsset": mesh_sources[index]["collisionAsset"],
                "collisionAssetSha256": mesh_sources[index]["collisionSha256"],
                "cdtaVersion": mesh_sources[index]["cdtaVersion"],
                "cdtaCollisionType": mesh_sources[index]["cdtaCollisionType"],
                "shapeCount": mesh_sources[index]["shapeCount"],
                "triangleCount": triangle_counts[index],
                "kind": int(mesh_kinds[index]),
                "semanticSource": "per_triangle_sidecar_v1",
                "semanticHistogram": per_mesh_histograms[index],
                "instanceCount": int(instance_counts[index]),
            }
            for index in range(mesh_count)
        ],
    }
    if strict_production and unknown_count:
        raise RuntimeError("strict production metadata cannot contain unknown semantics")

    artifacts = {
        collision_name: collision_bytes,
        instance_ids_name: instance_ids_bytes,
        semantics_name: semantics_bytes,
        policy_name: policy.canonical_bytes,
    }
    metadata_bytes = _canonical_json_bytes(metadata)
    return artifacts, metadata_bytes


def main():
    import export_z1_collision as exp  # applies all pack1 patches on import

    zc = exp.zone_converter
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
    inst_ids = []
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
            inst_ids.append(zone_instance_id(ins))
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
    inst_ids = np.asarray(inst_ids, dtype=np.uint32)
    inst_data = np.asarray(inst_data, dtype=np.float32)
    if len(np.unique(inst_ids)) != len(inst_ids):
        raise RuntimeError("decoded collision instances contain duplicate zone IDs")
    print(f"[inst] baked instances: {len(inst_mesh)}")

    instance_kinds = [
        int(sum(1 for mi in inst_mesh if mesh_kind[mi] == kind)) for kind in range(4)
    ]
    print(
        f"[inst] instance kinds: {instance_kinds[0]} walkable, "
        f"{instance_kinds[1]} solid, {instance_kinds[2]} thin, "
        f"{instance_kinds[3]} door"
    )

    # 3) build, decode/roundtrip, then atomically publish the hash-bound bundle.
    metadata_path = Path(METADATA_OUT) if METADATA_OUT else BIN.with_suffix(
        ".metadata.json"
    )
    instance_ids_path = (
        Path(INSTANCE_IDS_OUT)
        if INSTANCE_IDS_OUT
        else BIN.with_name(f"{BIN.stem}.instance_ids.bin")
    )
    semantics_path = (
        Path(SEMANTICS_OUT)
        if SEMANTICS_OUT
        else BIN.with_name(f"{BIN.stem}.semantics.bin")
    )
    bundle_root = BIN.parent.resolve()
    for label, path in (
        ("metadata", metadata_path),
        ("instance IDs", instance_ids_path),
        ("triangle semantics", semantics_path),
    ):
        if path.parent.resolve() != bundle_root:
            raise RuntimeError(
                f"{label} output must share the H1COL2 directory {bundle_root}"
            )
    if SEMANTIC_MODE not in ("diagnostic", "strict-production"):
        raise RuntimeError(
            "COLLISION_SEMANTIC_MODE must be diagnostic or strict-production"
        )
    policy = load_semantic_policy(SEMANTIC_POLICY_PATH)
    BIN.parent.mkdir(parents=True, exist_ok=True)
    artifacts, metadata_bytes = build_collision_artifact_bundle(
        collision_name=BIN.name,
        instance_ids_name=instance_ids_path.name,
        semantics_name=semantics_path.name,
        policy_name=SEMANTIC_POLICY_PATH.name,
        meshes=meshes,
        mesh_actors=mesh_actors,
        mesh_sources=mesh_sources,
        mesh_kinds=mesh_kind,
        instance_mesh_indices=inst_mesh,
        instance_data=inst_data,
        instance_ids=inst_ids,
        inventory=inventory,
        policy_bytes=policy.canonical_bytes,
        strict_production=SEMANTIC_MODE == "strict-production",
        dynamic_door_obstacles_acknowledged=parse_strict_bool(
            DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED,
            "COLLISION_DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED",
        ),
    )
    destinations = publish_artifact_bundle(
        BIN.parent,
        artifacts,
        metadata_path.name,
        metadata_bytes,
    )
    print(
        f"[inst] published {len(destinations) - 1} payloads + metadata last "
        f"in {BIN.parent} ({SEMANTIC_MODE})"
    )
    print(f"[inst] wrote {BIN} ({BIN.stat().st_size / 1e6:.1f} MB)")
    print(f"[inst] wrote stable instance IDs {instance_ids_path} ({len(inst_ids)} IDs)")
    print(f"[inst] wrote triangle semantics {semantics_path}")
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
