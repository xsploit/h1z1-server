"""Deterministic, fail-closed per-triangle semantics for H1COL2 meshes.

Production rules are exact actor/source bindings.  Actor-name keywords are not
accepted as semantic evidence: an unlisted kind-0 or kind-2 mesh becomes
``UNKNOWN`` and therefore fails strict production validation.  The two v1
geometry strategies intentionally cover only the reviewed Z1 road and simple
surface assets recorded in ``policies/z1_collision.semantic_policy.json``.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence

from h1sem import SemanticId


POLICY_SCHEMA = "h1emu-h1col2-semantic-policy-v1"
SEMANTIC_CONTRACT = "h1emu-nav-semantics-v1"
SEMANTIC_SCHEMA_VERSION = 1
COORDINATE_SPACE = "h1z1-world-y-up-meters"

MATERIAL_TO_SEMANTIC = MappingProxyType(
    {
        "nav_terrain": SemanticId.TERRAIN,
        "nav_road": SemanticId.ROAD,
        "nav_floor_exterior": SemanticId.FLOOR_EXTERIOR,
        "nav_floor_interior": SemanticId.FLOOR_INTERIOR,
        "nav_stair": SemanticId.STAIR,
        "nav_ramp": SemanticId.RAMP,
        "nav_threshold": SemanticId.THRESHOLD,
        "nav_obstacle_static": SemanticId.OBSTACLE_STATIC,
        "nav_door_panel_dynamic": SemanticId.DOOR_PANEL_DYNAMIC,
        "nav_exclude": SemanticId.EXCLUDE,
        "nav_unknown": SemanticId.UNKNOWN,
    }
)
SEMANTIC_TO_MATERIAL = MappingProxyType(
    {semantic: material for material, semantic in MATERIAL_TO_SEMANTIC.items()}
)

_EXPECTED_DEFAULTS = MappingProxyType(
    {
        "kind0": SemanticId.UNKNOWN,
        "kind1": SemanticId.OBSTACLE_STATIC,
        "kind2": SemanticId.UNKNOWN,
        "kind3": SemanticId.DOOR_PANEL_DYNAMIC,
    }
)
_ALLOWED_BY_KIND = MappingProxyType(
    {
        0: frozenset(
            {
                SemanticId.ROAD,
                SemanticId.FLOOR_EXTERIOR,
                SemanticId.FLOOR_INTERIOR,
                SemanticId.STAIR,
                SemanticId.RAMP,
                SemanticId.THRESHOLD,
                SemanticId.OBSTACLE_STATIC,
                SemanticId.EXCLUDE,
                SemanticId.UNKNOWN,
            }
        ),
        1: frozenset({SemanticId.OBSTACLE_STATIC}),
        2: frozenset(
            {SemanticId.OBSTACLE_STATIC, SemanticId.EXCLUDE, SemanticId.UNKNOWN}
        ),
        3: frozenset({SemanticId.DOOR_PANEL_DYNAMIC}),
    }
)
_WALKABLE_SURFACE_IDS = frozenset(
    {
        SemanticId.ROAD,
        SemanticId.FLOOR_EXTERIOR,
        SemanticId.FLOOR_INTERIOR,
        SemanticId.STAIR,
        SemanticId.RAMP,
        SemanticId.THRESHOLD,
    }
)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_NORMAL_EPSILON = 1e-12


class SemanticPolicyError(ValueError):
    """Raised when a policy or mesh violates the v1 semantic contract."""


@dataclass(frozen=True)
class SemanticRule:
    actor_file: str
    collision_asset_sha256: str
    kind: int
    triangle_count: int
    strategy: str
    semantic: SemanticId | None = None
    surface_semantic: SemanticId | None = None
    slope_limit_degrees: int | None = None
    precondition: str | None = None


@dataclass(frozen=True)
class CollisionSemanticPolicy:
    canonical_bytes: bytes
    sha256: str
    defaults: tuple[SemanticId, SemanticId, SemanticId, SemanticId]
    rules: tuple[SemanticRule, ...]
    rules_by_actor: Mapping[str, SemanticRule]

    def rule_for_actor(self, actor_file: str) -> SemanticRule | None:
        return self.rules_by_actor.get(actor_file.casefold())


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SemanticPolicyError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _validate_json_domain(value: Any, label: str = "policy") -> None:
    """Keep Python and JavaScript canonicalization on an unambiguous domain."""

    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9_007_199_254_740_991:
            raise SemanticPolicyError(f"{label} integer exceeds JSON safe range")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_domain(item, f"{label}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise SemanticPolicyError(f"{label} has a non-string key")
            _validate_json_domain(item, f"{label}.{key}")
        return
    raise SemanticPolicyError(
        f"{label} contains unsupported JSON value type {type(value).__name__}"
    )


def canonical_policy_bytes(value: Mapping[str, Any]) -> bytes:
    """Return the cross-runtime canonical v1 JSON representation."""

    if not isinstance(value, Mapping):
        raise SemanticPolicyError("semantic policy root must be an object")
    plain = dict(value)
    _validate_json_domain(plain)
    return (
        json.dumps(
            plain,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        + b"\n"
    )


def _semantic(material: Any, label: str) -> SemanticId:
    if not isinstance(material, str) or material not in MATERIAL_TO_SEMANTIC:
        raise SemanticPolicyError(f"{label} has invalid semantic material {material!r}")
    return MATERIAL_TO_SEMANTIC[material]


def semantic_compatible_with_kind(kind: int, semantic: SemanticId) -> bool:
    return kind in _ALLOWED_BY_KIND and semantic in _ALLOWED_BY_KIND[kind]


def _required_rule_keys(strategy: str, kind: int, semantic: SemanticId | None) -> set[str]:
    base = {
        "actorFile",
        "collisionAssetSha256",
        "kind",
        "strategy",
        "triangleCount",
    }
    if strategy == "negative_y_surface_else_exclude":
        return base | {"slopeLimitDegrees", "surfaceSemantic"}
    if strategy == "uniform":
        keys = base | {"semantic"}
        if kind == 0 and semantic in _WALKABLE_SURFACE_IDS:
            keys.add("precondition")
        return keys
    raise SemanticPolicyError(f"unsupported semantic strategy {strategy!r}")


def _parse_rule(value: Any, index: int) -> SemanticRule:
    label = f"rules[{index}]"
    if not isinstance(value, dict):
        raise SemanticPolicyError(f"{label} must be an object")
    actor_file = value.get("actorFile")
    source_hash = value.get("collisionAssetSha256")
    kind = value.get("kind")
    triangle_count = value.get("triangleCount")
    strategy = value.get("strategy")
    if not isinstance(actor_file, str) or not actor_file or not actor_file.lower().endswith(
        ".adr"
    ):
        raise SemanticPolicyError(f"{label}.actorFile must be a non-empty ADR name")
    if any(token in actor_file for token in ("*", "?", "[", "]")):
        raise SemanticPolicyError(f"{label}.actorFile must be an exact actor name")
    if not isinstance(source_hash, str) or not _SHA256.fullmatch(source_hash):
        raise SemanticPolicyError(
            f"{label}.collisionAssetSha256 must be lowercase SHA256"
        )
    if not isinstance(kind, int) or isinstance(kind, bool) or kind not in range(4):
        raise SemanticPolicyError(f"{label}.kind must be an H1COL2 kind 0..3")
    if (
        not isinstance(triangle_count, int)
        or isinstance(triangle_count, bool)
        or triangle_count <= 0
    ):
        raise SemanticPolicyError(f"{label}.triangleCount must be positive")
    if not isinstance(strategy, str):
        raise SemanticPolicyError(f"{label}.strategy must be a string")

    semantic = None
    surface_semantic = None
    slope_limit_degrees = None
    precondition = None
    if strategy == "uniform":
        semantic = _semantic(value.get("semantic"), f"{label}.semantic")
        if not semantic_compatible_with_kind(kind, semantic):
            raise SemanticPolicyError(
                f"{label} semantic {SEMANTIC_TO_MATERIAL[semantic]} is unsafe for kind {kind}"
            )
        if kind == 0 and semantic in _WALKABLE_SURFACE_IDS:
            precondition = value.get("precondition")
            if precondition != "all_negative_y_slope_45":
                raise SemanticPolicyError(
                    f"{label} walkable uniform rule requires "
                    "all_negative_y_slope_45 precondition"
                )
    elif strategy == "negative_y_surface_else_exclude":
        if kind != 0:
            raise SemanticPolicyError(f"{label} surface strategy requires kind 0")
        surface_semantic = _semantic(
            value.get("surfaceSemantic"), f"{label}.surfaceSemantic"
        )
        if surface_semantic not in _WALKABLE_SURFACE_IDS:
            raise SemanticPolicyError(
                f"{label}.surfaceSemantic must be a walkable surface semantic"
            )
        slope_limit_degrees = value.get("slopeLimitDegrees")
        if (
            not isinstance(slope_limit_degrees, int)
            or isinstance(slope_limit_degrees, bool)
            or slope_limit_degrees <= 0
            or slope_limit_degrees >= 90
        ):
            raise SemanticPolicyError(
                f"{label}.slopeLimitDegrees must be an integer in 1..89"
            )

    expected_keys = _required_rule_keys(strategy, kind, semantic)
    if set(value) != expected_keys:
        raise SemanticPolicyError(
            f"{label} fields do not match {strategy} contract: "
            f"expected {sorted(expected_keys)}, got {sorted(value)}"
        )
    return SemanticRule(
        actor_file=actor_file,
        collision_asset_sha256=source_hash,
        kind=kind,
        triangle_count=triangle_count,
        strategy=strategy,
        semantic=semantic,
        surface_semantic=surface_semantic,
        slope_limit_degrees=slope_limit_degrees,
        precondition=precondition,
    )


def decode_semantic_policy(data: bytes | bytearray | memoryview) -> CollisionSemanticPolicy:
    """Parse, canonicalize, and fully validate one v1 policy artifact."""

    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise SemanticPolicyError("semantic policy must be bytes-like")
    raw = bytes(data)
    if raw.startswith(b"\xef\xbb\xbf"):
        raise SemanticPolicyError("semantic policy must not contain a UTF-8 BOM")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SemanticPolicyError("semantic policy must be valid UTF-8") from error
    try:
        value = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except SemanticPolicyError:
        raise
    except json.JSONDecodeError as error:
        raise SemanticPolicyError(f"invalid semantic policy JSON: {error}") from error
    if not isinstance(value, dict):
        raise SemanticPolicyError("semantic policy root must be an object")
    canonical = canonical_policy_bytes(value)
    if raw != canonical:
        raise SemanticPolicyError(
            "semantic policy bytes are not canonical compact sorted JSON plus LF"
        )

    expected_top = {
        "coordinateSpace",
        "defaults",
        "rules",
        "schema",
        "semanticContract",
        "semanticSchemaVersion",
    }
    if set(value) != expected_top:
        raise SemanticPolicyError("semantic policy top-level fields are invalid")
    if value["schema"] != POLICY_SCHEMA:
        raise SemanticPolicyError(f"unsupported semantic policy schema {value['schema']!r}")
    if value["semanticContract"] != SEMANTIC_CONTRACT:
        raise SemanticPolicyError("semantic policy semantic contract is invalid")
    if value["semanticSchemaVersion"] != SEMANTIC_SCHEMA_VERSION:
        raise SemanticPolicyError("semantic policy semantic schema version is invalid")
    if value["coordinateSpace"] != COORDINATE_SPACE:
        raise SemanticPolicyError("semantic policy coordinate space is invalid")

    raw_defaults = value["defaults"]
    if not isinstance(raw_defaults, dict) or set(raw_defaults) != set(_EXPECTED_DEFAULTS):
        raise SemanticPolicyError("semantic policy defaults are invalid")
    defaults = tuple(
        _semantic(raw_defaults[f"kind{kind}"], f"defaults.kind{kind}")
        for kind in range(4)
    )
    if defaults != tuple(_EXPECTED_DEFAULTS[f"kind{kind}"] for kind in range(4)):
        raise SemanticPolicyError("semantic policy defaults do not fail closed")

    raw_rules = value["rules"]
    if not isinstance(raw_rules, list):
        raise SemanticPolicyError("semantic policy rules must be an array")
    rules = tuple(_parse_rule(rule, index) for index, rule in enumerate(raw_rules))
    folded_names = tuple(rule.actor_file.casefold() for rule in rules)
    if folded_names != tuple(sorted(folded_names)):
        raise SemanticPolicyError("semantic policy rules are not sorted by actorFile")
    if len(set(folded_names)) != len(folded_names):
        raise SemanticPolicyError("semantic policy contains duplicate actorFile rules")
    by_actor = MappingProxyType(dict(zip(folded_names, rules)))
    return CollisionSemanticPolicy(
        canonical_bytes=canonical,
        sha256=hashlib.sha256(canonical).hexdigest(),
        defaults=defaults,  # type: ignore[arg-type]
        rules=rules,
        rules_by_actor=by_actor,
    )


def load_semantic_policy(path: str | Path) -> CollisionSemanticPolicy:
    return decode_semantic_policy(Path(path).read_bytes())


def _position_accessor(positions: Any) -> tuple[int, Callable[[int], tuple[float, float, float]]]:
    shape = getattr(positions, "shape", None)
    if shape is not None and len(shape) == 2:
        if int(shape[1]) != 3:
            raise SemanticPolicyError("positions must have shape (vertexCount, 3)")
        vertex_count = int(shape[0])

        def get_matrix(index: int) -> tuple[float, float, float]:
            return (
                float(positions[index][0]),
                float(positions[index][1]),
                float(positions[index][2]),
            )

        return vertex_count, get_matrix

    try:
        count = len(positions)
    except TypeError as error:
        raise SemanticPolicyError("positions must be a sized sequence") from error
    if count and isinstance(positions[0], Sequence):
        for index, value in enumerate(positions):
            if len(value) != 3:
                raise SemanticPolicyError(f"positions[{index}] must have 3 components")

        def get_nested(index: int) -> tuple[float, float, float]:
            return tuple(float(value) for value in positions[index])  # type: ignore[return-value]

        return count, get_nested
    if count % 3 != 0:
        raise SemanticPolicyError("flat positions length must be divisible by 3")

    def get_flat(index: int) -> tuple[float, float, float]:
        offset = index * 3
        return (
            float(positions[offset]),
            float(positions[offset + 1]),
            float(positions[offset + 2]),
        )

    return count // 3, get_flat


def _triangle_normal_y(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    c: tuple[float, float, float],
) -> tuple[float, float]:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    return ny, length


def _validated_triangles(
    positions: Any,
    indices: Any,
    expected_triangle_count: int,
) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    vertex_count, get_position = _position_accessor(positions)
    try:
        index_count = len(indices)
    except TypeError as error:
        raise SemanticPolicyError("indices must be a sized sequence") from error
    if index_count != expected_triangle_count * 3:
        raise SemanticPolicyError(
            "mesh triangle count mismatch: "
            f"expected {expected_triangle_count}, got {index_count // 3}"
        )
    triangles = []
    for triangle_index in range(expected_triangle_count):
        raw_indices = indices[triangle_index * 3 : triangle_index * 3 + 3]
        resolved = []
        for component, raw_index in enumerate(raw_indices):
            index = int(raw_index)
            if index != raw_index or index < 0 or index >= vertex_count:
                raise SemanticPolicyError(
                    f"triangle {triangle_index} index {component} is out of range"
                )
            vertex = get_position(index)
            if not all(math.isfinite(value) for value in vertex):
                raise SemanticPolicyError(
                    f"triangle {triangle_index} contains a non-finite position"
                )
            resolved.append(vertex)
        triangles.append((resolved[0], resolved[1], resolved[2]))
    return triangles


def _validate_output(kind: int, semantic_ids: bytes, strict_production: bool) -> None:
    for triangle_index, value in enumerate(semantic_ids):
        semantic = SemanticId(value)
        if not semantic_compatible_with_kind(kind, semantic):
            raise SemanticPolicyError(
                f"triangle {triangle_index} semantic {SEMANTIC_TO_MATERIAL[semantic]} "
                f"is unsafe for H1COL2 kind {kind}"
            )
        if strict_production and semantic == SemanticId.UNKNOWN:
            raise SemanticPolicyError(
                f"production semantics contain unknown triangle {triangle_index}"
            )


def classify_mesh_triangles(
    policy: CollisionSemanticPolicy,
    *,
    actor_file: str,
    collision_asset_sha256: str,
    kind: int,
    positions: Any,
    indices: Any,
    strict_production: bool = False,
) -> bytes:
    """Classify one exact collision mesh without actor-name inference."""

    if not isinstance(actor_file, str) or not actor_file:
        raise SemanticPolicyError("actor_file must be non-empty")
    if not isinstance(collision_asset_sha256, str) or not _SHA256.fullmatch(
        collision_asset_sha256
    ):
        raise SemanticPolicyError("collision_asset_sha256 must be lowercase SHA256")
    if not isinstance(kind, int) or isinstance(kind, bool) or kind not in range(4):
        raise SemanticPolicyError("kind must be an H1COL2 kind 0..3")
    try:
        index_count = len(indices)
    except TypeError as error:
        raise SemanticPolicyError("indices must be a sized sequence") from error
    if index_count % 3 != 0:
        raise SemanticPolicyError("indices length must be divisible by 3")
    triangle_count = index_count // 3

    rule = policy.rule_for_actor(actor_file)
    if rule is None:
        semantic_ids = bytes((policy.defaults[kind],)) * triangle_count
        _validate_output(kind, semantic_ids, strict_production)
        return semantic_ids
    if rule.actor_file.casefold() != actor_file.casefold():
        raise SemanticPolicyError("semantic rule actor binding mismatch")
    if rule.collision_asset_sha256 != collision_asset_sha256:
        raise SemanticPolicyError(
            f"semantic rule collision hash mismatch for {actor_file}"
        )
    if rule.kind != kind:
        raise SemanticPolicyError(f"semantic rule kind mismatch for {actor_file}")
    if rule.triangle_count != triangle_count:
        raise SemanticPolicyError(
            f"semantic rule triangle count mismatch for {actor_file}: "
            f"expected {rule.triangle_count}, got {triangle_count}"
        )

    triangles = _validated_triangles(positions, indices, rule.triangle_count)
    if rule.strategy == "uniform":
        assert rule.semantic is not None
        if rule.precondition == "all_negative_y_slope_45":
            threshold = -math.cos(math.radians(45))
            for triangle_index, triangle in enumerate(triangles):
                normal_y, length = _triangle_normal_y(*triangle)
                if length <= _NORMAL_EPSILON:
                    raise SemanticPolicyError(
                        f"uniform road {actor_file} has degenerate triangle {triangle_index}"
                    )
                if normal_y / length > threshold + 1e-12:
                    raise SemanticPolicyError(
                        f"uniform road {actor_file} triangle {triangle_index} "
                        "violates negative-Y slope precondition"
                    )
        semantic_ids = bytes((rule.semantic,)) * triangle_count
    elif rule.strategy == "negative_y_surface_else_exclude":
        assert rule.surface_semantic is not None
        assert rule.slope_limit_degrees is not None
        threshold = -math.cos(math.radians(rule.slope_limit_degrees))
        result = bytearray()
        surface_count = 0
        for triangle in triangles:
            normal_y, length = _triangle_normal_y(*triangle)
            if length > _NORMAL_EPSILON and normal_y / length <= threshold + 1e-12:
                result.append(rule.surface_semantic)
                surface_count += 1
            else:
                result.append(SemanticId.EXCLUDE)
        if surface_count == 0:
            raise SemanticPolicyError(
                f"surface rule for {actor_file} selected no negative-Y triangles"
            )
        semantic_ids = bytes(result)
    else:  # pragma: no cover - loader makes this unreachable
        raise SemanticPolicyError(f"unsupported semantic strategy {rule.strategy}")

    _validate_output(kind, semantic_ids, strict_production)
    return semantic_ids


__all__ = [
    "COORDINATE_SPACE",
    "CollisionSemanticPolicy",
    "MATERIAL_TO_SEMANTIC",
    "POLICY_SCHEMA",
    "SEMANTIC_CONTRACT",
    "SEMANTIC_SCHEMA_VERSION",
    "SEMANTIC_TO_MATERIAL",
    "SemanticPolicyError",
    "SemanticRule",
    "canonical_policy_bytes",
    "classify_mesh_triangles",
    "decode_semantic_policy",
    "load_semantic_policy",
    "semantic_compatible_with_kind",
]
