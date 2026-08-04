import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from tools.forgelight.prepare_model_instance_validation import prepare, transform_point


class PrepareModelInstanceValidationTests(unittest.TestCase):
    def test_transform_point_matches_quaternion_scale_translation(self):
        half = math.sqrt(0.5)
        transform = (10, 2, 20, 0, half, 0, half, 2, 1, 3, 0, 0, 0, 1, 1, 1)
        point = transform_point([1, 4, 2], transform)
        self.assertAlmostEqual(point[0], 16)
        self.assertAlmostEqual(point[1], 6)
        self.assertAlmostEqual(point[2], 18)

    def test_prepare_filters_mesh_and_emits_world_routes_and_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collision = root / "z1_collision.bin"
            metadata = root / "z1_collision.metadata.json"
            template = root / "template.json"
            # Two empty meshes and two instances; only instance 1 uses mesh 1.
            raw = bytearray(b"H1COL2\0\0")
            raw.extend(struct.pack("<III", 2, 2, 2))
            raw.extend(struct.pack("<BII", 0, 0, 0))
            raw.extend(struct.pack("<BII", 0, 0, 0))
            raw.extend(struct.pack("<II", 0, 1))
            raw.extend(struct.pack("<16f", 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, -1, 0, -1, 1, 2, 1))
            raw.extend(struct.pack("<16f", 10, 2, 20, 0, 0, 0, 1, 1, 1, 1, 8, 1, 18, 12, 5, 23))
            collision.write_bytes(raw)
            metadata.write_text(
                json.dumps({"meshes": [{"actorFile": "Pilot.adr", "meshIndex": 1}]}),
                encoding="utf-8",
            )
            template.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "actorFile": "Pilot.adr",
                        "boundsMargin": 2,
                        "routes": [{"label": "door", "start": [0, 0, 0], "end": [1, 0, 0]}],
                        "forbiddenProbes": [
                            {
                                "label": "roof",
                                "position": [0, 5, 0],
                                "halfExtents": [0.5, 0.25, 0.5],
                            }
                        ],
                        "transitions": [
                            {
                                "name": "door seam",
                                "start": [0, 0, 0],
                                "end": [1, 0, 0],
                                "radius": 0.4,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            bakes, routes, skipped, forbidden, transitions = prepare(
                collision, metadata, template
            )
            self.assertEqual(bakes, [{"instanceIndex": 1, "bounds": [6, 16, 14, 25]}])
            self.assertEqual(skipped, [])
            self.assertEqual(
                forbidden,
                [
                    {
                        "instanceIndex": 1,
                        "label": "roof",
                        "position": [10.0, 7.0, 20.0],
                        "halfExtents": [0.5, 0.25, 0.5],
                    }
                ],
            )
            self.assertEqual(len(transitions), 1)
            self.assertEqual(transitions[0]["instanceIndex"], 1)
            self.assertEqual(transitions[0]["start"], [10.0, 2.0, 20.0])
            self.assertEqual(transitions[0]["end"], [11.0, 2.0, 20.0])
            self.assertEqual(transitions[0]["radius"], 0.4)
            self.assertEqual(routes[0]["instanceIndex"], 1)
            self.assertEqual(routes[0]["start"], [10.0, 2.0, 20.0])
            self.assertEqual(routes[0]["end"], [11.0, 2.0, 20.0])

    def test_prepare_skips_instances_buried_far_from_terrain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            collision = root / "z1_collision.bin"
            metadata = root / "z1_collision.metadata.json"
            template = root / "template.json"
            raw = bytearray(b"H1COL2\0\0")
            raw.extend(struct.pack("<III", 2, 1, 1))
            raw.extend(struct.pack("<BII", 0, 0, 0))
            raw.extend(struct.pack("<I", 0))
            raw.extend(struct.pack("<16f", 10, 2, 20, 0, 0, 0, 1, 1, 1, 1, 8, 1, 18, 12, 5, 23))
            collision.write_bytes(raw)
            metadata.write_text(
                json.dumps({"meshes": [{"actorFile": "Pilot.adr", "meshIndex": 0}]}),
                encoding="utf-8",
            )
            template.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "actorFile": "Pilot.adr",
                        "terrainProbes": [[0, 0, 0]],
                        "maxTerrainDelta": 1.5,
                        "routes": [{"label": "door", "start": [0, 0, 0], "end": [1, 0, 0]}],
                    }
                ),
                encoding="utf-8",
            )
            bakes, routes, skipped, forbidden, transitions = prepare(
                collision, metadata, template, lambda _x, _z: 10.0
            )
            self.assertEqual(bakes, [])
            self.assertEqual(routes, [])
            self.assertEqual(forbidden, [])
            self.assertEqual(transitions, [])
            self.assertEqual(skipped[0]["instanceIndex"], 0)
            self.assertEqual(skipped[0]["reason"], "terrain-height-mismatch")
            self.assertEqual(skipped[0]["terrainDeltas"], [-8.0])

            admitted, admitted_routes, admitted_skips, _, _ = prepare(
                collision,
                metadata,
                template,
                lambda _x, _z: 10.0,
                max_terrain_delta_override=8.0,
            )
            self.assertEqual(admitted, [{"instanceIndex": 0, "bounds": [-7, 3, 27, 38]}])
            self.assertEqual(len(admitted_routes), 1)
            self.assertEqual(admitted_skips, [])

            template_payload = json.loads(template.read_text(encoding="utf-8"))
            template_payload["terrainDeltaOverrides"] = {"0": 8.0}
            template.write_text(json.dumps(template_payload), encoding="utf-8")
            admitted, admitted_routes, admitted_skips, _, _ = prepare(
                collision, metadata, template, lambda _x, _z: 10.0
            )
            self.assertEqual(len(admitted), 1)
            self.assertEqual(len(admitted_routes), 1)
            self.assertEqual(admitted_skips, [])


if __name__ == "__main__":
    unittest.main()
