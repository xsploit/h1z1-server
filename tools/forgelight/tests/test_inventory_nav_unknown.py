import hashlib
import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from h1sem import H1SEM1Error, SemanticId, encode_h1sem1
from inventory_nav_unknown import (
    build_inventory,
    semantic_histograms_from_sidecar,
)


COLLISION_BYTES = b"exact collision artifact"
COLLISION_DIGEST = hashlib.sha256(COLLISION_BYTES).digest()


def metadata():
    return {
        "collisionSha256": COLLISION_DIGEST.hex(),
        "semanticMode": "diagnostic",
        "totalTriangleCount": 5,
        "meshes": [
            {
                "actorFile": "Objects_Test_A.adr",
                "collisionAsset": "A.cdt",
                "collisionAssetSha256": "a" * 64,
                "kind": 0,
                "meshIndex": 0,
                "triangleCount": 3,
                "instanceCount": 4,
                "semanticHistogram": {"nav_unknown": 3},
            },
            {
                "actorFile": "Objects_Test_B.adr",
                "collisionAsset": "B.cdt",
                "collisionAssetSha256": "b" * 64,
                "kind": 2,
                "meshIndex": 1,
                "triangleCount": 2,
                "instanceCount": 2,
                "semanticHistogram": {"nav_unknown": 2},
            },
        ],
    }


class InventoryNavUnknownTest(unittest.TestCase):
    def test_sidecar_histograms_override_stale_metadata(self):
        sidecar = encode_h1sem1(
            COLLISION_DIGEST,
            (
                (
                    SemanticId.FLOOR_INTERIOR,
                    SemanticId.THRESHOLD,
                    SemanticId.UNKNOWN,
                ),
                (SemanticId.OBSTACLE_STATIC, SemanticId.OBSTACLE_STATIC),
            ),
            mesh_triangle_counts=(3, 2),
        )
        histograms, sidecar_sha = semantic_histograms_from_sidecar(
            metadata(), sidecar
        )
        inventory = build_inventory(metadata(), histograms, sidecar_sha)

        self.assertEqual(inventory["semanticSource"], "h1sem1")
        self.assertEqual(inventory["semanticSidecarSha256"], sidecar_sha)
        self.assertEqual(inventory["totalUnknownTriangles"], 1)
        self.assertEqual(inventory["meshesWithUnknown"], 1)
        self.assertEqual(inventory["meshes"][0]["actorFile"], "Objects_Test_A.adr")
        self.assertEqual(inventory["meshes"][0]["worldUnknownTriangles"], 4)
        self.assertEqual(
            inventory["meshes"][0]["semanticHistogram"],
            {
                "nav_floor_interior": 1,
                "nav_threshold": 1,
                "nav_unknown": 1,
            },
        )

    def test_sidecar_must_match_collision_digest(self):
        sidecar = encode_h1sem1(
            b"x" * 32,
            ((SemanticId.UNKNOWN,) * 3, (SemanticId.UNKNOWN,) * 2),
            mesh_triangle_counts=(3, 2),
        )
        with self.assertRaisesRegex(H1SEM1Error, "SHA256 mismatch"):
            semantic_histograms_from_sidecar(metadata(), sidecar)

    def test_sidecar_must_match_mesh_triangle_counts(self):
        sidecar = encode_h1sem1(
            COLLISION_DIGEST,
            ((SemanticId.UNKNOWN,) * 2, (SemanticId.UNKNOWN,) * 3),
            mesh_triangle_counts=(2, 3),
        )
        with self.assertRaisesRegex(H1SEM1Error, "mesh 0 triangle count mismatch"):
            semantic_histograms_from_sidecar(metadata(), sidecar)

    def test_metadata_remains_supported_without_sidecar(self):
        inventory = build_inventory(metadata())
        self.assertEqual(inventory["semanticSource"], "metadata")
        self.assertIsNone(inventory["semanticSidecarSha256"])
        self.assertEqual(inventory["totalUnknownTriangles"], 5)


if __name__ == "__main__":
    unittest.main()
