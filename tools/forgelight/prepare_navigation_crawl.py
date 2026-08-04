"""Prepare every canonical navigation archetype in one collision-file pass."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from prepare_model_instance_validation import heightmap_sampler, prepare


def slug(actor_file: str) -> str:
    return re.sub(r"(^-|-$)", "", re.sub(r"[^a-z0-9]+", "-", actor_file.casefold().removesuffix(".adr")))


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def prepare_all(
    collision: Path,
    metadata: Path,
    template_paths: list[Path],
    output_directory: Path,
    heightmap: Path | None,
    selectors: list[str],
) -> dict:
    sampler = heightmap_sampler(heightmap) if heightmap else None
    selected = []
    lowered = [selector.casefold() for selector in selectors]
    for template_path in sorted(template_paths, key=lambda path: path.name.casefold()):
        template = json.loads(template_path.read_text(encoding="utf-8"))
        actor = template.get("actorFile", "")
        if lowered and not any(selector in actor.casefold() for selector in lowered):
            continue
        selected.append((template_path, actor))
    if selectors:
        matched = {selector: False for selector in selectors}
        for _path, actor in selected:
            for selector in selectors:
                if selector.casefold() in actor.casefold():
                    matched[selector] = True
        missing = [selector for selector, found in matched.items() if not found]
        if missing:
            raise ValueError(f"model selectors matched no templates: {missing}")

    output_directory.mkdir(parents=True, exist_ok=True)
    models = []
    for template_path, actor in selected:
        destination = output_directory / slug(actor)
        destination.mkdir(parents=True, exist_ok=True)
        bakes, routes, skipped, forbidden, transitions = prepare(
            collision, metadata, template_path, sampler
        )
        write_json(destination / "bakes.json", bakes)
        write_json(destination / "routes.json", routes)
        write_json(destination / "skipped.json", skipped)
        write_json(destination / "forbidden.json", forbidden)
        write_json(destination / "transitions.json", transitions)
        models.append({
            "actorFile": actor,
            "slug": slug(actor),
            "templatePath": str(template_path.resolve()),
            "templateSha256": hashlib.sha256(template_path.read_bytes()).hexdigest(),
            "outputDirectory": str(destination.resolve()),
            "instances": len(bakes),
            "skippedInstances": len(skipped),
            "routes": len(routes),
            "forbiddenProbes": len(forbidden),
            "transitions": len(transitions),
        })
    result = {"schemaVersion": 1, "models": models}
    write_json(output_directory / "prepared-models.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("collision", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("templates_directory", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--heightmap", type=Path)
    parser.add_argument("--model", action="append", default=[])
    args = parser.parse_args()
    templates = list(args.templates_directory.glob("navigationModelValidation.*.json"))
    result = prepare_all(
        args.collision,
        args.metadata,
        templates,
        args.output_directory,
        args.heightmap,
        args.model,
    )
    print(f"[nav-prepare] prepared {len(result['models'])} archetypes")


if __name__ == "__main__":
    main()
