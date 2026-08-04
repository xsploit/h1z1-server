# Navigation Project: Journey, Current State, and Roadmap

Last verified: 2026-08-03

This document is the canonical project record for the Z1 navigation work. It
explains why the work exists, what was tried, what is actually deployed, what
has been proved, what remains broken, and how to turn the current experiments
into reviewable upstream pull requests.

The most important rule is to keep four different things separate:

1. **Source state**: commits in `h1z1-server`, `h1emu-recast`, the extractor,
   and `pydmod`.
2. **Bake input and staged output**: generated collision, semantics,
   heightmap, transition, navmesh, and tile-cache files outside Git.
3. **Installed runtime**: the package and artifact currently used by
   QuickStart when the game is launched.
4. **Observed behavior**: automated route evidence plus what was actually
   seen in the 2016 client.

A healthy source checkout does not prove the installed server is current. A
successful bake does not prove it was deployed. A valid runtime manifest does
not prove that the artifact has source-complete provenance. This project has
hit every one of those traps, so the distinctions are deliberate.

## Executive summary

The project started with a practical single-player goal: keep H1Z1's existing
zombie, wildlife, combat, loot, and construction systems, then add useful
human NPCs and make all NPCs navigate the real world well enough to create a
credible PvE survival game.

The original navigation data was adequate outdoors but unreliable around
roads, sidewalks, one-step entrances, doors, stairs, multi-floor buildings,
and player or vehicle obstacles. Human NPCs exposed the same problems more
visibly than zombies: floating, running in place, taking wall shortcuts,
sleeping at bad times, and occasionally causing the server simulation to stop.

The current solution combines:

- native ForgeLight collision extracted from the game assets;
- an 8192 x 8192 terrain heightmap;
- deterministic H1COL2 collision and H1CID1 instance identities;
- per-triangle H1SEM1 navigation semantics;
- a native ForgeLight geometry provider in `h1emu-recast`;
- authored transitions for topology that cannot be recovered reliably from
  raw triangle slope alone;
- a streamed Detour TileCache runtime that stays within the 32-bit WASM
  poly-reference budget;
- artifact manifests, transactional deployment, watchdogs, and targeted route
  validators.

The full-map candidate baked successfully and is installed. It improved the
common building-model route suite from **1,236/2,268 (54.5%)** to
**2,232/2,268 (98.4%)**. In the client, the Pleasant Valley police station now
supports the front road-to-entry route, basement-to-main-floor movement, and
main-floor-to-second-floor movement. Common small-step entrances are greatly
improved.

This is a major navigation improvement, but it is not finished production
work. NPCs can still take wall shortcuts, clip through some doors and props,
pass through drivable vehicles and characters, and end up able to attack from
an invalid side of a wall. The installed artifact is also marked
`runtime-only`: it is byte-verified and runnable, but its manifest does not yet
contain complete source provenance or a semantic source report.

The next release should therefore focus on **movement collision and line of
sight**, followed by surgical topology repairs. It should not start with
another blind full-map bake.

## Goals and non-goals

### Goals

- Preserve and extend the existing H1emu zombie, wildlife, combat, loot,
  crafting, construction, and networking systems.
- Make zombies and human NPCs navigate outdoor terrain, entrances, interiors,
  stairs, and multiple floors without floating or walking through solid
  geometry.
- Keep the server stable on the 32-bit Recast/Detour WASM runtime currently
  used by H1emu.
- Make every generated artifact reproducible, attributable, validated, and
  safely deployable.
- Upstream generally useful navigation, collision, validation, and deployment
  work rather than keeping it private.

### Non-goals for the navigation PR

- A complete companion, faction, mission, reputation, or survivor-looting
  game design.
- Client binary modification or replacement of the client physics engine.
- Pretending the navmesh itself is a full collision or hit-detection system.
- Shipping generated full-map binaries in a normal source PR unless the
  maintainers explicitly choose an artifact distribution mechanism.

## Repository and runtime map

### Canonical repositories

| Role                                                     | Repository                       | Branch and implementation checkpoint                                                       |
| -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| Server runtime, semantics policy, validators, deployment | `work/h1z1-pv-nav`               | `feat/nav-artifact-contract` at `488dbccdb4f94e9f76a6988c6570404d9f618bfe` before this doc |
| Recast baker and native ForgeLight geometry source       | `work/h1emu-recast`              | `feat/semantic-nav-areas` at `cbba41741cd4ba122d5b0906a819c717156e2ab1`                    |
| Deterministic map-data extraction                        | `work/h1emu-map-data-extraction` | `feat/deterministic-nav-semantics-extractor` at `6bf02d2627e01c66b4061df74ebd82524bd6ade0` |
| ForgeLight asset decoding                                | `work/pydmod`                    | `master` at `d220703826b39bdccd54956782e57809696226b5d`                                    |

The canonical server fork is `xsploit/h1z1-server`. Its upstream PR target
should be H1emu's `dev` branch, not QuentinGruber's `master`. The baker fork is
`xsploit/h1emu-recast`, based on `H1emu/h1emu-recast`.

