# Whole-map navigation crawl

`navmesh-crawl` replaces one-off per-building bake scripts with a deterministic
analysis and regional-validation pipeline. It is deliberately read-only with
respect to the canonical semantic policy, deployed navmesh, and installed
server.

## One-command campaign

For the standard sibling-worktree layout used during development, the campaign
runner discovers the pinned H1COL2 bundle, heightmap, transitions, policy, and
Release baker automatically:

```powershell
npm run navmesh-campaign
```

That analysis-only command regenerates a content-addressed candidate semantic
sidecar from the committed policy and runs the complete inventory/preparation
pipeline. Add `-- --bake` to build and validate every known model template, or
`-- --bake --model StoreFront --model HardwareStore` for a selected batch.
Regional outputs resume from the content-addressed cache. Progress is appended
to `work/staging/navigation-campaign-current/navigation-campaign.log`, exact
input hashes go to `navigation-campaign-inputs.json`, and the final result is
`navigation-crawl-latest.json`.

Use `--bundle`, `--heightmap`, `--baker`, or `--work-dir` when the repositories
do not use that sibling layout. The runner never changes the canonical policy,
performs a full-map bake, deploys files, or starts the server/client.

## Analysis mode

Analysis is the default:

```powershell
npm run navmesh-crawl -- `
  --collision C:\path\to\z1_collision.bin `
  --metadata C:\path\to\z1_collision.metadata.json `
  --semantics C:\path\to\candidate.semantics.bin `
  --heightmap C:\path\to\heightmap.png `
  --transitions data\2016\navigationTransitions.json `
  --work-dir C:\path\to\navigation-crawl
```

One run:

1. binds H1COL2, metadata, and H1SEM1 by SHA-256 and triangle cardinality;
2. inventories every `nav_unknown` archetype in world-impact order;
3. emits exact triangle-range proposals for kind-2 blockers and kind-0
   floor/stair candidates;
4. marks every highest flat composite band as roof-ambiguous;
5. prepares every canonical model route template in a cached collision pass;
6. writes `navigation-crawl-latest.json` with `PASS`, `REVIEW`, or `BLOCKED`
   state.

Analysis never admits a proposal. A reviewed semantic recipe and route evidence
are still required before the canonical policy changes.

## Regional bake mode

Add the explicit bake switch and builder:

```powershell
npm run navmesh-crawl -- <analysis arguments> `
  --bake `
  --baker C:\path\to\navmesh-builder.exe `
  --workers 2
```

Each regional job key includes the SHA-256 of the builder, collision, semantics,
heightmap, merged transitions, exact world bounds, profile, climb, and dynamic
door setting. A cache hit requires a matching `bake-manifest.json`, `z1_0.bin`,
and at least one `z1_cache_*.bin`; file existence by itself is not accepted.

Jobs build into unique temporary directories and are promoted only after the
complete contract passes. Equal jobs are built once, model views use hardlinks
when possible, and bounded workers prevent the old unbounded/manual bake loop.
Incomplete content-addressed directories fail closed and remain available for
inspection.

After baking, each model placement is validated in a fresh streaming runtime.
Only models whose complete routes and forbidden probes pass become `PASS` in
the crawl report. This status is validation evidence, not automatic policy
admission or deployment.

## Output layout

```text
<work-dir>/
  navigation-crawl-latest.json
  analysis/<analysis-key>/proposals.json
  prepared/<preparation-key>/<model>/
  transitions/<model>-<template-hash>.json
  cache/<regional-bake-key>/
  models/<model>/<model-key>/<instance>/
```

Re-running unchanged analysis reuses its exact keyed artifacts. Changing any
input creates a new identity rather than overwriting evidence from an older
run.
