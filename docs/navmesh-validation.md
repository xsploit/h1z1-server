# Navigation regional gates

Navigation artifacts are not eligible for a full-world deployment merely
because they load. They must pass deterministic regional topology gates before
the expensive bake is allowed to replace the installed baseline.

The versioned gate definitions live in
`data/2016/navigationValidationRegions.json`. Each region declares named world
anchors, accepted semantic area IDs, snap tolerances, and required route
segments. Segment rules can constrain detour distance, vertical corner steps,
and monotonic stair travel. This catches the failure modes visible in game:

- missing interior polygons;
- road, landing, threshold, and interior islands that do not connect;
- elevator-like vertical edges;
- stairs that stop partway;
- semantic data flattened into one generic walkable area;
- static geometry that snaps agents onto an elevated surface.

Run the gates against a streamed cache bundle:

```powershell
npm run navmesh-regions-check -- `
  --cache-dir "C:\path\to\data\2016\collision" `
  --report "$env:TEMP\navigation-regions.json"
```

The command exits nonzero when any required anchor or segment fails and emits a
machine-readable JSON report. The report is suitable for A/B comparison; do not
weaken a threshold simply to make a candidate bake green. Add or correct the
source classification/topology instead.

## Semantic area contract

| Area           |  ID | Runtime flags          |
| -------------- | --: | ---------------------- |
| terrain        |   1 | WALK                   |
| road           |   2 | WALK                   |
| exterior floor |   3 | WALK                   |
| interior floor |   4 | WALK, INDOOR           |
| stair          |   5 | WALK, TRANSITION       |
| ramp           |   6 | WALK, TRANSITION       |
| threshold      |   7 | WALK, TRANSITION, DOOR |

The legacy tile-cache value `63` is accepted only as a compatibility marker and
is reported as generic terrain. New semantic artifacts must retain their actual
area IDs through extraction, baking, and runtime tile materialization.

## Current baseline

The guarded July 29 runtime is intentionally red under the semantic gates. It
loads reliably, but the PV police interior is absent, the road-to-landing route
does not complete, one road-to-door path contains a 2.5 meter vertical corner,
and every classified anchor is still the legacy generic area. This report is
the baseline the new pipeline must beat; it is not a reason to replace the
working runtime early.
