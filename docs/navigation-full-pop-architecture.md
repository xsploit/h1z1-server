# Full-population navigation architecture

Status: proposed proof gate; no production claim yet.

This document pauses further whole-map semantic grinding until the runtime can
support a populated public server. The current disk-indexed streamer remains a
useful solo test bed, but neither its additive-safe mode nor mutable eviction is
accepted as the final multiplayer architecture.

An adversarial source-and-artifact review found that the previous version of
this plan started at 64-bit too early. The current baker's 16,384 direct-tile
limit is a hard-coded policy, not a demonstrated `dtPolyRef32` limit. The first
job is therefore to measure the real 32-bit capacity and crowd bottlenecks.

## Decision order

Evaluate these implementations in order:

0. prove or reject a complete 32-bit monolithic runtime;
1. if 32-bit capacity fails, build a 64-bit monolithic Recast/Detour runtime;
2. if WASM bindings or memory fail, use a native 64-bit navigation worker;
3. only if both monolithic options fail, use immutable regional contexts with
   a high-level portal graph.

Do not resume repeated-building classification or run another routine full bake
until Slice 0 below has produced its decision evidence. Regional fixtures and
bounded capacity experiments are allowed. A whole-map bake is allowed only
when its exact question cannot be answered from the existing TileCache.

## Critical artifact finding

The current fine Apartments06 run produced useful compressed data, but its
direct navmesh is silently partial:

- 102,400 tile coordinates were considered;
- 100,280 non-empty columns reached the direct-build insertion stage;
- 104,935 compressed TileCache layers were generated and serialized;
- only 16,384 direct navmesh tiles were admitted;
- 83,896 later direct tiles were rejected when the navmesh filled;
- 2,120 coordinates were genuinely empty;
- the baker combined rejected and genuinely empty tiles into the reported
  `86,016 empty/water skipped` count and exited successfully.

Because insertion was in canonical row-major order, `z1_0.bin` contains an
early strip of the map rather than representative whole-map coverage. It must
not be called complete or used as capacity proof. The 104,935 count describes
compressed cache layers; direct-nav completeness is 100,280 non-empty columns
admitted with zero `addTile` rejections.

The failure is in `work/h1emu-recast/main.cpp`: failed `addTile` calls decrement
the built count and increment the same counter later labeled empty/water. The
baker must fail closed before any new artifact can be trusted.

## Slice 0: measure before changing ABI

Slice 0 is the next implementation milestone and the only approved one until
its report is complete.

### 0.1 Make artifact creation fail closed

Update the baker to report these separately:

- geometrically empty/water columns;
- successfully admitted direct tiles;
- rejected direct tiles, including the full `dtStatus`;
- per-tile polygon counts: maximum, percentiles, and a histogram;
- configured tile bits, polygon bits, maximum tiles, and maximum polygons per
  tile.

Any direct-tile rejection must produce a non-zero exit unless an explicit
diagnostic `--allow-partial-navmesh` option was supplied. Artifact manifests
must record the same counts, configuration, ABI, tool commit, source identity,
and semantic/transition identities.

### 0.2 Test the two cheaper 32-bit layouts

The current builder clamps tile bits to 14:

```text
tileBits = min(ilog2(nextPow2(capacity)), 14)
maxTiles = 1 << tileBits
maxPolys = 1 << (22 - tileBits)
```

Detour's actual 32-bit constraint is the 22-bit tile-plus-polygon budget, with
enough salt bits remaining. Two layouts must be measured before an ABI port:

1. **Current 128-cell tiles, 17/5 layout**: 131,072 tile slots and 32 polygons
   per tile. This is viable only if every direct tile fits the 32-poly ceiling.
2. **256-cell tiles, 15/7 layout**: approximately 25,600 world columns, 32,768
   tile slots, and 128 polygons per tile. This trades larger raster tiles for a
   much safer polygon allowance.

First attempt to materialize the 17/5 direct mesh from the existing 128-cell
TileCache, whose compressed references and headers are ABI-portable. Do not
reraster the world merely to measure a slot layout. The 256-cell candidate does
require new rasterization because it changes tile geometry, but it should be
run only if the histogram or 17/5 materialization rejects the first layout.

Acceptance for a 32-bit candidate is exact: all 100,280 expected non-empty
columns are admitted, no tile exceeds the configured polygon ceiling, there are
zero rejected tiles, distributed nearest-poly probes pass, and long routes do
not truncate silently.

