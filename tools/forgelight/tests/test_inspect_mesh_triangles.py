import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inspect_mesh_triangles import connected_components, inspect


class InspectMeshTrianglesTests(unittest.TestCase):
    def test_components_split_and_merge_by_shared_vertices(self):
        # Triangles 0 and 1 share vertices 1 and 2; triangle 2 is isolated.
        indices = (0, 1, 2, 2, 1, 3, 4, 5, 6)
        self.assertEqual(connected_components(indices), [0, 0, 1])

    def test_inspect_reports_slope_band_and_component_evidence(self):
        # One flat upward floor triangle at y=0 and one vertical wall
        # triangle 3m higher, disconnected from each other.
        positions = (
            0.0, 0.0, 0.0,  1.0, 0.0, 0.0,  0.0, 0.0, 1.0,
            0.0, 3.0, 0.0,  0.0, 4.0, 0.0,  0.0, 3.0, 1.0,
        )
        indices = (0, 2, 1, 3, 4, 5)
        report = inspect(0, positions, indices, band_height=0.5)
        self.assertEqual(report["triangleCount"], 2)
        self.assertEqual(report["componentCount"], 2)
        floor, wall = report["triangles"]
        self.assertEqual(floor["slopeDegrees"], 0.0)
        self.assertEqual(floor["normalY"], 1.0)
        self.assertEqual(floor["elevationBand"], 0)
        self.assertIsNone(floor["renderProvenance"])
        self.assertEqual(wall["slopeDegrees"], 90.0)
        self.assertEqual(wall["normalY"], 0.0)
        # Wall centroid y ~ 3.33; bands are 0.5m from mesh min y (0).
        self.assertEqual(wall["elevationBand"], 6)
        self.assertEqual(report["components"][0]["triangles"], 1)


if __name__ == "__main__":
    unittest.main()
