import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from h1sem import SemanticId, encode_h1sem1
from propose_navigation_archetypes import (
    build_report,
    compress_ranges,
    propose_mesh,
)


class ProposeNavigationArchetypesTests(unittest.TestCase):
    def test_compress_ranges_is_stable_and_inclusive(self):
        self.assertEqual(
            compress_ranges([7, 2, 3, 3, 4, 9]),
            [[2, 4], [7, 7], [9, 9]],
        )

    def test_kind_two_is_review_only_and_flags_overhead_name(self):
        mesh = {
            "actorFile": "Common_Props_CeilingFan01.adr",
            "meshIndex": 0,
            "collisionAsset": "fan.cdt",
            "collisionAssetSha256": "a" * 64,
            "instanceCount": 4,
        }
        positions = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
        result = propose_mesh(
            mesh, 2, positions, (0, 1, 2), bytes([SemanticId.UNKNOWN])
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["confidence"], "low")
        self.assertIn("actor-name-contains:ceiling", result["riskSignals"])

    def test_composite_keeps_highest_flat_band_roof_ambiguous(self):
        mesh = {
            "actorFile": "Building.adr",
            "meshIndex": 0,
            "collisionAsset": "building.cdt",
            "collisionAssetSha256": "b" * 64,
            "instanceCount": 2,
        }
        # Negative-Y winding is the walkable-facing convention in H1COL2.
        positions = (
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0,
            0.0, 3.0, 0.0, 0.0, 3.0, 1.0, 1.0, 3.0, 0.0,
        )
        result = propose_mesh(
            mesh,
            0,
            positions,
            (0, 2, 1, 3, 5, 4),
            bytes([SemanticId.UNKNOWN, SemanticId.UNKNOWN]),
        )
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(len(result["groups"]), 2)
        lower, upper = result["groups"]
        self.assertEqual(lower["kind"], "floor-candidate")
        self.assertEqual(lower["suggestedSemantic"], "nav_floor_interior")
        self.assertFalse(lower["ambiguous"])
        self.assertEqual(upper["kind"], "roof-or-top-deck-candidate")
        self.assertIsNone(upper["suggestedSemantic"])
        self.assertTrue(upper["ambiguous"])

    def test_build_report_binds_collision_and_semantic_hashes(self):
        positions = (
            0.0, 0.0, 0.0,
            0.0, 0.0, 1.0,
            1.0, 0.0, 0.0,
        )
        indices = (0, 2, 1)
        header = b"H1COL2\x00\x00" + (2).to_bytes(4, "little")
        header += (1).to_bytes(4, "little") + (0).to_bytes(4, "little")
        mesh_bytes = bytes([0]) + (3).to_bytes(4, "little") + (3).to_bytes(4, "little")
        import struct
        collision = header + mesh_bytes
        collision += struct.pack("<9f", *positions) + struct.pack("<3I", *indices)
        digest = hashlib.sha256(collision).digest()
        metadata = {
            "collisionSha256": digest.hex(),
            "meshes": [{
                "actorFile": "Building.adr",
                "meshIndex": 0,
                "kind": 0,
                "collisionAsset": "building.cdt",
                "collisionAssetSha256": "c" * 64,
                "instanceCount": 3,
                "triangleCount": 1,
            }],
        }
        semantics = encode_h1sem1(
            digest, [bytes([SemanticId.UNKNOWN])], mesh_triangle_counts=[1]
        )
        report = build_report(collision, metadata, semantics)
        self.assertEqual(report["totals"]["proposals"], 1)
        self.assertEqual(report["totals"]["worldUnknownTriangles"], 3)
        self.assertEqual(report["proposals"][0]["decision"], "REVIEW")


if __name__ == "__main__":
    unittest.main()
