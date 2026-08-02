import json
from pathlib import Path
import struct
import sys
import unittest


FORGELIGHT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FORGELIGHT_DIR))

from collision_semantic_policy import (  # noqa: E402
    COORDINATE_SPACE,
    POLICY_SCHEMA,
    SEMANTIC_CONTRACT,
    SEMANTIC_SCHEMA_VERSION,
    SemanticPolicyError,
    canonical_policy_bytes,
    classify_mesh_triangles,
    decode_semantic_policy,
    load_semantic_policy,
    semantic_compatible_with_kind,
)
from h1sem import SemanticId  # noqa: E402


POLICY_PATH = FORGELIGHT_DIR / "policies" / "z1_collision.semantic_policy.json"
POLICY_SHA256 = "00111124dd7cb520a7dd6ea64b3707e85d5653c726cfd5140ae7a0e6cf826255"
HASH_A = "a" * 64
HASH_B = "b" * 64


def policy_value(rules=()):
    return {
        "coordinateSpace": COORDINATE_SPACE,
        "defaults": {
            "kind0": "nav_unknown",
            "kind1": "nav_obstacle_static",
            "kind2": "nav_unknown",
            "kind3": "nav_door_panel_dynamic",
        },
        "rules": list(rules),
        "schema": POLICY_SCHEMA,
        "semanticContract": SEMANTIC_CONTRACT,
        "semanticSchemaVersion": SEMANTIC_SCHEMA_VERSION,
    }


def uniform_rule(
    actor="Road_Test.adr",
    *,
    source_hash=HASH_A,
    kind=0,
    semantic="nav_road",
    triangle_count=1,
):
    rule = {
        "actorFile": actor,
        "collisionAssetSha256": source_hash,
        "kind": kind,
        "semantic": semantic,
        "strategy": "uniform",
        "triangleCount": triangle_count,
    }
    if kind == 0 and semantic in {
        "nav_road",
        "nav_floor_exterior",
        "nav_floor_interior",
        "nav_stair",
        "nav_ramp",
        "nav_threshold",
    }:
        rule["precondition"] = "all_negative_y_slope_45"
    return rule


def surface_rule(actor="Surface_Test.adr", *, triangle_count=1):
    return {
        "actorFile": actor,
        "collisionAssetSha256": HASH_A,
        "kind": 0,
        "slopeLimitDegrees": 45,
        "strategy": "negative_y_surface_else_exclude",
        "surfaceSemantic": "nav_floor_exterior",
        "triangleCount": triangle_count,
    }


def decoded_policy(rules=()):
    ordered = sorted(rules, key=lambda rule: rule["actorFile"].casefold())
    return decode_semantic_policy(canonical_policy_bytes(policy_value(ordered)))


