from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from artifact_bundle import publish_artifact_bundle
from collision_semantic_policy import (
    SemanticPolicyError,
    canonical_policy_bytes,
)
from export_z1_instanced import (
    build_collision_artifact_bundle,
    decode_h1cid1,
    parse_strict_bool,
)
from h1sem import H1SEM1Error, SemanticId, decode_h1sem1


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def policy_bytes() -> bytes:
    return canonical_policy_bytes(
        {
            "coordinateSpace": "h1z1-world-y-up-meters",
            "defaults": {
                "kind0": "nav_unknown",
                "kind1": "nav_obstacle_static",
                "kind2": "nav_unknown",
                "kind3": "nav_door_panel_dynamic",
            },
            "rules": [
                {
                    "actorFile": "ExactRoad.adr",
                    "collisionAssetSha256": "a" * 64,
                    "kind": 0,
                    "precondition": "all_negative_y_slope_45",
                    "semantic": "nav_road",
                    "strategy": "uniform",
                    "triangleCount": 1,
                }
            ],
            "schema": "h1emu-h1col2-semantic-policy-v1",
            "semanticContract": "h1emu-nav-semantics-v1",
            "semanticSchemaVersion": 1,
        }
    )


def fixture(*, unknown: bool = False, source_hash: str = "a" * 64):
    road_positions = np.asarray(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float32,
    )
    obstacle_positions = np.asarray(
        [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]],
        dtype=np.float32,
    )
    meshes = [
        (road_positions, np.asarray([0, 1, 2], dtype=np.uint32)),
        (obstacle_positions, np.asarray([0, 1, 2], dtype=np.uint32)),
    ]
    actors = ["Unreviewed.adr" if unknown else "ExactRoad.adr", "Wall.adr"]
    sources = [
        {
            "collisionAsset": "ExactRoad.cdt",
            "collisionSha256": source_hash,
            "cdtaVersion": 1,
            "cdtaCollisionType": 0,
            "shapeCount": 1,
        },
        {
            "collisionAsset": "Wall.cdt",
            "collisionSha256": "b" * 64,
            "cdtaVersion": 1,
            "cdtaCollisionType": 0,
            "shapeCount": 1,
        },
    ]
    transforms = np.zeros((2, 16), dtype=np.float32)
    transforms[:, 6] = 1.0
    transforms[:, 7:10] = 1.0
    return {
        "collision_name": "z1_collision.bin",
        "instance_ids_name": "z1_collision.instance_ids.bin",
        "semantics_name": "z1_collision.semantics.bin",
        "policy_name": "z1_collision.semantic_policy.json",
        "meshes": meshes,
        "mesh_actors": actors,
        "mesh_sources": sources,
        "mesh_kinds": [0, 1],
        "instance_mesh_indices": np.asarray([0, 1], dtype=np.uint32),
        "instance_data": transforms,
        "instance_ids": np.asarray([101, 202], dtype=np.uint32),
        "inventory": {
            "noCollisionActorTypes": 3,
            "reviewedSkips": [],
        },
        "policy_bytes": policy_bytes(),
    }