### 0.3 Remove known crowd overhead and measure the real ceiling

The current runtime calls `crowd.update(1 / 60, elapsed, 1)`. The JavaScript
adapter then enumerates every agent, crosses WASM for positions, and computes
interpolated positions that `updatePathfindingPositions()` discards in favor of
authoritative crowd positions. With `maxSubSteps=1`, a slow tick also cannot
drain accumulated simulation time.

Use the non-interpolating single-argument update path and benchmark the full
zone-server phase—not only native `dtCrowd`—at 500, 1,000, and 2,000 active
agents. Record:

- `dtCrowd.update` p50/p95/p99;
- `updatePathfindingPositions()` p50/p95/p99;
- event-loop lag and peak tick time;
- replication packet count and bytes per second;
- peak RSS and WASM high-water mark;
- invalid positions, failed agents, and stalled paths.

Crowd work may consume at most 30% of the configured tick period at the accepted
population. A p99 merely below the entire tick period is not sufficient.

### 0.4 Measure path and replan behavior

DetourCrowd has structural queue and corridor limits: only eight agents enter
the path queue per update, the queue shares 100 A\* iterations, and crowd path
results are capped at 256 polygons. Whole-map coverage can make these limits
more visible rather than less.

Measure time from `requestMoveTarget()` to a valid target state at 500, 1,000,
and 2,000 agents, including a synchronized sound/explosion replan. Record
p50/p95/p99 and failure rate. Also test representative cross-town and
corner-to-corner paths for feasibility and corridor truncation.

### Slice 0 decision

- If either 32-bit layout passes completeness, path, population, timing, and
  soak gates, keep the 32-bit ABI and make 64-bit optional research.
- If both layouts fail on measured reference capacity, proceed to Candidate A.
- If capacity passes but crowd/replan gates fail, changing reference width does
  not solve the blocker; address crowd scheduling, AI activation, or regional
  crowd ownership before changing ABI.

## Current streaming runtime

The disk-indexed TileCache avoids a 535.16 MiB compressed-cache preload. Nearby
layers are materialized into a 16,384-tile/16,384-layer runtime.

Additive-safe mode never evicts admitted columns. It avoids the stale-reference
WASM corruption observed during mutable streaming, but distributed players will
eventually fill the finite runtime. It is not full-pop support.

Mutable streaming is opt-in with `NAV_STREAMING_MUTATION=1`. Before mutation,
the server clears entity `navAgent` references and removes crowd agents because
an agent may hold a path reference into a tile other than the one it stands on.
Tiles are then removed or built, and eligible agents are recreated. NPC entities
outside the window remain in world state but agentless. This ordering fixes one
stale-reference class, but global crowd teardown and remote event coverage make
it unsuitable as the default public-server design without a much stronger
distributed soak.

## Candidate A: conditional 64-bit monolithic WASM

Use this only if Slice 0 proves that no complete 32-bit layout fits.

Upstream `DT_POLYREF64` provides 28 tile bits and 20 polygon bits. The vendored
option in `recastnavigation/CMakeLists.txt` is currently unreachable by the
actual baker targets because the root build globs Recast/Detour sources directly.
The exact baker and overlay targets therefore need explicit, matching compile
definitions.

This is not a compiler-flag-only change:

- current direct tiles are 32-bit and must be regenerated or materialized;
- `recast-navigation` 0.43.1 exposes references through 32-bit IDL surfaces;
- WebIDL does not provide a clean complete 64-bit reference API;
- scalar and array query paths must not silently coerce references to numbers;
- serialized tile headers change size and acquire padding if raw structs are
  written.

Prefer opaque handles at the JavaScript boundary. If raw 64-bit references are
temporarily exposed for verification, force at least 32 remove/add cycles on
the same slot so the salt produces references above JavaScript's exact-integer
range. Cover `findPath`, `findStraightPath`, `findPolysAroundCircle`,
`queryPolygons`, `moveAlongSurface`, crowd state, and serialization—not only a
fresh scalar reference.

Serialization must use explicit little-endian fields, a bumped format version,
and an ABI tag. Do not `fwrite` a padded `NavMeshTileHeader` containing a
64-bit reference; uninitialized padding would break deterministic hashes.