Untracked bake directories and local extraction outputs exist in the baker,
extractor, and `pydmod` checkouts. They are generated/user-owned data and must
not be erased or accidentally committed.

### Current workstation paths

These absolute paths describe the machine on which the current artifact was
built and tested. They are operational notes, not portable source paths, and
can be removed or generalized before an upstream PR if maintainers prefer.

| Item                           | Absolute path                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Workspace                      | `C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal` |
| Canonical server source        | `...\work\h1z1-pv-nav`                                                                     |
| Canonical baker source         | `...\work\h1emu-recast`                                                                    |
| Extractor source               | `...\work\h1emu-map-data-extraction`                                                       |
| Asset decoder                  | `...\work\pydmod`                                                                          |
| Current full bake              | `...\work\staging\full-common-entrances-v1`                                                |
| Deployable bundle              | `...\work\staging\full-common-entrances-v1-bundle\data\2016`                               |
| QuickStart root                | `C:\Users\SUBSECT\Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master`      |
| Installed package              | `...\h1z1-server-QuickStart-master\node_modules\h1z1-server`                               |
| Installed artifact manifest    | `...\node_modules\h1z1-server\data\2016\navigation-artifact-manifest.json`                 |
| Game assets used by extraction | `C:\Users\SUBSECT\Documents\H1Z1-2016\Resources\Assets`                                    |
| Persistent server console      | `C:\Users\SUBSECT\AppData\Roaming\h1emu\logs\server-console-latest.log`                    |
| Watchdog events                | `C:\Users\SUBSECT\AppData\Roaming\h1emu\logs\server-watchdog.jsonl`                        |

### Candidate, evidence, and rollback inventory

The current full candidate directory is the source of truth for this bake. It
contains:

| File or directory                                                   | Purpose                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `full-common-entrances-v1/run-bake.ps1`                             | Exact baker binary, inputs, flags, and full-world bounds used for this run.  |
| `full-common-entrances-v1/bake.console.log`                         | Persistent 11.8 MB builder output, including warnings and completion counts. |
| `full-common-entrances-v1/bake.status.txt`                          | Machine-readable start, finish, exit status, and completion marker.          |
| `full-common-entrances-v1/z1_0.bin`                                 | Direct-nav fallback part.                                                    |
| `full-common-entrances-v1/z1_cache_0.bin` through `z1_cache_21.bin` | Full streamed cache output.                                                  |
| `full-common-entrances-v1/z1_collision.semantics.bin`               | Exact H1SEM1 semantic input used by this bake.                               |
| `full-common-entrances-v1/model-routes-streaming.json`              | Candidate common-model route evidence.                                       |
| `full-common-entrances-v1/baseline-model-routes-streaming.json`     | Installed-baseline common-model evidence.                                    |
| `full-common-entrances-v1/pv-evidence-streaming.json`               | Candidate PV police-station evidence.                                        |
| `full-common-entrances-v1/pv-seams-streaming.json`                  | Candidate PV overlay-seam evidence.                                          |
| `full-common-entrances-v1/baseline-pv-*.json`                       | Matching installed-baseline PV evidence.                                     |
| `full-common-entrances-v1-bundle/data/2016`                         | Manifested bundle used by deployment.                                        |

The exact current inputs/binaries have these identities:

| Input                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| Baker `navmesh-builder.exe` | `ec831f81afe88126d06bf106a6d2805d1b33715ef7446c097d9aedb1b6caec3e` |
| Collision semantic policy   | `cf739b3ce38a77ec8ea53986468ee6bc73e2da1bdd640fa341c4ffc763a7f936` |
| Candidate H1SEM1            | `f26dbe47d156ad5800cc7c45d92dee01acd964205686f521a1ba57c29d82c1cc` |
| H1COL2                      | `ce8ca93c8b3d3607d829b323580b6cad60723ea46c7f46eb0e8f16ed38656065` |
| Heightmap                   | `78799a6429aaf910cc5c38fe4d8ebfa15d79096c272e77faa3cc2a089ecadc21` |
| Authored transitions        | `600f0a61e8bf485848ac8e09918d02a31e06388ac2b2b2794b9d9c0150a8a49e` |

The deployment created these rollback checkpoints:

- `QuickStart-master/backups/nav-artifact-contract-20260803-174010`
- `QuickStart-master/backups/zoneserver-ai-target-20260803-174228`

Older staging directories and backups are historical experiments, not the
current artifact. Do not delete them as part of ordinary source cleanup; first
prove they are not referenced and that the current candidate, bundle, and two
rollback checkpoints are preserved elsewhere.

### Existing focused documentation

This document is the overall record. These files remain the focused technical
references:

- `docs/navmesh-source-pipeline.md`: source extraction and semantic pipeline.
- `docs/navmesh-hybrid-source.md`: historical hybrid/regional composition.
- `docs/navmesh-streaming.md`: streamed cache runtime and lifecycle.
- `docs/navmesh-validation.md`: validators and acceptance evidence.
- `docs/survivor-ai-roadmap.md`: gameplay-facing survivor AI roadmap.
- `docs/client-crash-diagnostics.md`: client crash diagnostics.
- `tools/forgelight/README.md`: ForgeLight extraction and policy tools.

