# Navigation regional gates

## Model-oriented navigation doctor

Use the navigation doctor before authorizing a regional or full-world bake.
Its default mode is read-only: it ranks kind-0 composite/building meshes by
their placed-world unknown-triangle impact, binds every reusable model-route
template, and reports which high-impact archetype needs probes next.

Generate the inventory from the exact H1SEM1 sidecar used by the candidate
bake. This overrides older histograms embedded in metadata while checking the
collision digest and every mesh's triangle cardinality:

```powershell
py -3 tools\forgelight\inventory_nav_unknown.py `
  "C:\path\to\z1_collision.metadata.json" `
  --collision "C:\path\to\z1_collision.bin" `
  --semantics "C:\path\to\z1_collision.semantics.bin" `
  --json "C:\path\to\nav-unknown-current.json"
```

```powershell
npm run navmesh-doctor -- `
  --inventory "C:\path\to\nav-unknown-current.json" `
  --limit 20 `
  --report "$env:TEMP\navigation-doctor.json" `
  --markdown "$env:TEMP\navigation-doctor.md"
```

Existing templates can be transformed across every matching H1COL2 placement
and checked against a streamed cache without mutating the cache or server:

```powershell
npm run navmesh-doctor -- `
  --prepare `
  --inventory "C:\path\to\nav-unknown-current.json" `
  --collision "C:\path\to\z1_collision.bin" `
  --metadata "C:\path\to\z1_collision.metadata.json" `
  --heightmap "C:\path\to\heightmap.png" `
  --cache-dir "C:\path\to\data\2016\collision" `
  --work-dir "$env:TEMP\navigation-doctor-work" `
  --model Office03
```

`--model` may be repeated. Preparation verifies that the collision binary and
metadata share the exact SHA-256 identity. Each placement is validated in a
fresh bounded Recast process so distant-model iteration cannot exhaust one
mutable WASM TileCache. The doctor never bakes, composes, deploys, or changes
game/server files.

### House36B measured baseline

`data/2016/navigationModelValidation.house36B.json` captures two exterior
stair chains and the main-floor-to-second-floor staircase in model-local
coordinates. The points come from exact H1COL2 triangle evidence rather than
visual estimates. Transforming the template found all 8 world placements and
produced 224 bidirectional route segments without skipping a terrain-mismatched
instance.

Against collision `ce8ca93c8b3d3607d829b323580b6cad60723ea46c7f46eb0e8f16ed38656065`
and the currently tested full-world cache, only 70/224 segments pass. All 80
interior-stair segments fail (10 segments across 8 placements), the north
entrance mostly fails, and the south entrance is only partly connected. This
is the pinned pre-classification baseline for a bounded House36B candidate;
it demonstrates missing topology without authorizing a full-world bake.

The accepted post-classification checkpoint is deliberately recorded
separately from that historical baseline. The current streamed admission gate
resolves all eight per-instance regional caches, requires positive mesh
presence before crediting a forbidden probe, and reports 224/224 routes plus
120/120 evaluated forbidden-roof probes. The five authored PV links, 64
generated House36B links, 52 generated Apartments06 model links, and six
evidence-backed Apartments06 placement seams are compiled into the
provenance-bound canonical
`data/2016/navigationTransitions.json`; no full-world rebake is required to
replay this regional evidence.

### Apartments06 measured admission

`data/2016/navigationModelValidation.apartments06.json` expands across all 13
exact placements. The streamed regional gate proves 182/182 entrance,
inter-floor, and full-height routes and 208/208 forbidden roof/parapet probes.
Only six placement-specific seams are retained, each produced from exact
disconnected polygon-edge evidence with `scripts/diagnoseModelRouteSeam.ts`.
The regional result is pinned in
`data/2016/navigationModelEvidence.apartments06.json`.

## Recoverable runtime and bundle deployment