The existing compressed TSET is ABI-portable because compressed tile and
obstacle references remain 32-bit and its layer headers contain no polygon
references. A 64-bit spike should reuse it to materialize a new direct artifact
where possible; it should not automatically pay for another full raster bake.

## Candidate B: native 64-bit navigation worker

This is the fallback if 64-bit WASM bindings, lifecycle, or memory cannot pass.
Compile Recast, Detour, TileCache, and Crowd as native 64-bit code and keep all
polygon/tile references inside an opaque worker API:

- `loadArtifact(identity)`;
- `samplePosition(position, floorHint)`;
- `createAgent(entityId, position, parameters)`;
- `removeAgent(entityId)`;
- `setTarget(entityId, position)`;
- `addObstacle/removeObstacle(obstacleId, bounds)`;
- `tick(dt)` returning entity positions and status counters.

A dedicated thread or process owns Detour state and publishes position
snapshots. A child-process spike is acceptable because it isolates crashes; a
Node-API addon is the lower-latency production candidate. Windows and Linux
build/package proof is mandatory. The opaque API should be shared with
Candidate A so the server integration is not rewritten twice.

## Candidate C: immutable regional contexts

If neither monolithic implementation passes, partition the map into independent
immutable navmeshes and crowds. A high-level portal graph selects inter-region
routes, agents migrate only at validated portals, and sound/event state wakes
dormant regions without mutating a live crowd's navmesh.

This scales with occupied regions and avoids stale references from eviction,
but portal authoring, migration, construction ownership, and event propagation
make it the most complex fallback.

## Production gates

| Gate                  | Required evidence                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Builder integrity     | Empty, admitted, and rejected counts are distinct; any rejection fails the build; the manifest matches the emitted artifact.               |
| Artifact completeness | All 100,280 expected direct columns are admitted with zero rejections; distributed probes and long routes succeed.                         |
| Reference ABI         | Every scalar and array path survives churn-generated references above `2^53`; ABI mismatch fails closed.                                   |
| Path feasibility      | Representative long paths do not exceed or silently truncate queue/corridor limits.                                                        |
| Replan latency        | Target-request-to-valid p95/p99 and failure rate pass under synchronized replans at accepted population.                                   |
| Population            | 100 distributed synthetic players and the configured NPC population retain coverage for a two-hour movement soak.                          |
| Timing                | Crowd uses at most 30% of its tick budget; full pathfinding phase and event-loop p95/p99 remain within measured headroom.                  |
| Memory                | Peak RSS and WASM high-water remain bounded after a two-hour obstacle/churn soak; no heap-growth failure occurs.                           |
| Events                | Separated gunshot, screamer, tree, vehicle, grenade, and explosion events reach eligible agents without relying on a single player window. |
| Safety                | Zero out-of-bounds faults, stale refs, frozen loops, non-finite positions, silent crowd disablement, or unexplained agent loss.            |
| Obstacles             | Repeated door, construction, and vehicle changes cause bounded local replans without corrupting unrelated agents.                          |

## Audited surfaces

- runtime and bindings: `work/h1z1-pv-nav/src/utils/recast.ts`;
- agent lifecycle: `work/h1z1-pv-nav/src/servers/ZoneServer2016/zoneserver.ts`;
- AI sound scans: `work/h1z1-pv-nav/src/servers/ZoneServer2016/entities/npcs/zombie.jsm.ts`;
- dependency: `recast-navigation` 0.43.1 in `package-lock.json` and
  `node_modules/@recast-navigation/{core,wasm}`;
- native capacity/serialization: `work/h1emu-recast/main.cpp`;
- root native build: `work/h1emu-recast/CMakeLists.txt`;
- measured cache and partial direct artifact:
  `work/staging/full-apartments06-v1/`;
- 100-player default: `data/defaultDatabase/shared/servers.json`;
- streaming comparison:
  [QuentinGruber/h1z1-server#2840](https://github.com/QuentinGruber/h1z1-server/pull/2840).

## What this architecture does not solve

Monolithic coverage does not classify stairs, prevent roofs from becoming
walkable, create missing doorway connectivity, implement character collision,
stop weapon damage through walls, or make every NPC AI loop cheap. It makes the
reviewed topology available consistently. Regional classification and route
evidence remain necessary—but they become worth finishing only after the
runtime foundation passes these gates.