Older root-level handoff documents are historical snapshots. Where they
conflict with this file, this file and the current manifests/source win.

## End-to-end architecture

The current data flow is:

```text
ForgeLight packs/CDTA + zone placements
        |
        v
pydmod + h1emu-map-data-extraction
        |
        +--> H1COL2 collision geometry
        +--> H1CID1 stable instance identities
        +--> 8192 x 8192 terrain heightmap
        |
        v
h1z1-server semantic policy
        |
        +--> H1SEM1 per-triangle navigation semantics
        +--> authored navigationTransitions.json
        |
        v
h1emu-recast ForgeLight GeometrySource
        |
        +--> direct navmesh part(s): z1_*.bin
        +--> streamed TileCache parts: z1_cache_*.bin
        |
        v
navigation artifact manifest + validators
        |
        v
transactional QuickStart deployment
        |
        v
server-side Detour crowd + H1COL2 collision queries
```

### Data contracts

- **H1COL2** contains deterministic mesh geometry and placed instances. The
  deployed collision source has 820 meshes, 149,976 instances, and 505,628
  source triangles.
- **H1CID1** provides stable per-instance zone identities so a policy and its
  evidence can refer to placements deterministically.
- **H1SEM1** binds one semantic ID to every H1COL2 source triangle and binds
  itself to the exact collision SHA-256.
- **TSET** files contain compressed Detour TileCache layers loaded on demand by
  the server.
- **navigationTransitions.json** currently contains five authored transitions.
  These represent intentional traversals that raw rasterization cannot infer
  reliably enough.
- **navigation-artifact-manifest.json** binds the runtime files by path, size,
  hash, header, and artifact ID.

### Semantic IDs

The current semantic schema is:

|  ID | Name                 | Meaning                                                       |
| --: | -------------------- | ------------------------------------------------------------- |
|   0 | `invalid`            | Invalid/uninitialized                                         |
|   1 | `terrain`            | Terrain lattice                                               |
|   2 | `road`               | Road or sidewalk surface                                      |
|   3 | `floor_exterior`     | Exterior walkable floor/porch                                 |
|   4 | `floor_interior`     | Interior floor/landing                                        |
|   5 | `stair`              | Traversable stair surface                                     |
|   6 | `ramp`               | Traversable ramp                                              |
|   7 | `threshold`          | Door/entrance connection surface                              |
|   8 | `obstacle_static`    | Static solid geometry                                         |
|   9 | `door_panel_dynamic` | Door panel handled dynamically                                |
|  10 | `exclude`            | Deliberately non-navigable geometry, including reviewed roofs |
|  11 | `unknown`            | Not yet reviewed/classified                                   |

The current candidate H1SEM1 histogram, in the order above, is:

```text
[0, 0, 6112, 1120, 272, 138, 0, 95, 80634, 2519, 2927, 411811]
```

This is why the candidate is not strict-production semantic input: 411,811
triangles remain `unknown`. The current baker handles this candidate for the
runtime experiment, but strict production inspection rejects it immediately.

## Important source files

### Server repository

