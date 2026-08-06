import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools.forgelight.capture_navigation_model_evidence import capture


class CaptureNavigationModelEvidenceTests(unittest.TestCase):
    def test_capture_requires_complete_non_vacuous_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "42"
            cache.mkdir()
            (cache / "z1_cache_0.bin").write_bytes(b"cache")
            source = root / "template.json"
            source.write_text("{}", encoding="utf-8")
            report = {
                "instances": 1,
                "routes": 2,
                "passed": 2,
                "failures": [],
                "forbiddenProbes": 1,
                "forbiddenEvaluated": 1,
                "forbiddenPassed": 1,
                "forbiddenFailures": [],
                "forbiddenUnverified": [],
                "cacheDirectories": {"42": str(cache)},
            }
            evidence = capture("House.adr", report, root, {"template": source})
            self.assertEqual(evidence["result"]["passed"], 2)
            self.assertEqual(evidence["streamingCaches"][0]["instanceIndex"], 42)

            report["forbiddenEvaluated"] = 0
            with self.assertRaisesRegex(ValueError, "every forbidden probe"):
                capture("House.adr", report, root, {"template": source})

    def test_committed_house36b_evidence_tracks_repository_inputs(self):
        repository = Path(__file__).resolve().parents[3]
        evidence = json.loads(
            (repository / "data/2016/navigationModelEvidence.house36B.json").read_text(
                encoding="utf-8"
            )
        )
        tracked = {
            "semanticPolicy": "tools/forgelight/policies/z1_collision.semantic_policy.json",
            "semanticRecipe": "data/2016/navigationSemanticRecipe.house36B.json",
            "validationTemplate": "data/2016/navigationModelValidation.house36B.json",
            "compiledTransitions": "data/2016/navigationTransitions.json",
        }
        for label, relative_path in tracked.items():
            raw = (repository / relative_path).read_bytes()
            self.assertEqual(
                evidence["inputs"][label]["sha256"], hashlib.sha256(raw).hexdigest()
            )
        self.assertEqual(evidence["result"]["passed"], 224)
        self.assertEqual(evidence["result"]["forbiddenPassed"], 120)
        self.assertEqual(len(evidence["streamingCaches"]), 8)

    def test_committed_house12a_evidence_tracks_repository_inputs(self):
        repository = Path(__file__).resolve().parents[3]
        evidence = json.loads(
            (repository / "data/2016/navigationModelEvidence.house12A.json").read_text(
                encoding="utf-8"
            )
        )
        tracked = {
            "semanticPolicy": "tools/forgelight/policies/z1_collision.semantic_policy.json",
            "semanticRecipe": "data/2016/navigationSemanticRecipe.house12A.json",
            "validationTemplate": "data/2016/navigationModelValidation.house12A.json",
            "compiledTransitions": "data/2016/navigationTransitions.json",
        }
        for label, relative_path in tracked.items():
            raw = (repository / relative_path).read_bytes()
            self.assertEqual(
                evidence["inputs"][label]["sha256"], hashlib.sha256(raw).hexdigest()
            )
        self.assertEqual(evidence["result"]["passed"], 572)
        self.assertEqual(evidence["result"]["forbiddenPassed"], 312)
        self.assertEqual(len(evidence["streamingCaches"]), 26)

    def test_committed_apartments06_evidence_tracks_repository_inputs(self):
        repository = Path(__file__).resolve().parents[3]
        evidence = json.loads(
            (
                repository / "data/2016/navigationModelEvidence.apartments06.json"
            ).read_text(encoding="utf-8")
        )
        tracked = {
            "semanticPolicy": "tools/forgelight/policies/z1_collision.semantic_policy.json",
            "semanticRecipe": "data/2016/navigationSemanticRecipe.apartments06.json",
            "validationTemplate": "data/2016/navigationModelValidation.apartments06.json",
            "compiledTransitions": "data/2016/navigationTransitions.json",
            "compiledTransitionProvenance": "data/2016/navigationTransitions.provenance.json",
            "placementSeams": "data/2016/navigationTransitions.apartments06.placements.json",
        }
        for label, relative_path in tracked.items():
            raw = (repository / relative_path).read_bytes()
            self.assertEqual(
                evidence["inputs"][label]["sha256"], hashlib.sha256(raw).hexdigest()
            )
        self.assertEqual(evidence["result"]["passed"], 182)
        self.assertEqual(evidence["result"]["forbiddenPassed"], 208)
        self.assertEqual(len(evidence["streamingCaches"]), 13)

    def test_committed_storefront_evidence_tracks_repository_inputs(self):
        repository = Path(__file__).resolve().parents[3]
        expected = {
            "01": (18, 144, 54),
            "02": (19, 152, 57),
            "03": (14, 112, 42),
        }
        for suffix, (instances, routes, forbidden) in expected.items():
            with self.subTest(storefront=suffix):
                evidence = json.loads(
                    (
                        repository
                        / f"data/2016/navigationModelEvidence.storeFront{suffix}.json"
                    ).read_text(encoding="utf-8")
                )
                tracked = {
                    "semanticPolicy": "tools/forgelight/policies/z1_collision.semantic_policy.json",
                    "semanticRecipe": f"data/2016/navigationSemanticRecipe.storeFront{suffix}.json",
                    "validationTemplate": f"data/2016/navigationModelValidation.storeFront{suffix}.json",
                    "compiledTransitions": "data/2016/navigationTransitions.json",
                    "compiledTransitionProvenance": "data/2016/navigationTransitions.provenance.json",
                }
                for label, relative_path in tracked.items():
                    raw = (repository / relative_path).read_bytes()
                    self.assertEqual(
                        evidence["inputs"][label]["sha256"],
                        hashlib.sha256(raw).hexdigest(),
                    )
                self.assertEqual(evidence["result"]["instances"], instances)
                self.assertEqual(evidence["result"]["passed"], routes)
                self.assertEqual(evidence["result"]["forbiddenPassed"], forbidden)
                self.assertEqual(len(evidence["streamingCaches"]), instances)

    def test_committed_hardwarestore01_evidence_tracks_repository_inputs(self):
        repository = Path(__file__).resolve().parents[3]
        evidence = json.loads(
            (
                repository / "data/2016/navigationModelEvidence.hardwareStore01.json"
            ).read_text(encoding="utf-8")
        )
        tracked = {
            "semanticPolicy": "tools/forgelight/policies/z1_collision.semantic_policy.json",
            "semanticRecipe": "data/2016/navigationSemanticRecipe.hardwareStore01.json",
            "validationTemplate": "data/2016/navigationModelValidation.hardwareStore01.json",
            "compiledTransitions": "data/2016/navigationTransitions.json",
            "compiledTransitionProvenance": "data/2016/navigationTransitions.provenance.json",
        }
        for label, relative_path in tracked.items():
            raw = (repository / relative_path).read_bytes()
            self.assertEqual(
                evidence["inputs"][label]["sha256"],
                hashlib.sha256(raw).hexdigest(),
            )
        self.assertEqual(evidence["result"]["instances"], 1)
        self.assertEqual(evidence["result"]["passed"], 8)
        self.assertEqual(evidence["result"]["forbiddenPassed"], 6)
        self.assertEqual(len(evidence["streamingCaches"]), 1)


if __name__ == "__main__":
    unittest.main()
