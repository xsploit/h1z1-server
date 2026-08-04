import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from author_model_semantic_rule import author_rule, triangle_evidence


class AuthorModelSemanticRuleTest(unittest.TestCase):
    def test_first_matching_selector_owns_triangle_and_default_fails_closed(self):
        # Negative-Y horizontal floor, then a positive-Y duplicate that must
        # remain a static obstacle.
        positions = (
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 0.0,
            0.0, 0.0, 1.0,
            1.0, 0.0, 0.0,
        )
        indices = tuple(range(6))
        recipe = {
            "actorFile": "Test.adr",
            "collisionAssetSha256": "a" * 64,
            "defaultSemantic": "nav_obstacle_static",
            "selectors": [
                {
                    "id": "threshold-priority",
                    "semantic": "nav_threshold",
                    "centroidBounds": [0, -1, 0, 1, 1, 1],
                    "normalYMax": -0.9,
                },
                {
                    "id": "overlapping-floor",
                    "semantic": "nav_floor_interior",
                    "centroidBounds": [0, -1, 0, 1, 1, 1],
                    "normalYMax": -0.9,
                    "minSelectedTriangles": 0,
                },
            ],
        }
        rule, report = author_rule(
            0, triangle_evidence(positions, indices), recipe
        )
        selections = {
            row["semantic"]: row["triangleRanges"]
            for row in rule["selections"]
        }
        self.assertEqual(selections["nav_threshold"], [[0, 0]])
        self.assertEqual(selections["nav_obstacle_static"], [[1, 1]])
        self.assertEqual(report["selectors"][1]["shadowedTriangles"], 1)
        self.assertEqual(
            report["semanticHistogram"],
            {"nav_obstacle_static": 1, "nav_threshold": 1},
        )

    def test_selector_minimum_fails_closed(self):
        evidence = triangle_evidence(
            (0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0),
            (0, 1, 2),
        )
        recipe = {
            "actorFile": "Test.adr",
            "collisionAssetSha256": "a" * 64,
            "defaultSemantic": "nav_obstacle_static",
            "selectors": [
                {
                    "id": "missing",
                    "semantic": "nav_stair",
                    "centroidBounds": [10, 10, 10, 11, 11, 11],
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "selected 0 triangles"):
            author_rule(0, evidence, recipe)


if __name__ == "__main__":
    unittest.main()