`scripts/deployNavigationArtifact.ps1` deploys a compiled navigation runtime
and an already-staged navigation bundle as one recoverable transaction. The
bundle source is mandatory and may not be the installed `data/2016` directory.
The script verifies its manifest before changing QuickStart, refuses to deploy
while an H1Emu Node process is running, copies every source into a same-volume
stage, and backs up every installed file it will replace or remove.

Only runtime closure files, files named by the staged manifest, the manifest
itself, and obsolete `collision/z1_cache_*.bin` parts are in scope. Other
QuickStart data is neither copied nor removed. Installed manifest verification
runs after replacement; a partial operation or failed post-check restores the
whole runtime-and-bundle set from the backup.

Inspect the exact transaction without changing files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/deployNavigationArtifact.ps1 `
  -QuickStartRoot "C:\path\to\h1z1-server-QuickStart-master" `
  -NavigationBundleSourceRoot "C:\path\to\staged\data\2016" `
  -Plan
```

After reviewing the plan and stopping the server, omit `-Plan` to deploy. Use
`-SkipBuild` only when the current checkout's `out` runtime was already built
and verified. Backups are retained under `QuickStartRoot/backups`; temporary
staging is removed after success or rollback.

Navigation artifacts are not eligible for a full-world deployment merely
because they load. They must pass deterministic regional topology gates before
the expensive bake is allowed to replace the installed baseline.

The default evidence-backed gate definitions live in
`data/2016/navigationValidationRegions.pvEvidence.json`. Each region declares
named world anchors, accepted semantic area IDs, snap tolerances, and required
route segments. Segment rules can constrain detour distance, vertical corner
steps, and monotonic stair travel. This catches the failure modes visible in
game:

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

Report provenance identifies the validation configuration by hashing canonical
parsed JSON. Line endings, indentation, and object-key formatting therefore do
not make semantically identical gates appear incompatible across worktrees.

Run the same gates with manual off-mesh transitions disabled before accepting
a bake:

```powershell
npm run navmesh-regions-check -- `
  --cache-dir "C:\path\to\data\2016\collision" `
  --topology-only `
  --report "$env:TEMP\navigation-topology-only.json"
```

The normal report proves the deployed runtime behavior. The topology-only
report proves that roads, thresholds, floors, and stairs are connected by the
baked polygons themselves. A manual transition may remain as a runtime safety
net, but it cannot make an otherwise disconnected candidate eligible for a
full bake or deployment.

## Regional overlay seam contract

A regional tile-cache replacement must also pass
`data/2016/navigationValidationRegions.pvOverlaySeams.json`. Its
`cardinalSeamGate` records the global tile origin, tile size, and half-open
replacement rectangle. Exactly one required segment must be tagged for each of
`west`, `east`, `south`, and `north`; a missing or duplicate direction makes the
configuration invalid. Both the declared anchors and the polygons returned by
Detour must straddle the matching replacement edge. This prevents a broad snap
from making two same-side polygons look like a valid seam crossing.

Run the four PV seam routes in both runtime modes:

```powershell
npm run navmesh-pv-seams-check -- `
  --cache-dir "C:\path\to\data\2016\collision" `
  --report "$env:TEMP\pv-seams.json"

npm run navmesh-pv-seams-check -- `
  --cache-dir "C:\path\to\data\2016\collision" `
  --topology-only `
  --report "$env:TEMP\pv-seams-topology-only.json"
```

The PV replacement rectangle is tile coverage `[148,112,152,118)` at global
origin `(-4096.5,-4096.5)` and tile size `25.6`, so its world-space edges are
`x=-307.7`, `x=-205.3`, `z=-1229.3`, and `z=-1075.7`. The configured anchors
were selected from actual V13 Detour snap and corridor evidence, not estimated
from the map image.

Compare a candidate with the preserved baseline report:

```powershell
npm run navmesh-regions-compare -- `
  --baseline "$env:TEMP\navigation-baseline.json" `
  --candidate "$env:TEMP\navigation-candidate.json"
```

An intermediate candidate passes only when it improves at least one named gate
and regresses none. Add `--require-pass` before a full-world bake or deployment;
that mode also requires every candidate gate to be green.

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