DOWN_POSITIONS = ((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0))
UP_POSITIONS = ((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
ONE_TRIANGLE = (0, 1, 2)


def classify(
    policy,
    actor_file,
    *,
    source_hash=HASH_A,
    kind=0,
    positions=DOWN_POSITIONS,
    indices=ONE_TRIANGLE,
    strict=False,
):
    return classify_mesh_triangles(
        policy,
        actor_file=actor_file,
        collision_asset_sha256=source_hash,
        kind=kind,
        positions=positions,
        indices=indices,
        strict_production=strict,
    )


def read_selected_h1col2(path, selected_indices):
    raw = path.read_bytes()
    if raw[:8] != b"H1COL2\0\0":
        raise AssertionError("bad fixture H1COL2 magic")
    version, mesh_count, _instance_count = struct.unpack_from("<III", raw, 8)
    if version != 2:
        raise AssertionError("bad fixture H1COL2 version")
    offset = 20
    selected = {}
    for mesh_index in range(mesh_count):
        kind, vertex_count, index_count = struct.unpack_from("<BII", raw, offset)
        offset += 9
        positions_bytes = vertex_count * 12
        indices_bytes = index_count * 4
        if mesh_index in selected_indices:
            positions = tuple(
                triple
                for triple in struct.iter_unpack(
                    "<fff", raw[offset : offset + positions_bytes]
                )
            )
            indices = struct.unpack_from(
                f"<{index_count}I", raw, offset + positions_bytes
            )
            selected[mesh_index] = (kind, positions, indices)
        offset += positions_bytes + indices_bytes
    return selected


class CanonicalPolicyTests(unittest.TestCase):
    def test_checked_in_policy_is_canonical_and_pinned(self):
        raw = POLICY_PATH.read_bytes()
        policy = load_semantic_policy(POLICY_PATH)
        self.assertEqual(raw, policy.canonical_bytes)
        self.assertEqual(policy.sha256, POLICY_SHA256)
        self.assertEqual(len(policy.rules), 90)
        self.assertEqual(
            sum(rule.strategy == "uniform" for rule in policy.rules), 55
        )
        self.assertEqual(
            sum(
                rule.strategy == "negative_y_surface_else_exclude"
                for rule in policy.rules
            ),
            34,
        )

    def test_rejects_noncanonical_bytes_bom_and_duplicate_keys(self):
        canonical = canonical_policy_bytes(policy_value())
        with self.assertRaisesRegex(SemanticPolicyError, "not canonical"):
            decode_semantic_policy(canonical[:-1] + b" \n")
        with self.assertRaisesRegex(SemanticPolicyError, "must not contain"):
            decode_semantic_policy(b"\xef\xbb\xbf" + canonical)
        with self.assertRaisesRegex(SemanticPolicyError, "duplicate JSON object key"):
            decode_semantic_policy(b'{"schema":"a","schema":"b"}\n')

    def test_rejects_float_domain_and_invalid_root_contract(self):
        value = policy_value()
        value["semanticSchemaVersion"] = 1.0
        with self.assertRaisesRegex(SemanticPolicyError, "unsupported JSON value"):
            canonical_policy_bytes(value)

        mutations = (
            ("schema", "wrong", "unsupported semantic policy schema"),
            ("semanticContract", "wrong", "semantic contract is invalid"),
            ("semanticSchemaVersion", 2, "schema version is invalid"),
            ("coordinateSpace", "wrong", "coordinate space is invalid"),
        )
        for key, replacement, expected in mutations:
            with self.subTest(key=key):
                value = policy_value()
                value[key] = replacement
                with self.assertRaisesRegex(SemanticPolicyError, expected):
                    decode_semantic_policy(canonical_policy_bytes(value))

    def test_rejects_non_fail_closed_defaults(self):
        value = policy_value()
        value["defaults"]["kind0"] = "nav_floor_exterior"
        with self.assertRaisesRegex(SemanticPolicyError, "do not fail closed"):
            decode_semantic_policy(canonical_policy_bytes(value))

    def test_rejects_unsorted_duplicate_or_wildcard_actor_rules(self):
        value = policy_value(
            (uniform_rule("Zulu.adr"), uniform_rule("Alpha.adr", source_hash=HASH_B))
        )
        with self.assertRaisesRegex(SemanticPolicyError, "not sorted"):
            decode_semantic_policy(canonical_policy_bytes(value))

        duplicate = policy_value(
            (uniform_rule("same.adr"), uniform_rule("SAME.adr", source_hash=HASH_B))
        )
        with self.assertRaisesRegex(SemanticPolicyError, "duplicate actorFile"):
            decode_semantic_policy(canonical_policy_bytes(duplicate))

        wildcard = policy_value((uniform_rule("Road*.adr"),))
        with self.assertRaisesRegex(SemanticPolicyError, "exact actor name"):
            decode_semantic_policy(canonical_policy_bytes(wildcard))

    def test_rejects_invalid_rule_fields_and_semantic_kind_pairs(self):
        bad_hash = uniform_rule()
        bad_hash["collisionAssetSha256"] = "A" * 64
        with self.assertRaisesRegex(SemanticPolicyError, "lowercase SHA256"):
            decode_semantic_policy(canonical_policy_bytes(policy_value((bad_hash,))))

        kind_one_excluded = uniform_rule(
            "Solid.adr", kind=1, semantic="nav_exclude"
        )
        with self.assertRaisesRegex(SemanticPolicyError, "unsafe for kind 1"):
            decode_semantic_policy(
                canonical_policy_bytes(policy_value((kind_one_excluded,)))
            )

        kind_three_obstacle = uniform_rule(
            "Door.adr", kind=3, semantic="nav_obstacle_static"
        )
        with self.assertRaisesRegex(SemanticPolicyError, "unsafe for kind 3"):
            decode_semantic_policy(
                canonical_policy_bytes(policy_value((kind_three_obstacle,)))
            )

        missing_precondition = uniform_rule()
        del missing_precondition["precondition"]
        with self.assertRaisesRegex(SemanticPolicyError, "requires"):
            decode_semantic_policy(
                canonical_policy_bytes(policy_value((missing_precondition,)))
            )


class CompatibilityAndClassificationTests(unittest.TestCase):
    def test_exact_semantic_kind_compatibility_matrix(self):
        expected = {
            0: {
                SemanticId.ROAD,
                SemanticId.FLOOR_EXTERIOR,
                SemanticId.FLOOR_INTERIOR,
                SemanticId.STAIR,
                SemanticId.RAMP,
                SemanticId.THRESHOLD,
                SemanticId.OBSTACLE_STATIC,
                SemanticId.EXCLUDE,
                SemanticId.UNKNOWN,
            },
            1: {SemanticId.OBSTACLE_STATIC},
            2: {SemanticId.OBSTACLE_STATIC, SemanticId.EXCLUDE, SemanticId.UNKNOWN},
            3: {SemanticId.DOOR_PANEL_DYNAMIC},
        }
        for kind in range(4):
            for semantic in SemanticId:
                if semantic == SemanticId.INVALID:
                    continue
                with self.subTest(kind=kind, semantic=semantic):
                    self.assertEqual(
                        semantic_compatible_with_kind(kind, semantic),
                        semantic in expected[kind],
                    )

    def test_unmatched_kind_zero_and_two_are_unknown_and_strict_fails(self):
        policy = decoded_policy()
        for kind in (0, 2):
            with self.subTest(kind=kind):
                self.assertEqual(
                    classify(policy, "Unlisted.adr", kind=kind),
                    bytes((SemanticId.UNKNOWN,)),
                )
                with self.assertRaisesRegex(SemanticPolicyError, "unknown triangle"):
                    classify(policy, "Unlisted.adr", kind=kind, strict=True)

    def test_unmatched_solid_and_door_follow_fixed_numeric_contract(self):
        policy = decoded_policy()
        self.assertEqual(
            classify(policy, "Solid.adr", kind=1, strict=True),
            bytes((SemanticId.OBSTACLE_STATIC,)),
        )
        self.assertEqual(
            classify(policy, "Door.adr", kind=3, strict=True),
            bytes((SemanticId.DOOR_PANEL_DYNAMIC,)),
        )

    def test_exact_kind_two_uniform_rule_can_only_resolve_reviewed_actor(self):
        rule = uniform_rule("Fence.adr", kind=2, semantic="nav_obstacle_static")
        policy = decoded_policy((rule,))
        self.assertEqual(
            classify(policy, "Fence.adr", kind=2, strict=True),
            bytes((SemanticId.OBSTACLE_STATIC,)),
        )
        self.assertEqual(
            classify(policy, "OtherFence.adr", kind=2),
            bytes((SemanticId.UNKNOWN,)),
        )

    def test_uniform_road_requires_exact_binding_and_negative_y_geometry(self):
        policy = decoded_policy((uniform_rule(),))
        self.assertEqual(
            classify(policy, "road_test.ADR", strict=True),
            bytes((SemanticId.ROAD,)),
        )
        with self.assertRaisesRegex(SemanticPolicyError, "collision hash mismatch"):
            classify(policy, "Road_Test.adr", source_hash=HASH_B)
        with self.assertRaisesRegex(SemanticPolicyError, "kind mismatch"):
            classify(policy, "Road_Test.adr", kind=1)
        with self.assertRaisesRegex(SemanticPolicyError, "triangle count mismatch"):
            classify(
                policy,
                "Road_Test.adr",
                positions=DOWN_POSITIONS + DOWN_POSITIONS,
                indices=(0, 1, 2, 3, 4, 5),
            )
        with self.assertRaisesRegex(SemanticPolicyError, "negative-Y slope"):
            classify(policy, "Road_Test.adr", positions=UP_POSITIONS)
        with self.assertRaisesRegex(SemanticPolicyError, "degenerate"):
            classify(
                policy,
                "Road_Test.adr",
                positions=((0.0, 0.0, 0.0),) * 3,
            )

    def test_surface_strategy_selects_only_negative_y_top_faces(self):
        policy = decoded_policy((surface_rule(triangle_count=4),))
        positions = (
            # Downward-wound top.
            (0.0, 1.0, 0.0),
            (1.0, 1.0, 0.0),
            (0.0, 1.0, 1.0),
            # Upward-wound underside.
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 1.0),
            (1.0, 0.0, 0.0),
            # Vertical side.
            (0.0, 0.0, 0.0),
            (0.0, 1.0, 0.0),
            (0.0, 0.0, 1.0),
            # Degenerate source ordinal.
            (2.0, 0.0, 0.0),
            (2.0, 0.0, 0.0),
            (2.0, 0.0, 0.0),
        )
        result = classify(
            policy,
            "Surface_Test.adr",
            positions=positions,
            indices=tuple(range(12)),
            strict=True,
        )
        self.assertEqual(
            result,
            bytes(
                (
                    SemanticId.FLOOR_EXTERIOR,
                    SemanticId.EXCLUDE,
                    SemanticId.EXCLUDE,
                    SemanticId.EXCLUDE,
                )
            ),
        )
        self.assertEqual(len(result), 4, "degenerate face must retain its ordinal")

    def test_surface_strategy_fails_when_no_top_surface_exists(self):
        policy = decoded_policy((surface_rule(),))
        with self.assertRaisesRegex(SemanticPolicyError, "selected no"):
            classify(policy, "Surface_Test.adr", positions=UP_POSITIONS)

    def test_composites_and_actor_substring_false_positives_stay_unknown(self):
        policy = load_semantic_policy(POLICY_PATH)
        names = (
            "Common_Structures_Dam_Road.adr",
            "Common_Props_Auto_Mech_FloorJack.adr",
            "Common_Props_IndustrialElements_PlatformCart.adr",
            "Common_Props_Porchlight.adr",
            "Common_Structures_Houses_House36B.adr",
            "Hospital_Structures_Floor1_Interior.adr",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertIsNone(policy.rule_for_actor(name))
                self.assertEqual(
                    classify(policy, name), bytes((SemanticId.UNKNOWN,))
                )

    def test_shallow_building_floor_and_roof_are_not_promoted(self):
        policy = decoded_policy()
        positions = (
            # Ground floor, downward-wound.
            (0.0, 0.0, 0.0),
            (1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0),
            # Roof, also downward-wound and slope-eligible.
            (0.0, 10.0, 0.0),
            (1.0, 10.0, 0.0),
            (0.0, 10.0, 1.0),
        )
        result = classify(
            policy,
            "Common_Structures_Houses_Unreviewed.adr",
            positions=positions,
            indices=tuple(range(6)),
        )
        self.assertEqual(result, bytes((SemanticId.UNKNOWN, SemanticId.UNKNOWN)))


def explicit_rule(selections, *, triangle_count=6, kind=0):
    return {
        "actorFile": "Composite_Test.adr",
        "collisionAssetSha256": HASH_A,
        "kind": kind,
        "triangleCount": triangle_count,
        "strategy": "explicit_triangles",
        "selections": selections,
    }


def decode_rules(rules):
    return decode_semantic_policy(canonical_policy_bytes(policy_value(rules)))


class ExplicitTrianglePolicyTests(unittest.TestCase):
    # Six triangles of throwaway geometry: the strategy must never read it.
    POSITIONS = tuple(float(i) for i in range(18 * 3))
    INDICES = tuple(range(18))

    def classify(self, policy):
        return classify_mesh_triangles(
            policy,
            actor_file="Composite_Test.adr",
            collision_asset_sha256=HASH_A,
            kind=0,
            positions=self.POSITIONS,
            indices=self.INDICES,
        )

    def test_unspecified_triangles_default_to_unknown(self):
        policy = decode_rules(
            [
                explicit_rule(
                    [
                        {
                            "semantic": "nav_floor_interior",
                            "triangleRanges": [[0, 1], [4, 4]],
                        },
                        {"semantic": "nav_stair", "triangleRanges": [[2, 2]]},
                    ]
                )
            ]
        )
        result = self.classify(policy)
        self.assertEqual(
            result,
            bytes(
                (
                    SemanticId.FLOOR_INTERIOR,
                    SemanticId.FLOOR_INTERIOR,
                    SemanticId.STAIR,
                    SemanticId.UNKNOWN,
                    SemanticId.FLOOR_INTERIOR,
                    SemanticId.UNKNOWN,
                )
            ),
        )

    def test_rejects_overlap_out_of_range_and_unknown_selection(self):
        with self.assertRaisesRegex(SemanticPolicyError, "overlaps triangle"):
            decode_rules(
                [
                    explicit_rule(
                        [
                            {
                                "semantic": "nav_floor_interior",
                                "triangleRanges": [[0, 2]],
                            },
                            {
                                "semantic": "nav_stair",
                                "triangleRanges": [[2, 3]],
                            },
                        ]
                    )
                ]
            )
        with self.assertRaisesRegex(SemanticPolicyError, "out of range"):
            decode_rules(
                [
                    explicit_rule(
                        [
                            {
                                "semantic": "nav_stair",
                                "triangleRanges": [[5, 6]],
                            }
                        ]
                    )
                ]
            )
        with self.assertRaisesRegex(SemanticPolicyError, "nav_unknown"):
            decode_rules(
                [
                    explicit_rule(
                        [
                            {
                                "semantic": "nav_unknown",
                                "triangleRanges": [[0, 0]],
                            }
                        ]
                    )
                ]
            )
        with self.assertRaisesRegex(SemanticPolicyError, "not sorted"):
            decode_rules(
                [
                    explicit_rule(
                        [
                            {
                                "semantic": "nav_stair",
                                "triangleRanges": [[3, 3], [1, 1]],
                            }
                        ]
                    )
                ]
            )
        with self.assertRaisesRegex(SemanticPolicyError, "unsafe for kind"):
            decode_rules(
                [
                    explicit_rule(
                        [
                            {
                                "semantic": "nav_door_panel_dynamic",
                                "triangleRanges": [[0, 0]],
                            }
                        ]
                    )
                ]
            )

    def test_partial_coverage_fails_strict_production(self):
        policy = decode_rules(
            [
                explicit_rule(
                    [
                        {
                            "semantic": "nav_floor_interior",
                            "triangleRanges": [[0, 4]],
                        }
                    ]
                )
            ]
        )
        with self.assertRaisesRegex(SemanticPolicyError, "unknown"):
            classify_mesh_triangles(
                policy,
                actor_file="Composite_Test.adr",
                collision_asset_sha256=HASH_A,
                kind=0,
                positions=self.POSITIONS,
                indices=self.INDICES,
                strict_production=True,
            )


class CorrectedBundlePolicyTests(unittest.TestCase):
    def test_all_checked_in_rules_match_corrected_bundle_and_geometry(self):
        work_dir = Path(__file__).resolve().parents[4]
        staging = work_dir / "staging" / "h1col2-cdta-v3"
        metadata_path = staging / "z1_collision.metadata.json"
        collision_path = staging / "z1_collision.bin"
        if not metadata_path.exists() or not collision_path.exists():
            self.skipTest("corrected H1COL2 staging bundle is not available")

        policy = load_semantic_policy(POLICY_PATH)
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        by_actor = {entry["actorFile"].casefold(): entry for entry in metadata["meshes"]}
        selected_indices = {
            by_actor[rule.actor_file.casefold()]["meshIndex"] for rule in policy.rules
        }
        meshes = read_selected_h1col2(collision_path, selected_indices)
        uniform_count = 0
        surface_count = 0
        explicit_count = 0
        for rule in policy.rules:
            entry = by_actor[rule.actor_file.casefold()]
            self.assertEqual(entry["collisionAssetSha256"], rule.collision_asset_sha256)
            self.assertEqual(entry["kind"], rule.kind)
            self.assertEqual(entry["triangleCount"], rule.triangle_count)
            kind, positions, indices = meshes[entry["meshIndex"]]
            # Explicit per-triangle rules may intentionally leave reviewed
            # ambiguity as nav_unknown, which strict production correctly
            # rejects; classify those diagnostically and verify selection
            # coverage instead.
            strict = rule.strategy != "explicit_triangles"
            result = classify_mesh_triangles(
                policy,
                actor_file=entry["actorFile"],
                collision_asset_sha256=entry["collisionAssetSha256"],
                kind=kind,
                positions=positions,
                indices=indices,
                strict_production=strict,
            )
            self.assertEqual(len(result), entry["triangleCount"])
            if rule.strategy == "uniform":
                uniform_count += 1
                self.assertEqual(set(result), {rule.semantic})
            elif rule.strategy == "explicit_triangles":
                explicit_count += 1
                selected = {semantic for semantic, _ in rule.selections}
                self.assertTrue(
                    set(result).issubset(selected | {SemanticId.UNKNOWN})
                )
                expected_selected = sum(
                    end - start + 1
                    for _, ranges in rule.selections
                    for start, end in ranges
                )
                actual_selected = sum(
                    1 for value in result if value != SemanticId.UNKNOWN
                )
                self.assertEqual(actual_selected, expected_selected)
            else:
                surface_count += 1
                self.assertIn(rule.surface_semantic, result)
                self.assertTrue(
                    set(result).issubset({rule.surface_semantic, SemanticId.EXCLUDE})
                )
        self.assertEqual(
            (uniform_count, surface_count), (55, 34)
        )
        self.assertEqual(explicit_count, len(policy.rules) - 89)


if __name__ == "__main__":
    unittest.main()
