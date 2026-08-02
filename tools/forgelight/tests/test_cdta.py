import struct
import sys
from pathlib import Path
import unittest

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cdta import CDTAError, UnsupportedCDTA, merge_meshes, parse_cdta


DEFAULT_POSITIONS = (
    (0.0, 0.0, 0.0),
    (1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0),
)


def make_cdta(
    *,
    version=1,
    collision_type=0xEDC05F26,
    positions=DEFAULT_POSITIONS,
    indices=(0, 1, 2),
    cooked=b"NXS\x01MESH",
    shapes=None,
    suffix=b"",
):
    if shapes is None:
        shapes = (
            {
                "positions": positions,
                "indices": indices,
                "cooked": cooked,
            },
        )

    out = bytearray(b"CDTA")
    out.extend(struct.pack("<III", version, collision_type, len(shapes)))
    for shape in shapes:
        metadata = shape.get(
            "metadata", (0,) if version == 1 else (0, 0x7F8301FF, 0)
        )
        expected_words = 1 if version == 1 else 3
        if len(metadata) != expected_words:
            raise ValueError("fixture shape metadata does not match CDTA version")
        out.extend(struct.pack(f"<{len(metadata)}I", *metadata))

        shape_positions = shape.get("positions", DEFAULT_POSITIONS)
        shape_indices = shape.get("indices", (0, 1, 2))
        shape_cooked = shape.get("cooked", b"NXS\x01MESH")
        out.extend(struct.pack("<I", len(shape_positions)))
        for position in shape_positions:
            out.extend(struct.pack("<fff", *position))
        out.extend(struct.pack("<I", len(shape_indices) // 3))
        out.extend(struct.pack(f"<{len(shape_indices)}H", *shape_indices))
        out.extend(struct.pack("<I", len(shape_cooked)))
        out.extend(shape_cooked)
    out.extend(suffix)
    return bytes(out)


def make_incomplete_high_vertex_cdta():
    vertex_count = 65_537
    out = bytearray(b"CDTA")
    out.extend(struct.pack("<III", 1, 0xEDC05F26, 1))
    out.extend(struct.pack("<I", 0))
    out.extend(struct.pack("<I", vertex_count))
    out.extend(b"\0" * (vertex_count * 12))
    out.extend(struct.pack("<I", 2))  # declares two triangles
    out.extend(struct.pack("<3H", 0, 1, 2))  # only one was serialized
    cooked = b"NXS\x01MESH"
    out.extend(struct.pack("<I", len(cooked)))
    out.extend(cooked)
    return bytes(out)


class CDTATest(unittest.TestCase):
    def test_decodes_v1_explicit_mesh(self):
        parsed = parse_cdta(make_cdta(version=1), "v1-fixture.cdt")
        self.assertEqual(parsed.version, 1)
        self.assertEqual(parsed.collision_type, 0xEDC05F26)
        self.assertEqual(parsed.shape_count, 1)
        self.assertEqual(parsed.meshes[0].shape_metadata, (0,))
        np.testing.assert_array_equal(parsed.meshes[0].indices, [0, 1, 2])
        self.assertEqual(parsed.meshes[0].positions.shape, (3, 3))
        self.assertFalse(parsed.meshes[0].positions.flags.writeable)

    def test_decodes_v2_shape_metadata_without_interpreting_it(self):
        parsed = parse_cdta(make_cdta(version=2), "v2-fixture.cdt")
        self.assertEqual(parsed.version, 2)
        self.assertEqual(parsed.meshes[0].shape_metadata, (0, 0x7F8301FF, 0))
        self.assertEqual(parsed.meshes[0].cooked_payload_bytes, 8)

    def test_decodes_compound_v2_shapes_in_source_order(self):
        fixture = make_cdta(
            version=2,
            shapes=(
                {
                    "metadata": (0, 0x7F8301FF, 0),
                    "positions": DEFAULT_POSITIONS,
                    "indices": (0, 1, 2),
                    "cooked": b"NXS\x01MESH",
                },
                {
                    "metadata": (0, 0x00000100, 1),
                    "positions": (
                        (10.0, 0.0, 0.0),
                        (11.0, 0.0, 0.0),
                        (10.0, 0.0, 1.0),
                    ),
                    "indices": (0, 2, 1),
                    "cooked": b"second",
                },
            ),
        )
        parsed = parse_cdta(fixture, "compound-v2.cdt")

        self.assertEqual(parsed.shape_count, 2)
        self.assertEqual(len(parsed.meshes), 2)
        self.assertEqual(parsed.meshes[0].shape_metadata, (0, 0x7F8301FF, 0))
        self.assertEqual(parsed.meshes[1].shape_metadata, (0, 0x00000100, 1))
        positions, indices = merge_meshes(parsed)
        np.testing.assert_array_equal(indices, [0, 1, 2, 3, 5, 4])
        np.testing.assert_array_equal(positions[:, 0], [0, 1, 0, 10, 11, 10])

    def test_rejects_unparsed_trailing_bytes(self):
        with self.assertRaisesRegex(
            UnsupportedCDTA, "unparsed bytes at byte"
        ):
            parse_cdta(make_cdta(suffix=b"alternate"), "alternate.cdt")

    def test_rejects_incomplete_high_vertex_index_stream(self):
        with self.assertRaisesRegex(
            UnsupportedCDTA,
            "incomplete uint16 index stream.*declared 2 triangles but serialized 1",
        ):
            parse_cdta(
                make_incomplete_high_vertex_cdta(), "incomplete-high-vertex.cdt"
            )

    def test_rejects_zero_shapes(self):
        fixture = b"CDTA" + struct.pack("<III", 1, 0xEDC05F26, 0)
        with self.assertRaisesRegex(CDTAError, "zero shapes"):
            parse_cdta(fixture, "zero-shapes.cdt")

    def test_rejects_out_of_range_triangle_index(self):
        with self.assertRaisesRegex(CDTAError, "outside 3 vertices"):
            parse_cdta(make_cdta(indices=(0, 1, 3)), "bad-index.cdt")

    def test_rejects_non_finite_vertices(self):
        with self.assertRaisesRegex(CDTAError, "NaN or infinity"):
            parse_cdta(
                make_cdta(
                    positions=(
                        (0.0, 0.0, 0.0),
                        (float("nan"), 0.0, 0.0),
                        (0.0, 0.0, 1.0),
                    )
                ),
                "nan.cdt",
            )

    def test_merge_preserves_shape_and_index_order(self):
        parsed = parse_cdta(make_cdta(), "merge.cdt")
        positions, indices = merge_meshes(parsed)
        self.assertEqual(positions.dtype, np.dtype("float32"))
        self.assertEqual(indices.dtype, np.dtype("uint32"))
        np.testing.assert_array_equal(indices, [0, 1, 2])


if __name__ == "__main__":
    unittest.main()