| File                                                          | Responsibility                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/recast.ts`                                         | Loads direct/streamed nav data, owns the live Detour runtime, materializes columns, manages crowd agents and obstacles, and performs recycling/recovery. |
| `src/utils/navigationartifacts.ts`                            | Reads and verifies artifact manifests, hashes, file closure, and cache headers.                                                                          |
| `src/utils/navigationareas.ts`                                | Shared semantic area/flag definitions used by runtime and validators.                                                                                    |
| `src/servers/ZoneServer2016/managers/collisionmanager.ts`     | Loads H1COL2, builds BVH/broadphase data, performs ground rays, segment obstruction checks, and nearby obstacle queries.                                 |
| `src/servers/ZoneServer2016/entities/npc.ts`                  | NPC melee reach/arc/height rules and static collision line-of-sight gate at damage time.                                                                 |
| `src/servers/ZoneServer2016/zoneserver.ts`                    | Server lifecycle, navigation tick, and authoritative crowd-position replication.                                                                         |
| `tools/forgelight/export_z1_instanced.py`                     | Produces deterministic placed collision/identity data.                                                                                                   |
| `tools/forgelight/collision_semantic_policy.py`               | Applies policy strategies and emits H1SEM1 classifications.                                                                                              |
| `tools/forgelight/inspect_mesh_triangles.py`                  | Creates per-triangle evidence for reviewing composite meshes.                                                                                            |
| `tools/forgelight/policies/z1_collision.semantic_policy.json` | Canonical reviewed classification policy.                                                                                                                |
| `data/2016/navigationTransitions.json`                        | Canonical authored traversal transitions.                                                                                                                |
| `scripts/createNavigationArtifactManifest.ts`                 | Creates the deployable artifact manifest.                                                                                                                |
| `scripts/verifyNavigationArtifact.ts`                         | Verifies an artifact and reports exact runtime metadata.                                                                                                 |
| `scripts/validateNavigationRegions.ts`                        | Validates anchors, routes, areas, seams, and exclusions.                                                                                                 |
| `scripts/validateModelRoutesStreaming.ts`                     | Validates repeated model instances using a fresh bounded Detour runtime per instance.                                                                    |
| `scripts/deployNavigationArtifact.ps1`                        | Plans, verifies, backs up, and transactionally deploys the runtime closure and artifact.                                                                 |

### Baker repository

| File                            | Responsibility                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `geometry_source.h`             | Geometry-source abstraction used by the baker.                                    |
| `forgelight_geometry_source.*`  | Tile-local native ForgeLight geometry provider.                                   |
| `forgelight_nav_source.*`       | H1COL2/H1SEM1 parsing, validation, hashes, and semantic source data.              |
| `forgelight_heightmap_loader.*` | Loads the exported terrain heightmap.                                             |
| `forgelight_terrain_lattice.*`  | Generates terrain triangles from the heightmap for each tile.                     |
| `forgelight_instance_index.*`   | Spatially indexes placed source instances.                                        |
| `navigation_transitions.*`      | Loads and applies authored transitions.                                           |
| `threshold_portal_geometry.*`   | Builds modest geometry bridges at reviewed entrance thresholds.                   |
| `tilecache_overlay.cpp`         | TileCache output/overlay handling.                                                |
| `main.cpp`                      | CLI, build orchestration, deterministic tile insertion, and output serialization. |

## The journey

### Phase 1: make the existing game systems useful for solo PvE

The first work reused existing server systems rather than inventing a second
game alongside H1Z1. Human NPCs were represented through the client-visible
player/NPC surfaces, gained inventory-backed kits and ranged combat, and were
split into hostile bandits and allied survivors. Corpses became lootable,
wildlife remained enabled, and POI survivor encounters moved toward a plugin.

Representative server commits include:

- `2452be81f`: player-presented hostile survivor NPCs.
- `bf059b47a`: ranged bandit combat.
- `5970401c2`: allied survivors and lootable NPC corpses.
- `757cf85c5`: preserved wildlife spawning.
- `7b522147f`, `ec26aeb1`, `87af17ef6`: POI survivor encounters and plugin work.
- `b236ef383`, `9325ad672`: human patrol and sound-response behavior.

This phase proved that networked human NPCs, gunfire, damage, inventory, and
loot were feasible. It also made navigation defects impossible to ignore.

### Phase 2: integrate Skyline's collision and streamed navigation work

Skyline's branch addressed a real Detour capacity problem: a larger and more
accurate navmesh does not fit comfortably in the current 32-bit WASM
poly-reference layout when fully materialized. The server gained cache loading,
streamed column materialization, player-local runtime management, collision
queries, height grounding, and diagnostics.

Early implementations were unstable. After several minutes, the server could
remain visibly alive while gameplay stopped: zombies froze, doors and vehicles
stopped responding, and weapons could no longer fire. The decisive log was a
WASM `memory access out of bounds` inside `dtCrowd.update`, not a particular
Pleasant Valley building.

The fixes included:

- deterministic cache part ordering and header validation;
- automatic use of a verified streamed cache;
- bounded/disk-backed layer indexing instead of unconstrained RAM preload;
- additive-safe materialization;
- safe crowd/runtime recycling;
- explicit rejection of players and vehicles as passive crowd agents after
  that approach corrupted the crowd runtime;
- persistent console and live watchdog capture;
- authoritative replication from Detour crowd positions.

Representative commits include `8389a1b44`, `81035b90d`, `8ff0450e0`,
`93712ceb2`, `4072d7e6b`, `960e00419`, `b61060092`, `4b5877e42`,
`abc26c68e`, `cb05b580d`, `67fcf8e6a`, `18d3cc724`, `a5605a76a`, and
`e6cc8cbb6`.

The important lesson is that streaming solved capacity and locality; it did
not magically improve the topology of the baked navmesh.

### Phase 3: replace guessed ground with native world data

The project added the real terrain heightmap and deterministic native collision
instead of relying only on an old OBJ or a simplified ground plane. Asset
extraction covered the static Z1 placements used by the live map and produced
the H1COL2/H1CID1 contracts.

The extraction work established several invariants:

- transforms and instance order must be deterministic;
- source assets must be decoded strictly, with malformed assets rejected or
  explicitly skipped rather than silently accepted;
- collision, semantics, and instance identity must bind to exact hashes/counts;
- terrain and structure surfaces are different evidence and must not be
  flattened into one guessed height.

Terrain-vs-nav validation originally compared zero samples because the
validator accidentally invoked the production streaming mode with no live
player to materialize columns. Commit `c38a9aa89` forces a fully materialized
runtime for that offline check. The corrected run compared 52,270 samples,
with median absolute error 0.378 m and p95 0.991 m.

### Phase 4: build a real semantic pipeline

Raw collision tells Recast where triangles exist, but not whether a triangle
is a road, floor, roof, stair underside, door panel, desk, or wall. Slope-only
classification created roof islands, disconnected entrances, missing stairs,
and wall shortcuts.

The policy pipeline therefore added:

- stable actor and asset evidence;
- geometry-backed review queues for unknown meshes;
- explicit per-triangle rules for composite building meshes;
- conservative `exclude` rules for roofs and ambiguous surfaces;
- `obstacle_static` rules for unambiguous props;
- authored `threshold` and `stair` surfaces;
- exact policy and collision hashes.

Key server commits include:

- `5dca6ce31`: first reviewed static obstacle batch.
- `e36e75c37`: per-triangle inspection tool.
- `ab3a881b3`: `explicit_triangles` policy strategy.
- `61dd638a4`: Pleasant Valley police-station pilot.
- `212ec87f2`: strict police-station classification completion.
- `3c0ac8869`: House34B surface classification.
- `0a7cd09ea`: second static obstacle batch.

The pilot intentionally excluded the police-station roof. Consequently,
second-floor-to-roof traversal is currently absent by design, not an accidental
runtime regression. If roof access is a gameplay requirement, it needs a new
reviewed stair/landing/roof-safe policy rather than broad roof walkability.

### Phase 5: remove the OBJ bottleneck from the baker

The baker gained a `GeometrySource` seam and a native ForgeLight provider. It
can now query relevant collision instances and terrain for the tile being
baked instead of requiring one enormous intermediate OBJ.

Important baker commits include:

- `08bb24c`: `GeometrySource` and native ForgeLight path, with byte-identical
  proof for the old OBJ path.
- `24ce5a9`: real heightmap terrain lattice.
- `5951ab1`: deterministic sequential insertion of direct nav tiles after the
  parallel raster/build phase, fixing an OpenMP output-order race.
- `06b94eb`: authored transition support.
- `85a1595`: reject extrapolated plane samples.
- `2399460`, `36b0d91`, `d648ed0`: reviewed threshold portal geometry and
  contract tests.
- `97d0a98`: recover safely from contour failures.
- `cbba417`: validate regional TileCache materialization.

The determinism fix matters for provenance: parallel work may finish in any
order, but serialized direct-nav tile order and references must not.

### Phase 6: target the police station and common entrance families

Instead of repeatedly changing global slope parameters, targeted model and
placement validators were added for the actual failure patterns:

- Pleasant Valley police front stairs and doorway;
- basement flight and interior route;
- repeated House34B entrances;
- SmallHouse02A;
- StoreFront04;
- Office03;
- House01;
- regional overlay seams and static obstacle probes.

Relevant server commits include `700fc0bd4`, `236d45d51`, `9edc34bc8`,
`051ccbf84`, `ec6791cba`, `2e3e2b754`, `ea4cedd11`, `d950d17a0`,
`9ec862450`, `88a4288a5`, `ca5bfd9a9`, and `77798ee0d`.

Commit `488dbccdb` fixed another false-negative validator failure: reusing one
mutable WASM runtime while removing and rebuilding thousands of distant
streamed columns eventually exhausted the allocator. The model validator now
uses a fresh bounded Recast process per instance, matching the operational
case of a player visiting one POI.

### Phase 7: full bake, verification, deployment, and client test

The `full-common-entrances-v1` bake completed successfully:

| Measurement                                |                                                               Result |
| ------------------------------------------ | -------------------------------------------------------------------: |
| Wall-clock time                            | 1 h 33 m 25 s by status timestamps (builder reported about 1 h 31 m) |
| Tile columns processed                     |                                                    102,400 / 102,400 |
| Direct navmesh tiles                       |                                                               16,384 |
| Empty/water columns skipped for direct nav |                                                               86,016 |
| Direct-nav polygons                        |                                                               64,947 |
| Direct-nav size                            |                                                              20.6 MB |
| Streamed cache layers                      |                                                              104,745 |
| Maximum layers per tile                    |                                                                    4 |
| Cache parts                                |                                                                   22 |
| Exit status                                |                                                                    0 |

The 16,384 direct-nav tile count is the expected 32-bit Detour direct-mesh
capacity, not evidence that only 16,384 world columns were processed. The
104,745 cache layers are the important full-world streamed output.

Warnings such as `Bad triangulation`, multiple outlines, contour expansion,
and dangling Delaunay faces were recoverable. The stronger completion proof is
that the bake exited zero and generated, inserted, serialized, and wrote the
same 104,745 cache-layer count.

Deployment was performed through the artifact/deployment tooling, with backups
under the QuickStart `backups` directory. A gap was found: the navigation
deployment closure did not include an updated `zoneserver` target file.
Commit `bb4ed3600` fixed the stale offline target in source, and the installed
TypeScript/JavaScript/declaration/map files were backed up and synchronized.
Future deployment tooling should make that wider runtime closure explicit.

## Current installed runtime

The installed package is `h1z1-server` version `0.49.2-0`.

The current installed artifact verifies as:

| Field                            | Value                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| Artifact ID                      | `680d58a93892b1cbd72a726448854f078c1216afc1535477e22423a860b0e3ec` |
| Provenance status                | `runtime-only`                                                     |
| Files verified                   | 26                                                                 |
| Bytes verified                   | 648,630,099                                                        |
| Cache layers                     | 104,745                                                            |
| Cache parts                      | 22                                                                 |
| `meshMaxTiles`                   | 32,768                                                             |
| `meshMaxPolys`                   | 128                                                                |
| Cell size / height               | 0.2 m / 0.1 m                                                      |
| Walkable radius / height / climb | 0.2 m / 2.0 m / 1.3 m                                              |
| Collision                        | 820 meshes / 149,976 instances                                     |
| Heightmap                        | 8192 x 8192                                                        |
| Authored transitions             | 5                                                                  |
| H1COL2 SHA-256                   | `ce8ca93c8b3d3607d829b323580b6cad60723ea46c7f46eb0e8f16ed38656065` |
| Transition SHA-256               | `600f0a61e8bf485848ac8e09918d02a31e06388ac2b2b2794b9d9c0150a8a49e` |

The bake used `--agent-climb 1.3`. Earlier experiments with lower global climb
values are not comparable unless rerun with the same semantic policy and
transitions. Do not change this value based on an old isolated result.

At server startup, a verified cache is used automatically unless streaming is
explicitly disabled with `NAV_STREAMING=0`. `NAV_STREAMING=1` forces streamed
mode and should fail clearly if the cache is absent or invalid. The old
`data/2016/navData` direct mesh remains a fallback, not the normal installed
path for this artifact.

## Validation evidence

### Automated model routes

| Suite                               | Instances | Routes passed |               Pass rate |
| ----------------------------------- | --------: | ------------: | ----------------------: |
| Installed baseline before this bake |       157 | 1,236 / 2,268 |                   54.5% |
| `full-common-entrances-v1`          |       157 | 2,232 / 2,268 |                   98.4% |
| Improvement                         |         - |   +996 routes | +43.9 percentage points |

The remaining 36 failures are concentrated in only five placement IDs:

| Placement ID | Failures |
| -----------: | -------: |
|       113442 |       18 |
|       108572 |        8 |
|       137724 |        4 |
|       137725 |        4 |
|       137739 |        2 |

These should be investigated as five placement-specific problems, not as a
reason to alter the global bake indiscriminately.

### Pleasant Valley evidence

All five targeted PV evidence regions pass:

- authored front entry;
- authored interior ramp;
- basement flight;
- roof exclusion;
- static dumpster exclusion.

The west, east, and north overlay seams pass. The south seam fails in both the
candidate and the installed baseline, so it is an unresolved issue but not a
regression introduced by this bake.

### In-client observations

Observed after deployment:

- Road/front stairs to the Pleasant Valley police-station entrance work.
- The basement route to the main floor works.
- Main floor to second floor works in at least the tested spawn/aggro cases.
- Zombies can enter rooms on those connected floors.
- Common one-step entrances are substantially better and the full bake was
  judged playable enough to keep.

Still observed:

- A zombie may reach the second floor by taking a wall shortcut instead of the
  intended stair corridor.
- Second floor to roof does not work. The current semantic policy deliberately
  excludes the roof.
- Some NPCs clip through walls, door geometry, props, drivable vehicles, other
  NPCs, or the player.
- Movement can still look elevated or corrected abruptly in bad topology.
- Once an NPC has clipped to the player's side of a wall, a static line-of-
  sight check can no longer prove that the earlier movement was invalid.

Automated path success and in-client movement quality are both required. One
does not replace the other.

## What is working versus what is not

### Working or substantially improved

- Streamed navigation can run for extended drives across the map without the
  earlier deterministic crowd-memory crash.
- Terrain height, static collision data, and local streamed cache loading are
  active.
- Zombies navigate many building entrances and interior stairs that were
  previously disconnected.
- Human NPCs use the same navigation runtime rather than a separate fake
  movement system.
- Bandit ranged shots have a static-geometry obstruction gate.
- NPC melee has reach, facing arc, vertical tolerance, and static segment
  obstruction checks.
- Build, artifact, route, region, and deployment evidence is persisted instead
  of depending on copied console output.

### Not solved

- A navmesh describes allowed routes; it is not a continuous physics capsule.
  Detour crowd output is currently replicated as authoritative NPC position
  without a final swept collision test from the previous position.
- Bad or over-connected polygons can therefore let a crowd agent cross a wall
  even though H1COL2 knows the wall exists.
- Drivable vehicles, players, and player construction are dynamic entities and
  are not fully represented by the static H1COL2 movement query.
- Players and vehicles cannot simply be copied into the crowd as passive
  agents: that experiment contributed to crowd corruption and was explicitly
  removed.
- TileCache dynamic doors/obstacles are not yet proven complete for every
  doorway, vehicle, and construction case.
- Remaining `unknown` semantics prevent a strict-production semantic artifact.
- ForgeLight mode does not yet emit the semantic source/provenance report
  needed for a source-complete manifest.

## Why player collision cannot simply be copied

The local player is simulated primarily by the client engine, which owns its
character controller, visual collision, prediction, and correction. The
server receives and validates networked movement; it does not possess the
client's full physics implementation as reusable source code.

NPCs are server-authored entities. Their Detour crowd position is sent to the
client, so the server must supply the missing movement guard itself. We can
reuse the same world collision data and approximate the player's capsule, but
we cannot call or copy the closed client controller directly.

The correct server-side equivalent is a bounded sweep/shape test plus dynamic
entity avoidance, not treating a point path or one ground ray as a physics
controller.

## Roadmap

### P0: freeze and preserve the current good checkpoint

Before changing navigation again:

1. Keep the current source commits, bake output, deployable bundle, installed
   manifest, reports, and QuickStart backups.
2. Do not delete or overwrite `full-common-entrances-v1`.
3. Record any new client observation with location, route direction, entity
   type, and whether a wall/door/vehicle was open, closed, static, or drivable.
4. Use regional or model validators before authorizing another full bake.

### P1: server-authoritative movement collision and attack line of sight

This is the immediate next implementation phase.

1. Add a swept static-geometry guard from each NPC's previous accepted
   position to the proposed Detour crowd position. Use the existing H1COL2 BVH
   and an NPC capsule/torso approximation.
2. If the sweep hits a solid wall or static prop, reject the proposed move,
   retain the last safe position, and reset/repath the crowd agent instead of
   replicating the invalid point.
3. Treat reviewed dynamic door panels separately so an open doorway is not
   permanently blocked by baked panel geometry.
4. Add bounded dynamic blockers for nearby drivable vehicles and player-built
   structures using existing spatial/entity indexes. Do not scan the entire
   world every tick.
5. Keep the existing impact-time obstruction test for melee and ranged damage,
   then extend it to relevant dynamic construction/vehicle blockers.
6. Add counters/logging for rejected moves, repaths, blocked attacks, and the
   cost of collision queries. The feature needs an emergency config toggle.
7. Test at the PV wall shortcut, normal doorways, static prop cars, drivable
   vehicles, player construction, and open outdoor terrain.

This is a fail-safe around bad movement. It does not excuse invalid navmesh
topology; both layers are required.

### P2: surgical topology fixes

After the movement guard is measurable:

1. Reproduce and fix the PV main-to-second-floor wall shortcut.
2. Decide explicitly whether the police-station roof should remain excluded or
   become a reviewed accessible floor. Do not enable roofs globally.
3. Repair or explain the persistent south overlay seam.
4. Inspect the five remaining failing model placements, starting with 113442
   and 108572.
5. Add regression anchors/routes before changing policy or transition data.
6. Prefer per-model/per-triangle semantics or authored transitions over
   increasing global climb/slope tolerances.

### P3: stop paying the full-bake tax during development

The development loop should be:

1. inspect one failing mesh or placement;
2. classify or transition it with evidence;
3. bake only the affected regional columns/model fixture;
4. materialize and validate that regional cache;
5. compare candidate and baseline route reports;
6. run one focused in-client test;
7. reserve the 90-minute full-map bake for release candidates.

The baker already has tile-local ForgeLight input and the server already has
regional/model validators. The remaining tooling work is to package those into
one repeatable targeted command and, where safe, patch/recompose only affected
cache columns into a staged candidate.

Full-bake admission should require:

- policy/tests green;
- regional candidate better than or equal to baseline;
- no new roof islands or seam regression;
- deterministic repeated output;
- enough free disk space for staging plus rollback;
- a persistent external log and completion status file.

### P4: compare 64-bit Detour with streaming

Quentin has stated that H1emu intends to recompile the Recast Navigation WASM
module with `DT_POLYREF64` and compare it with Skyline's streaming approach.
That work could improve poly-reference capacity and accuracy without requiring
the current degree of streaming.

It does not automatically solve classification, stairs, thresholds, roofs,
walls, dynamic obstacles, or attack line of sight. When the 64-bit branch is
available, benchmark it against this artifact using the same:

- H1COL2/H1SEM1/heightmap/transitions;
- cell size, cell height, radius, climb, and semantic policy;
- 2,268 model routes and PV region/seam checks;
- server memory, startup time, tick time, and long-drive stability test.

Do not delete the streamed implementation before that evidence exists. The
likely final result may be 64-bit references plus some form of locality or
streaming, not an ideological choice of only one.

### P5: complete provenance and prepare upstream PRs

Before calling the artifact production-ready:

1. Make ForgeLight `GeometrySource` emit the semantic source report currently
   skipped by the full bake.
2. Eliminate or explicitly admit every production-forbidden `unknown`
   semantic according to an agreed policy. Do not hide the count.
3. Create a `source-complete` manifest containing extractor, baker, server,
   policy, collision, semantics, heightmap, and transition identities.
4. Reproduce the same artifact ID from a clean documented source state.
5. Make deployment include the entire required runtime closure, including the
   ZoneServer target, or split that deployment responsibility explicitly.
6. Publish a compact evidence bundle: commands, commit IDs, manifest, hashes,
   validator summaries, warning summary, memory/timing results, and client
   observations.

The upstream work should probably be split:

- **PR 1, `h1emu-recast`**: GeometrySource, native ForgeLight input, terrain
  lattice, semantics/transitions, determinism, and regional materialization.
- **PR 2, `h1z1-server` targeting `dev`**: artifact contract, streamed runtime
  hardening, semantic/export tools, validators, and deployment.
- **PR 3 or follow-up**: swept NPC movement collision and dynamic blockers,
  once performance and gameplay behavior are proven independently.

Generated map assets and full cache binaries should not be mixed into the
source reviews unless maintainers request them. Provide generation commands,
hashes, and a separately hosted/released artifact instead.

### P6: continue gameplay AI after the foundation is trustworthy

Once NPCs cannot cross walls or hit through them, continue the PvE design:

- keep POI military/police/medic roles;
- make humans less sleepy and more reactive than zombies without simulating
  every distant NPC at full frequency;
- use sound events to wake, investigate, and converge on player activity;
- add survivor recruitment/companion persistence;
- add bandit patrols, POI missions, faction reputation, and loot rewards;
- make zombies and human factions react to each other without unbounded
  all-world scans.

Navigation and collision are prerequisites for those systems, not reasons to
discard the existing AI work.

## Reproduction and operational commands

All commands below are PowerShell commands. Replace the workstation-specific
roots when running elsewhere.

### Verify the installed artifact

```powershell
$server = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\h1z1-pv-nav'
$bundle = 'C:\Users\SUBSECT\Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master\node_modules\h1z1-server\data\2016'
npm run navmesh-artifact-check --prefix $server -- --bundle-root $bundle
```

Expected current identity:

```text
artifactId: 680d58a93892b1cbd72a726448854f078c1216afc1535477e22423a860b0e3ec
provenance: runtime-only
filesVerified: 26
bytesVerified: 648630099
```

### Inspect collision and semantics

```powershell
$inspect = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\h1emu-recast\build\Release\forgelight-nav-source-inspect.exe'
$collision = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\staging\h1col2-house34b-v3-thresholds\z1_collision.bin'
$semantics = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\staging\full-common-entrances-v1\z1_collision.semantics.bin'
& $inspect $collision $semantics
```

Adding `--strict-production` currently fails by design because `unknown`
semantics remain. That failure must not be suppressed in production admission.

### Build and test server source

```powershell
$server = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\h1z1-pv-nav'
npm run build --prefix $server
npm test --prefix $server
npm run test-nav-deploy --prefix $server
```

Focused checks are exposed through `package.json`, including:

```text
navmesh-artifact-check
navmesh-regions-check
navmesh-pv-seams-check
navmesh-pv-police-check
navmesh-house34b-instances-check
navmesh-model-routes-check
navmesh-islands-audit
test-forgelight-nav-source
test-forgelight-hybrid-nav-source
```

### Re-run the full bake exactly as staged

The exact command and paths used for the current full candidate are preserved
in:

```text
work/staging/full-common-entrances-v1/run-bake.ps1
```

That script invokes `navmesh-builder.exe` with native ForgeLight collision,
H1SEM1 semantics, the terrain heightmap, authored transitions, human profile,
`--agent-climb 1.3`, dynamic door obstacles, and the full
`[-4096,-100,-4096]` to `[4096,500,4096]` bounds.

Do not run it casually. Use the regional loop in P3 until a release candidate
is ready.

### Plan or perform deployment

```powershell
$server = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\h1z1-pv-nav'
$quickStart = 'C:\Users\SUBSECT\Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master'
$bundle = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\staging\full-common-entrances-v1-bundle\data\2016'

