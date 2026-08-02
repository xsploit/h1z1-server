import hashlib
import struct
import sys
from pathlib import Path
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from h1sem import (
    HEADER_BYTES,
    H1SEM1Error,
    MAGIC,
    SEMANTIC_SCHEMA_VERSION,
    VERSION,
    SemanticId,
    decode_h1sem1,
    encode_h1sem1,
)


DIGEST = bytes(range(32))
GOLDEN_HEX = (
    "483153454d310000"
    "01000000"
    "40000000"
    "01000000"
    "02000000"
    "05000000"
    "00000000"
    "000102030405060708090a0b0c0d0e0f"
    "101112131415161718191a1b1c1d1e1f"
    "00000000"
    "02000000"
    "05000000"
    "0205080a09"
)


def golden_artifact():
    return encode_h1sem1(
        DIGEST,
        (
            (SemanticId.ROAD, SemanticId.STAIR),
            (
                SemanticId.OBSTACLE_STATIC,
                SemanticId.EXCLUDE,
                SemanticId.DOOR_PANEL_DYNAMIC,
            ),
        ),
        mesh_triangle_counts=(2, 3),
    )


class H1SEM1Test(unittest.TestCase):
    def test_deterministic_golden_bytes(self):
        first = golden_artifact()
        second = golden_artifact()
        self.assertEqual(first, second)
        self.assertEqual(first.hex(), GOLDEN_HEX)

    def test_roundtrip_preserves_digest_offsets_counts_and_semantics(self):
        artifact = encode_h1sem1(
            hashlib.sha256(b"collision").digest(),
            (
                bytes((SemanticId.FLOOR_EXTERIOR,)),
                b"",
                bytes((SemanticId.RAMP, SemanticId.THRESHOLD)),
            ),
            mesh_triangle_counts=(1, 0, 2),
        )
        decoded = decode_h1sem1(
            artifact,
            expected_h1col2_sha256=hashlib.sha256(b"collision").digest(),
            expected_mesh_triangle_counts=(1, 0, 2),
        )
        self.assertEqual(decoded.mesh_count, 3)
        self.assertEqual(decoded.total_triangle_count, 3)
        self.assertEqual(decoded.mesh_offsets, (0, 1, 1, 3))
        self.assertEqual(decoded.mesh_triangle_counts, (1, 0, 2))
        self.assertEqual(decoded.semantics_for_mesh(1), b"")
        self.assertEqual(
            decoded.semantics_for_mesh(2),
            bytes((SemanticId.RAMP, SemanticId.THRESHOLD)),
        )

    def test_rejects_truncation_and_trailing_data(self):
        artifact = golden_artifact()
        with self.assertRaisesRegex(H1SEM1Error, "truncated H1SEM1"):
            decode_h1sem1(artifact[:-1])
        with self.assertRaisesRegex(H1SEM1Error, "trailing H1SEM1"):
            decode_h1sem1(artifact + b"x")
        with self.assertRaisesRegex(H1SEM1Error, "truncated H1SEM1 header"):
            decode_h1sem1(artifact[:63])

    def test_header_fields_are_exact_and_reserved_must_be_zero(self):
        artifact = bytearray(golden_artifact())
        fields = struct.unpack_from("<8s6I32s", artifact)
        self.assertEqual(fields[0], MAGIC)
        self.assertEqual(fields[1], VERSION)
        self.assertEqual(fields[2], HEADER_BYTES)
        self.assertEqual(fields[3], SEMANTIC_SCHEMA_VERSION)
        self.assertEqual(fields[4:7], (2, 5, 0))
        self.assertEqual(fields[7], DIGEST)

        struct.pack_into("<I", artifact, 28, 1)
        with self.assertRaisesRegex(H1SEM1Error, "reserved field must be zero"):
            decode_h1sem1(artifact)

    def test_rejects_incompatible_header_fields(self):
        mutations = (
            (0, b"NOTSEM1!", "invalid H1SEM1 magic"),
            (8, struct.pack("<I", 2), "unsupported H1SEM1 version 2"),
            (12, struct.pack("<I", 60), "invalid H1SEM1 header size 60"),
            (
                16,
                struct.pack("<I", 2),
                "unsupported H1SEM1 semantic schema version 2",
            ),
        )
        for offset, replacement, expected_error in mutations:
            with self.subTest(offset=offset):
                artifact = bytearray(golden_artifact())
                artifact[offset : offset + len(replacement)] = replacement
                with self.assertRaisesRegex(H1SEM1Error, expected_error):
                    decode_h1sem1(artifact)

    def test_rejects_bad_digest_shape_and_hash_mismatch(self):
        with self.assertRaisesRegex(H1SEM1Error, "raw 32-byte SHA256"):
            encode_h1sem1(b"short", ((SemanticId.ROAD,),))
        with self.assertRaisesRegex(H1SEM1Error, "SHA256 mismatch"):
            decode_h1sem1(
                golden_artifact(), expected_h1col2_sha256=b"x" * 32
            )

    def test_rejects_offset_and_mesh_cardinality_mismatches(self):
        final_offset_bad = bytearray(golden_artifact())
        struct.pack_into("<I", final_offset_bad, HEADER_BYTES + 8, 4)
        with self.assertRaisesRegex(H1SEM1Error, "final mesh offset"):
            decode_h1sem1(final_offset_bad)

        non_monotonic = bytearray(golden_artifact())
        struct.pack_into("<I", non_monotonic, HEADER_BYTES + 4, 6)
        with self.assertRaisesRegex(H1SEM1Error, "not monotonic"):
            decode_h1sem1(non_monotonic)

        with self.assertRaisesRegex(H1SEM1Error, "cardinality mismatch"):
            decode_h1sem1(
                golden_artifact(), expected_mesh_triangle_counts=(5,)
            )
        with self.assertRaisesRegex(H1SEM1Error, "mesh 0 triangle count mismatch"):
            encode_h1sem1(
                DIGEST,
                ((SemanticId.ROAD,),),
                mesh_triangle_counts=(2,),
            )

    def test_rejects_invalid_semantic_ids(self):
        with self.assertRaisesRegex(H1SEM1Error, "invalid semantic id 0"):
            encode_h1sem1(DIGEST, ((SemanticId.INVALID,),))
        with self.assertRaisesRegex(H1SEM1Error, "invalid semantic id 12"):
            encode_h1sem1(DIGEST, ((12,),))

        corrupted = bytearray(golden_artifact())
        corrupted[-1] = 255
        with self.assertRaisesRegex(H1SEM1Error, "invalid semantic id 255"):
            decode_h1sem1(corrupted)

    def test_strict_production_rejects_terrain_and_unknown(self):
        terrain = encode_h1sem1(DIGEST, ((SemanticId.TERRAIN,),))
        unknown = encode_h1sem1(DIGEST, ((SemanticId.UNKNOWN,),))

        with self.assertRaisesRegex(H1SEM1Error, "cannot contain terrain"):
            decode_h1sem1(terrain, strict_production=True)
        with self.assertRaisesRegex(H1SEM1Error, "cannot contain unknown"):
            decode_h1sem1(unknown, strict_production=True)
        with self.assertRaisesRegex(H1SEM1Error, "cannot contain terrain"):
            encode_h1sem1(
                DIGEST,
                ((SemanticId.TERRAIN,),),
                strict_production=True,
            )
        with self.assertRaisesRegex(H1SEM1Error, "cannot contain unknown"):
            encode_h1sem1(
                DIGEST,
                ((SemanticId.UNKNOWN,),),
                strict_production=True,
            )


if __name__ == "__main__":
    unittest.main()
