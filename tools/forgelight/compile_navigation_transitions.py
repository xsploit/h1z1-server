"""Deterministically compile reviewed and model-generated navigation links."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _load(path: Path) -> tuple[list[dict], bytes]:
    raw = path.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError(f"{path} must contain a JSON array")
    return value, raw


def _point(value: object, field: str) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) < 3:
        raise ValueError(f"transition {field} must contain three coordinates")
    point = tuple(float(coordinate) for coordinate in value[:3])
    if not all(math.isfinite(coordinate) for coordinate in point):
        raise ValueError(f"transition {field} contains a non-finite coordinate")
    return point


def _validated(entry: object) -> dict:
    if not isinstance(entry, dict):
        raise ValueError("transition must be an object")
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("transition has no name")
    _point(entry.get("start"), "start")
    _point(entry.get("end"), "end")
    radius = float(entry.get("radius", 0.8))
    if not math.isfinite(radius) or radius <= 0:
        raise ValueError(f"transition {name} has an invalid radius")
    if "bidirectional" in entry and not isinstance(entry["bidirectional"], bool):
        raise ValueError(f"transition {name} has a non-boolean bidirectional flag")
    return entry


def _quantized(point: tuple[float, float, float]) -> tuple[int, int, int]:
    return tuple(round(coordinate * 1_000_000) for coordinate in point)


def _spatial_key(entry: dict) -> tuple:
    start = _quantized(_point(entry["start"], "start"))
    end = _quantized(_point(entry["end"], "end"))
    if bool(entry.get("bidirectional", True)) and end < start:
        start, end = end, start
    return start, end


def _runtime_projection(entry: dict) -> tuple:
    return (
        _spatial_key(entry),
        round(float(entry.get("radius", 0.8)) * 1_000_000),
        bool(entry.get("bidirectional", True)),
        entry.get("name"),
    )


def _runtime_entry(entry: dict) -> dict:
    allowed = ("name", "kind", "source", "start", "end", "radius", "bidirectional")
    return {field: entry[field] for field in allowed if field in entry}


def compile_transitions(authored: Iterable[dict], generated: Iterable[dict]) -> list[dict]:
    compiled: list[dict] = []
    by_spatial_key: dict[tuple, dict] = {}

    def add(candidate: object) -> None:
        entry = _runtime_entry(_validated(candidate))
        key = _spatial_key(entry)
        previous = by_spatial_key.get(key)
        if previous is not None:
            if _runtime_projection(previous) == _runtime_projection(entry):
                return
            raise ValueError(
                f"overlapping navigation transitions: {previous['name']} and {entry['name']}"
            )
        by_spatial_key[key] = entry
        compiled.append(entry)

    for entry in authored:
        add(entry)
    # Runtime geometry is the stable identity. Generator-only metadata is
    # deliberately stripped from the compiled artifact, so it cannot safely
    # participate in ordering (for example, instance 10 sorts before 9 as text
    # after a compiled artifact is fed back through the compiler).
    ordered_generated = sorted(
        (_runtime_entry(_validated(entry)) for entry in generated),
        key=_spatial_key,
    )
    for entry in ordered_generated:
        add(entry)
    return compiled


def encode(transitions: list[dict]) -> bytes:
    return (json.dumps(transitions, indent=2) + "\n").encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authored", required=True, type=Path)
    parser.add_argument(
        "--generated",
        action="append",
        default=[],
        metavar="LABEL=PATH",
        help="repeatable generated transition source",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    args = parser.parse_args()

    authored, authored_raw = _load(args.authored)
    generated_entries: list[dict] = []
    generated_sources = []
    for specification in args.generated:
        if "=" not in specification:
            raise ValueError("--generated must use LABEL=PATH")
        label, raw_path = specification.split("=", 1)
        if not label:
            raise ValueError("generated transition label is empty")
        path = Path(raw_path)
        entries, raw = _load(path)
        generated_entries.extend(entries)
        generated_sources.append(
            {
                "label": label,
                "sha256": _sha256(raw),
                "transitionCount": len(entries),
            }
        )

    compiled = compile_transitions(authored, generated_entries)
    output_raw = encode(compiled)
    provenance = {
        "schemaVersion": 1,
        "outputSha256": _sha256(output_raw),
        "transitionCount": len(compiled),
        "authoredSource": {
            "path": args.authored.as_posix(),
            "sha256": _sha256(authored_raw),
            "transitionCount": len(authored),
        },
        "generatedSources": generated_sources,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.provenance.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output_raw)
    args.provenance.write_text(
        json.dumps(provenance, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "transitionCount": len(compiled),
                "sha256": provenance["outputSha256"],
            }
        )
    )


if __name__ == "__main__":
    main()
