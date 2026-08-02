import struct
import sys
from pathlib import Path
import unittest

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cdta import CDTAError, UnsupportedCDTA, merge_meshes, parse_cdta


def make_cdta(
    *,
    version=1,
    positions=((0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    indices=(0, 1, 2),
    cooked=b"NXS\x01MESH",
    suffix=b"",
):
    out = bytearray(b"CDTA")
    out.extend(struct.pack("<IIII", version, 0xEDC05F26, 1, 0))
    if version == 2:
        out.extend(struct.pack("<II", 0x7F8301FF, 0))
    out.extend(struct.pack("<I", len(positions)))
    for position in positions:
        out.extend(struct.pack("<fff", *position))
    out.extend(struct.pack("<I", len(indices) // 3))
    out.extend(struct.pack(f"<{len(indices)}H", *indices))
    out.extend(struct.pack("<I", len(cooked)))
    out.extend(cooked)
    out.extend(suffix)
    return bytes(out)


class CDTATest(unittest.TestCase):
    def test_decodes_v1_explicit_mesh(self):
        parsed = parse_cdta(make_cdta(version=1), "v1-fixture.cdt")
        self.assertEqual(parsed.version, 1)
        self.assertEqual(parsed.asset_hash, 0xEDC05F26)
        self.assertIsNone(parsed.v2_opaque)
        np.testing.assert_array_equal(parsed.meshes[0].indices, [0, 1, 2])
        self.assertEqual(parsed.meshes[0].positions.shape, (3, 3))
        self.assertFalse(parsed.meshes[0].positions.flags.writeable)

    def test_decodes_v2_opaque_header_without_interpreting_it(self):
        parsed = parse_cdta(make_cdta(version=2), "v2-fixture.cdt")
        self.assertEqual(parsed.version, 2)
        self.assertEqual(parsed.v2_opaque, (0x7F8301FF, 0))
        self.assertEqual(parsed.meshes[0].cooked_payload_bytes, 8)

    def test_rejects_compound_layout_until_it_is_proven(self):
        fixture = bytearray(make_cdta())
        struct.pack_into("<I", fixture, 12, 2)
        with self.assertRaisesRegex(UnsupportedCDTA, "shapeCount=2"):
            parse_cdta(bytes(fixture), "compound.cdt")

    def test_rejects_unparsed_trailing_bytes(self):
        with self.assertRaisesRegex(UnsupportedCDTA, "unparsed bytes"):
            parse_cdta(make_cdta(suffix=b"alternate"), "alternate.cdt")

    def test_rejects_out_of_range_triangle_index(self):
        with self.assertRaisesRegex(CDTAError, "outside 3 vertices"):
            parse_cdta(make_cdta(indices=(0, 1, 3)), "bad-index.cdt")

    def test_rejects_non_finite_vertices(self):
        with self.assertRaisesRegex(CDTAError, "NaN or infinity"):
            parse_cdta(
                make_cdta(positions=((0.0, 0.0, 0.0), (float("nan"), 0.0, 0.0), (0.0, 0.0, 1.0))),
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
