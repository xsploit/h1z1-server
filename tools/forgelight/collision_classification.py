"""Conservative actor-name classification for the Z1 collision dataset.

The numeric kind is the compact runtime contract stored in H1COL2.  The
semantic material is the richer, optional build-time hint written alongside a
new H1COL2 export.  It never promotes a non-walkable kind to a walkable Recast
area.
"""

# Per-mesh kind:
#   0 = walkable ground
#   1 = solid obstacle, carved from the navmesh
#   2 = non-walkable, not carved
#   3 = door/gate, excluded so its opening remains navigable

DOOR_KEYWORDS = ("door", "gate", "garagedoor")
SOLID_KEYWORDS = (
    "wreck",
    "barrier",
    "hesco",
    "sandbag",
    "boulder",
    "rock",
)
NON_WALKABLE_KEYWORDS = (
    "wall",
    "fence",
    "barbedwire",
    "rail",
    "post",
    "pole",
    "roof",
    "support",
    "roadmarking",
    "bumper",
)
WALKABLE_KEYWORDS = (
    "sidewalk",
    "roadintersection",
    "roadstraight",
    "roadcurve",
    "roadtunnel",
    "_floor",
    "foundation",
    "bridge",
    "_ramp",
    "_stair",
    "platform",
    "walkway",
    "drivewayslab",
    "garage_slab",
    "_deck",
    "_porch",
    "dam_road",
    "loadingbay",
)
WALKABLE_STRUCTURE_PREFIXES = (
    "common_structures_houses_",
    "common_structures_apartments_",
    "common_structures_warehouse",
    "common_structures_office",
    "common_structures_gasmart",
    "common_structures_store",
    "common_structures_tavern",
    "common_structures_restaurant",
    "common_structures_supermarket",
    "common_structures_policestation",
    "common_structures_firehouse",
    "common_structures_church_",
    "common_structures_hardwarestore",
    "common_structures_mobilehome",
    "common_structures_carwash",
    "common_structures_carrepairexterior",
    "common_structures_royolinegas",
    "hospital_structures_floor",
    "hospital_structures_lobby",
    "hospital_structures_basement",
)

KIND_SEMANTICS = {
    1: "nav_obstacle_static",
    2: "nav_obstacle_static",
    3: "nav_door_panel_dynamic",
}


def classify(actor_file: str) -> int:
    name = actor_file.lower()
    if any(keyword in name for keyword in DOOR_KEYWORDS):
        return 3
    if any(keyword in name for keyword in SOLID_KEYWORDS):
        return 1
    if any(keyword in name for keyword in NON_WALKABLE_KEYWORDS):
        return 2
    if any(keyword in name for keyword in WALKABLE_KEYWORDS):
        return 0
    if name.startswith(WALKABLE_STRUCTURE_PREFIXES):
        return 0
    return 2


def semantic_material(actor_file: str, kind: int | None = None) -> str:
    """Return the canonical semantic material for an H1COL2 actor mesh.

    H1COL2 stores one kind per merged actor mesh, not per connected component,
    so the walkable mapping is deliberately coarse.  Roads, stairs, ramps and
    explicit interior floors retain useful area identities; every other
    walkable mesh is an exterior floor.  Non-walkable and door kinds are fixed
    by the numeric binary contract and cannot be overridden by the actor name.
    """

    resolved_kind = classify(actor_file) if kind is None else kind
    if resolved_kind in KIND_SEMANTICS:
        return KIND_SEMANTICS[resolved_kind]
    if resolved_kind != 0:
        raise ValueError(f"unsupported H1COL2 mesh kind: {resolved_kind}")

    name = actor_file.lower()
    if any(
        token in name
        for token in (
            "roadintersection",
            "roadstraight",
            "roadcurve",
            "roadtunnel",
            "dam_road",
        )
    ):
        return "nav_road"
    if "_stair" in name or "stairs" in name:
        return "nav_stair"
    if "_ramp" in name or "ramp_" in name:
        return "nav_ramp"
    if "threshold" in name:
        return "nav_threshold"
    if "interior" in name and "floor" in name:
        return "nav_floor_interior"
    return "nav_floor_exterior"