class ExportArtifactBundleTests(unittest.TestCase):
    def test_deterministic_v4_bundle_hashes_roundtrips_and_metadata_last(self):
        first_artifacts, first_metadata = build_collision_artifact_bundle(**fixture())
        second_artifacts, second_metadata = build_collision_artifact_bundle(**fixture())
        self.assertEqual(first_artifacts, second_artifacts)
        self.assertEqual(first_metadata, second_metadata)

        metadata = json.loads(first_metadata)
        self.assertEqual(metadata["schema"], "h1emu-h1col2-metadata-v4")
        self.assertEqual(metadata["formatVersion"], 2)
        self.assertEqual(metadata["semanticMode"], "diagnostic")
        self.assertFalse(metadata["dynamicDoorObstaclesAcknowledged"])
        self.assertTrue(
            any(
                "parity is unproven" in limitation
                for limitation in metadata["limitations"]
            )
        )
        self.assertEqual(metadata["meshCount"], 2)
        self.assertEqual(metadata["totalTriangleCount"], 2)
        self.assertEqual(metadata["unknownCount"], 0)
        self.assertEqual(
            metadata["semanticHistogram"],
            {"nav_obstacle_static": 1, "nav_road": 1},
        )

        collision = first_artifacts[metadata["collisionFile"]]
        self.assertEqual(collision[:8], b"H1COL2\0\0")
        self.assertEqual(struct.unpack_from("<I", collision, 8)[0], 2)
        self.assertEqual(metadata["collisionSha256"], sha256(collision))

        ids_contract = metadata["instanceIds"]
        ids = first_artifacts[ids_contract["file"]]
        self.assertEqual(ids_contract["sha256"], sha256(ids))
        self.assertEqual(decode_h1cid1(ids, expected_count=2), (101, 202))

        semantics_contract = metadata["triangleSemantics"]
        semantics = first_artifacts[semantics_contract["file"]]
        self.assertEqual(semantics_contract["sha256"], sha256(semantics))
        document = decode_h1sem1(
            semantics,
            expected_h1col2_sha256=bytes.fromhex(metadata["collisionSha256"]),
            expected_mesh_triangle_counts=(1, 1),
            strict_production=True,
        )
        self.assertEqual(
            document.semantic_ids,
            bytes((SemanticId.ROAD, SemanticId.OBSTACLE_STATIC)),
        )
        policy_contract = metadata["semanticPolicy"]
        policy = first_artifacts[policy_contract["file"]]
        self.assertEqual(policy_contract["sha256"], sha256(policy))

        with tempfile.TemporaryDirectory() as temporary:
            replacements = []

            def tracked_replace(source, destination):
                replacements.append(Path(destination).name)
                os.replace(source, destination)

            publish_artifact_bundle(
                temporary,
                first_artifacts,
                "z1_collision.metadata.json",
                first_metadata,
                replace=tracked_replace,
            )
            self.assertEqual(replacements[-1], "z1_collision.metadata.json")
            for name, data in first_artifacts.items():
                self.assertEqual((Path(temporary) / name).read_bytes(), data)

    def test_diagnostic_unknown_is_counted_and_strict_production_fails_closed(self):
        artifacts, metadata_bytes = build_collision_artifact_bundle(
            **fixture(unknown=True)
        )
        metadata = json.loads(metadata_bytes)
        self.assertEqual(metadata["unknownCount"], 1)
        self.assertEqual(metadata["triangleSemantics"]["unknownCount"], 1)
        semantics = artifacts[metadata["triangleSemantics"]["file"]]
        with self.assertRaisesRegex(H1SEM1Error, "cannot contain unknown"):
            decode_h1sem1(semantics, strict_production=True)

        with self.assertRaisesRegex(
            SemanticPolicyError, "production semantics contain unknown"
        ):
            build_collision_artifact_bundle(
                **fixture(unknown=True), strict_production=True
            )

    def test_corruption_and_exact_source_binding_fail_closed(self):
        artifacts, metadata_bytes = build_collision_artifact_bundle(**fixture())
        metadata = json.loads(metadata_bytes)
        ids = artifacts[metadata["instanceIds"]["file"]]
        semantics = artifacts[metadata["triangleSemantics"]["file"]]

        with self.assertRaisesRegex(ValueError, "invalid H1CID1 magic"):
            decode_h1cid1(b"BROKEN!!" + ids[8:])
        with self.assertRaisesRegex(ValueError, "truncated H1CID1"):
            decode_h1cid1(ids[:-1])
        with self.assertRaisesRegex(ValueError, "trailing H1CID1"):
            decode_h1cid1(ids + b"x")
        with self.assertRaisesRegex(H1SEM1Error, "invalid H1SEM1 magic"):
            decode_h1sem1(b"BROKEN!!" + semantics[8:])

        tampered_collision = artifacts[metadata["collisionFile"]] + b"x"
        self.assertNotEqual(metadata["collisionSha256"], sha256(tampered_collision))
        with self.assertRaisesRegex(SemanticPolicyError, "collision hash mismatch"):
            build_collision_artifact_bundle(**fixture(source_hash="c" * 64))

    def test_dynamic_door_acknowledgement_is_explicit_and_strictly_typed(self):
        self.assertTrue(parse_strict_bool("true", "door flag"))
        self.assertFalse(parse_strict_bool("false", "door flag"))
        for invalid in ("True", "1", "yes", "", None):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ValueError, "exactly true or false"
            ):
                parse_strict_bool(invalid, "door flag")

        _, acknowledged_bytes = build_collision_artifact_bundle(
            **fixture(), dynamic_door_obstacles_acknowledged=True
        )
        acknowledged = json.loads(acknowledged_bytes)
        self.assertTrue(acknowledged["dynamicDoorObstaclesAcknowledged"])
        self.assertTrue(
            any(
                "explicitly acknowledged by the operator" in limitation
                for limitation in acknowledged["limitations"]
            )
        )
        with self.assertRaisesRegex(ValueError, "acknowledgement must be boolean"):
            build_collision_artifact_bundle(
                **fixture(), dynamic_door_obstacles_acknowledged="true"
            )


if __name__ == "__main__":
    unittest.main()