& "$server\scripts\deployNavigationArtifact.ps1" `
  -QuickStartRoot $quickStart `
  -NavigationBundleSourceRoot $bundle `
  -Plan
```

Remove `-Plan` only when the server is stopped, the staged artifact verifies,
the proposed file plan is understood, and a new backup is desired.

## PR acceptance checklist

- [ ] Correct upstream branch (`H1emu/h1z1-server:dev`) and current merge base.
- [ ] Server and baker changes split into reviewable commits/PRs.
- [ ] No generated caches, user saves, logs, backups, or unrelated local files.
- [ ] Source build and all focused tests pass from clean checkouts.
- [ ] OpenMP builds are byte-deterministic across repeated runs.
- [ ] ForgeLight source report exists and matches the exact collision/policy.
- [ ] Strict-production semantics pass, or the PR explicitly scopes why they
      are not yet required.
- [ ] Candidate manifest is source-complete and verifies every runtime file.
- [ ] Candidate model routes do not regress the 2,232/2,268 checkpoint.
- [ ] PV evidence remains 5/5; seam changes are compared to baseline.
- [ ] No new roof islands or wall shortcuts in targeted checks.
- [ ] Long-drive/runtime stability test completed with watchdog evidence.
- [ ] In-client stairs, entrances, walls, doors, vehicles, construction, and
      attack obstruction tested.
- [ ] Deployment plan, rollback path, and installed artifact ID recorded.
- [ ] Generated artifact distribution is separate from source review.

## Current bottom line

The project is no longer a blind experiment. It has a stable streamed runtime,
native world inputs, semantic classification, targeted validation, a successful
full bake, a verified installed artifact, and a measurable 43.9-point route
improvement.

The next problem is narrower and better defined: **Detour route output must be
constrained by server-authoritative movement collision, and attacks must remain
blocked by both static and relevant dynamic geometry.** After that, the five
remaining placement failures and the PV wall shortcut can be repaired with
regional evidence. Only then should another full-map release bake be admitted.
