import hashlib
import json
import unittest
from pathlib import Path

from tools.forgelight.compile_navigation_transitions import compile_transitions, encode


class CompileNavigationTransitionsTests(unittest.TestCase):
    def test_compilation_is_deterministic_and_idempotent(self):
        authored = [
            {
                "name": "authored",
                "start": [0, 0, 0],
                "end": [1, 0, 0],
                "radius": 0.4,
                "bidirectional": True,
            }
        ]
        generated = [
            {
                "name": "generated",
                "actorFile": "House.adr",
                "instanceIndex": 4,
                "start": [2, 0, 0],
                "end": [3, 0, 0],
                "radius": 0.5,
                "bidirectional": True,
            }
        ]
        first = compile_transitions(authored, generated)
        second = compile_transitions(first, generated)
        self.assertEqual(encode(first), encode(second))
        self.assertEqual(len(first), 2)
        self.assertNotIn("actorFile", first[1])
        self.assertNotIn("instanceIndex", first[1])

    def test_conflicting_overlapping_links_are_rejected(self):
        first = {
            "name": "first",
            "start": [0, 0, 0],
            "end": [1, 0, 0],
            "radius": 0.4,
            "bidirectional": True,
        }
        conflict = {
            "name": "conflict",
            "start": [1, 0, 0],
            "end": [0, 0, 0],
            "radius": 0.4,
            "bidirectional": True,
        }
        with self.assertRaisesRegex(ValueError, "overlapping navigation transitions"):
            compile_transitions([first], [conflict])

    def test_order_is_stable_when_instance_indices_cross_digit_boundaries(self):
        generated = [
            {
                "name": f"House.adr #{instance}",
                "actorFile": "House.adr",
                "instanceIndex": instance,
                "start": [float(instance), 0, 0],
                "end": [float(instance) + 0.5, 0, 0],
                "radius": 0.4,
                "bidirectional": True,
            }
            for instance in (10, 9)
        ]
        first = compile_transitions([], generated)
        second = compile_transitions([], first)
        self.assertEqual(encode(first), encode(second))
        self.assertEqual([entry["start"][0] for entry in first], [9.0, 10.0])

    def test_committed_world_transition_artifact_matches_provenance(self):
        repository = Path(__file__).resolve().parents[3]
        compiled_path = repository / "data/2016/navigationTransitions.json"
        authored_path = repository / "data/2016/navigationTransitions.authored.json"
        provenance_path = repository / "data/2016/navigationTransitions.provenance.json"
        compiled_raw = compiled_path.read_bytes()
        compiled = json.loads(compiled_raw)
        authored = json.loads(authored_path.read_text(encoding="utf-8"))
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))

        self.assertEqual(len(authored), 5)
        self.assertEqual(len(compiled), 127)
        self.assertEqual(
            sum(entry["name"].startswith("Common_Structures_Houses_House36B.adr #") for entry in compiled),
            64,
        )
        self.assertEqual(
            sum(
                entry["name"].startswith(
                    "Common_Structures_Apartments_Apartments06.adr #"
                )
                for entry in compiled
            ),
            58,
        )
        self.assertEqual(
            encode(compile_transitions(authored, compiled[len(authored) :])),
            compiled_raw,
        )
        self.assertEqual(provenance["transitionCount"], len(compiled))
        self.assertEqual(
            provenance["outputSha256"], hashlib.sha256(compiled_raw).hexdigest()
        )

    def test_apartments06_placement_seams_have_explicit_instance_bindings(self):
        repository = Path(__file__).resolve().parents[3]
        seams = json.loads(
            (
                repository
                / "data/2016/navigationTransitions.apartments06.placements.json"
            ).read_text(encoding="utf-8")
        )
        actor = "Common_Structures_Apartments_Apartments06.adr"
        self.assertEqual(len(seams), 6)
        for seam in seams:
            self.assertEqual(seam["actorFile"], actor)
            self.assertIn(f"#{seam['instanceIndex']} ", seam["name"])


if __name__ == "__main__":
    unittest.main()
