"""Capture a compact, path-independent record of a streamed model validation."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def file_record(path: Path) -> dict:
    raw = path.read_bytes()
    return {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}


def capture(
    actor_file: str,
    report: dict,
    cache_root: Path,
    inputs: dict[str, Path],
) -> dict:
    if report.get("failures"):
        raise ValueError("route validation report contains failures")
    if report.get("forbiddenFailures"):
        raise ValueError("validation report contains forbidden-surface failures")
    if report.get("forbiddenUnverified"):
        raise ValueError("validation report contains unverified forbidden probes")
    if report.get("passed") != report.get("routes") or not report.get("routes"):
        raise ValueError("validation report does not prove every route")
    if (
        report.get("forbiddenEvaluated") != report.get("forbiddenProbes")
        or report.get("forbiddenPassed") != report.get("forbiddenProbes")
    ):
        raise ValueError("validation report does not prove every forbidden probe")

    cache_directories = report.get("cacheDirectories")
    if not isinstance(cache_directories, dict) or not cache_directories:
        raise ValueError("validation report has no per-instance cache map")
    if int(report.get("instances", -1)) != len(cache_directories):
        raise ValueError("validation report instance count does not match its cache map")
    caches = []
    for raw_instance in sorted(cache_directories, key=int):
        instance = int(raw_instance)
        directory = cache_root / raw_instance
        parts = sorted(directory.glob("z1_cache_*.bin"))
        if not parts:
            raise ValueError(f"instance {instance} has no streaming cache parts")
        caches.append(
            {
                "instanceIndex": instance,
                "parts": [
                    {"name": part.name, **file_record(part)} for part in parts
                ],
            }
        )

    return {
        "schemaVersion": 1,
        "actorFile": actor_file,
        "inputs": {
            label: file_record(path) for label, path in sorted(inputs.items())
        },
        "streamingCaches": caches,
        "result": {
            "instances": int(report["instances"]),
            "routes": int(report["routes"]),
            "passed": int(report["passed"]),
            "forbiddenProbes": int(report["forbiddenProbes"]),
            "forbiddenEvaluated": int(report["forbiddenEvaluated"]),
            "forbiddenPassed": int(report["forbiddenPassed"]),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--actor", required=True)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--cache-root", required=True, type=Path)
    parser.add_argument("--input", action="append", default=[], metavar="LABEL=PATH")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inputs = {}
    for specification in args.input:
        if "=" not in specification:
            raise ValueError("--input must use LABEL=PATH")
        label, raw_path = specification.split("=", 1)
        if not label or label in inputs:
            raise ValueError(f"invalid or duplicate input label {label!r}")
        inputs[label] = Path(raw_path)
    if not inputs:
        raise ValueError("at least one --input is required")
    report = json.loads(args.report.read_text(encoding="utf-8"))
    evidence = capture(args.actor, report, args.cache_root, inputs)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence["result"], sort_keys=True))


if __name__ == "__main__":
    main()
