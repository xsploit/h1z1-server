from pathlib import Path
import struct
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_cdta_corpus import SCHEMA, _check_expectations, audit_assets


def make_cdta(*, version=1, suffix=b""):
    metadata = (0,) if version == 1 else (0, 0x7F8301FF, 0)
    out = bytearray(b"CDTA")
    out.extend(struct.pack("<III", version, 0xEDC05F26, 1))
    out.extend(struct.pack(f"<{len(metadata)}I", *metadata))
    out.extend(struct.pack("<I", 3))
    out.extend(struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 0, 1))
    out.extend(struct.pack("<I3H", 1, 0, 1, 2))
    out.extend(struct.pack("<I", 0))
    out.extend(suffix)
    return bytes(out)


class _Args:
    expect_total = None
    expect_accepted = None
    expect_rejected = None
    expect_rejected_category = []


class AuditCDTACorpusTest(unittest.TestCase):
    def test_audit_is_deterministic_and_classifies_strict_rejections(self):
        assets = {
            "z.cdt": make_cdta(version=2),
            "A.CDT": make_cdta(suffix=b"alternate"),
            "ignored.txt": b"not collision",
            "a.cdt": make_cdta(version=1),
        }
        first = audit_assets(reversed(tuple(assets)), assets.__getitem__)
        second = audit_assets(assets, assets.__getitem__)

        self.assertEqual(first, second)
        self.assertEqual(first["schema"], SCHEMA)
        self.assertEqual(first["total"], 3)
        self.assertEqual(first["accepted"], 2)
        self.assertEqual(
            first["acceptedByVersionShape"],
            {"v1-shapes1": 1, "v2-shapes1": 1},
        )
        self.assertEqual(first["rejectedByCategory"], {"trailing": 1})
        self.assertEqual(first["failures"][0]["name"], "A.CDT")
        self.assertEqual(len(first["inventorySha256"]), 64)

    def test_inventory_hash_changes_when_source_bytes_change(self):
        base = audit_assets(["one.cdt"], lambda _: make_cdta())
        changed = audit_assets(["one.cdt"], lambda _: make_cdta(version=2))
        self.assertNotEqual(base["inventorySha256"], changed["inventorySha256"])

    def test_expectations_fail_closed(self):
        report = audit_assets(["one.cdt"], lambda _: make_cdta())
        args = _Args()
        args.expect_total = 2
        args.expect_rejected_category = [("trailing", 1)]
        with self.assertRaisesRegex(RuntimeError, "expected 2, got 1"):
            _check_expectations(report, args)


if __name__ == "__main__":
    unittest.main()
