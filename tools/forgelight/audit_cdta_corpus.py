"""Deterministically audit strict CDTA parsing across an H1Z1 asset corpus."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Callable, Iterable

from cdta import parse_cdta


SCHEMA = "h1emu-cdta-corpus-audit-v1"


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def _failure_category(message: str, exception_name: str) -> str:
    if "unparsed bytes at byte" in message:
        return "trailing"
    if "incomplete uint16 index stream" in message:
        return "incomplete-index"
    return exception_name


def audit_assets(
    names: Iterable[str], read_asset: Callable[[str], bytes]
) -> dict[str, object]:
    """Audit assets in deterministic case-insensitive source-name order."""

    ordered_names = sorted(
        (name for name in names if name.lower().endswith(".cdt")),
        key=lambda name: (name.casefold(), name),
    )
    accepted = Counter()
    rejected = Counter()
    failures: list[dict[str, object]] = []
    inventory_rows: list[dict[str, object]] = []

    for name in ordered_names:
        raw = read_asset(name)
        source_sha256 = hashlib.sha256(raw).hexdigest()
        try:
            parsed = parse_cdta(raw, name)
            shape_key = f"v{parsed.version}-shapes{parsed.shape_count}"
            accepted[shape_key] += 1
            inventory_rows.append(
                {
                    "name": name,
                    "bytes": len(raw),
                    "sha256": source_sha256,
                    "accepted": shape_key,
                }
            )
        except Exception as error:
            message = str(error)
            category = _failure_category(message, type(error).__name__)
            rejected[category] += 1
            failure = {
                "name": name,
                "bytes": len(raw),
                "sha256": source_sha256,
                "category": category,
                "error": message,
            }
            failures.append(failure)
            inventory_rows.append({**failure, "accepted": None})

    return {
        "schema": SCHEMA,
        "total": len(ordered_names),
        "accepted": sum(accepted.values()),
        "acceptedByVersionShape": dict(sorted(accepted.items())),
        "rejected": sum(rejected.values()),
        "rejectedByCategory": dict(sorted(rejected.items())),
        "inventorySha256": hashlib.sha256(
            _canonical_json(inventory_rows)
        ).hexdigest(),
        "failures": failures,
    }


def _parse_expected_category(value: str) -> tuple[str, int]:
    try:
        category, count = value.rsplit("=", 1)
        return category, int(count)
    except (ValueError, TypeError) as error:
        raise argparse.ArgumentTypeError("expected CATEGORY=COUNT") from error


def _check_expectations(report: dict[str, object], args: argparse.Namespace) -> None:
    expected_scalars = {
        "total": args.expect_total,
        "accepted": args.expect_accepted,
        "rejected": args.expect_rejected,
    }
    mismatches = [
        f"{key}: expected {expected}, got {report[key]}"
        for key, expected in expected_scalars.items()
        if expected is not None and report[key] != expected
    ]
    actual_categories = report["rejectedByCategory"]
    assert isinstance(actual_categories, dict)
    for category, expected in args.expect_rejected_category:
        actual = actual_categories.get(category, 0)
        if actual != expected:
            mismatches.append(
                f"rejectedByCategory.{category}: expected {expected}, got {actual}"
            )
    if mismatches:
        raise RuntimeError("CDTA corpus expectation failed: " + "; ".join(mismatches))


def _load_asset_manager(assets_dir: Path):
    os.environ["H1Z1_ASSETS"] = str(assets_dir)
    import export_z1_collision

    return export_z1_collision._patched_get_manager(None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--assets",
        type=Path,
        default=Path(os.environ.get("H1Z1_ASSETS", "D:/h1z1/Resources/Assets")),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--expect-total", type=int)
    parser.add_argument("--expect-accepted", type=int)
    parser.add_argument("--expect-rejected", type=int)
    parser.add_argument(
        "--expect-rejected-category",
        action="append",
        type=_parse_expected_category,
        default=[],
        metavar="CATEGORY=COUNT",
    )
    args = parser.parse_args(argv)

    manager = _load_asset_manager(args.assets.resolve())
    report = audit_assets(
        manager.assets.keys(), lambda name: manager.get_raw(name).get_data()
    )
    _check_expectations(report, args)

    encoded = _canonical_json(report)
    if args.output:
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_name(output.name + ".tmp")
        temporary.write_bytes(encoded)
        os.replace(temporary, output)
    summary = {key: value for key, value in report.items() if key != "failures"}
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"[CDTA audit] {error}", file=sys.stderr)
        raise SystemExit(1)
