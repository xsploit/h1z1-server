"""Conservative actor-name classification for the Z1 collision dataset."""

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
