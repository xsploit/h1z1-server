from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from artifact_bundle import ArtifactBundleError, publish_artifact_bundle


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def metadata_bytes(files: dict[str, bytes], generation: str) -> bytes:
    value = {
        "files": {name: digest(data) for name, data in sorted(files.items())},
        "generation": generation,
    }
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def metadata_matches(root: Path) -> bool:
    metadata = json.loads((root / "metadata.json").read_text("utf-8"))
    return all(
        (root / name).exists()
        and digest((root / name).read_bytes()) == expected
        for name, expected in metadata["files"].items()
    )


def temporary_files(root: Path) -> list[Path]:
    return [path for path in root.iterdir() if path.name.endswith(".tmp")]


class ArtifactBundleTests(unittest.TestCase):
    def test_success_replaces_metadata_last_and_cleans_temps(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payloads = {"collision.bin": b"collision", "semantics.bin": b"semantic"}
            replacements: list[str] = []

            def tracked_replace(source, destination):
                replacements.append(Path(destination).name)
                os.replace(source, destination)

            destinations = publish_artifact_bundle(
                root,
                payloads,
                "metadata.json",
                metadata_bytes(payloads, "new"),
                replace=tracked_replace,
            )

            self.assertEqual(
                replacements,
                ["collision.bin", "semantics.bin", "metadata.json"],
            )
            self.assertEqual(
                [path.name for path in destinations], replacements
            )
            self.assertTrue(metadata_matches(root))
            self.assertEqual(temporary_files(root), [])

    def test_each_replacement_failure_is_valid_or_fails_hash_closed(self):
        old_payloads = {"collision.bin": b"old collision", "semantics.bin": b"old semantic"}
        new_payloads = {"collision.bin": b"new collision", "semantics.bin": b"new semantic"}

        for fail_before in range(3):
            with self.subTest(fail_before=fail_before), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                for name, data in old_payloads.items():
                    (root / name).write_bytes(data)
                (root / "metadata.json").write_bytes(
                    metadata_bytes(old_payloads, "old")
                )
                replacement_index = 0

                def failing_replace(source, destination):
                    nonlocal replacement_index
                    if replacement_index == fail_before:
                        raise RuntimeError("injected replacement failure")
                    replacement_index += 1
                    os.replace(source, destination)

                with self.assertRaisesRegex(RuntimeError, "injected"):
                    publish_artifact_bundle(
                        root,
                        new_payloads,
                        "metadata.json",
                        metadata_bytes(new_payloads, "new"),
                        replace=failing_replace,
                    )

                metadata = json.loads(
                    (root / "metadata.json").read_text("utf-8")
                )
                self.assertEqual(metadata["generation"], "old")
                if fail_before == 0:
                    self.assertTrue(metadata_matches(root))
                else:
                    self.assertFalse(metadata_matches(root))
                self.assertEqual(temporary_files(root), [])

    def test_rejects_nonlocal_or_ambiguous_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid = ("../escape.bin", "nested/file.bin", "nested\\file.bin", "")
            for name in invalid:
                with self.subTest(name=name), self.assertRaises(ArtifactBundleError):
                    publish_artifact_bundle(
                        root, {name: b"x"}, "metadata.json", b"{}\n"
                    )

            with self.assertRaisesRegex(ArtifactBundleError, "metadata"):
                publish_artifact_bundle(
                    root,
                    {"metadata.json": b"payload"},
                    "metadata.json",
                    b"{}\n",
                )

            with self.assertRaisesRegex(ArtifactBundleError, "duplicate"):
                publish_artifact_bundle(
                    root,
                    {"A.bin": b"one", "a.BIN": b"two"},
                    "metadata.json",
                    b"{}\n",
                )

    def test_rejects_missing_directory_and_non_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ArtifactBundleError, "does not exist"):
                publish_artifact_bundle(
                    root / "missing", {"a.bin": b"x"}, "metadata.json", b"{}\n"
                )
            with self.assertRaisesRegex(ArtifactBundleError, "bytes-like"):
                publish_artifact_bundle(
                    root, {"a.bin": "not bytes"}, "metadata.json", b"{}\n"
                )


if __name__ == "__main__":
    unittest.main()
