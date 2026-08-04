# Full-population navigation architecture

Status: Slice 0 capacity audit and raw 64-bit WASM ABI spike complete; no
production claim yet.

This document pauses further whole-map semantic grinding until the runtime can
support a populated public server. The current disk-indexed streamer remains a
useful solo test bed, but neither its additive-safe mode nor mutable eviction is
accepted as the final multiplayer architecture.

An adversarial source-and-artifact review found that the previous version of
this plan started at 64-bit too early. The current baker's 16,384 direct-tile
limit is a hard-coded policy, not a demonstrated `dtPolyRef32` limit. Slice 0
now measures the current fine cache exactly. It rejects a monolithic 32-bit
materialization of that cache and exposes five independent TileCache
region-build holes. Population and crowd gates remain unmeasured.

## Decision order

Evaluate these implementations in order:

0. prove or reject a complete 32-bit monolithic runtime from measured data;
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

The failure was in `work/h1emu-recast/main.cpp`: failed `addTile` calls
decremented the built count and incremented the same counter later labeled
empty/water. Commit `2646f66` fixes this on the fork: generated, admitted,
rejected, and empty counts are now distinct, the status is reported, and any
rejection prevents artifact publication unless the diagnostic-only
`--allow-partial-navmesh` override is explicit.

## Slice 0: measure before changing ABI

The capacity half of Slice 0 is complete. The population/crowd half remains the
next approved runtime milestone.

### 0.1 Make artifact creation fail closed

The baker now reports these separately:

- geometrically empty/water columns;
- successfully admitted direct tiles;
- rejected direct tiles, including the full `dtStatus`;
- per-tile polygon counts: maximum, percentiles, and a histogram;
- configured tile bits, polygon bits, maximum tiles, and maximum polygons per
  tile.

Any direct-tile rejection produces a non-zero exit unless an explicit
diagnostic `--allow-partial-navmesh` option was supplied. Artifact manifests
must record the same counts, configuration, ABI, tool commit, source identity,
and semantic/transition identities.

The fail-closed contract and its explicit diagnostic override are covered by
`direct-nav-completeness-fail-closed`; the complete native suite currently
passes 27/27 tests.

### 0.2 Measured 32-bit capacity

The current builder clamps tile bits to 14:

```text
tileBits = min(ilog2(nextPow2(capacity)), 14)
maxTiles = 1 << tileBits
maxPolys = 1 << (22 - tileBits)
```

Detour's actual 32-bit constraint is the 22-bit tile-plus-polygon budget, with
enough salt bits remaining. Commit `2646f66` adds a rasterization-free inspector
that reconstructs every compressed layer through the same Detour stages used
by `dtTileCache::buildNavMeshTile`: decompress, regions, contours, polygon mesh,
transition binding, and `dtCreateNavMeshData`.

The exact Apartments06 result, using all 177 authored transitions, is:

| Measurement                     |            Result |
| ------------------------------- | ----------------: |
| compressed layers               |           104,935 |
| layers measured successfully    |           104,930 |
| columns                         |           100,289 |
| zero-polygon layers             |                32 |
| polygon p50 / p95 / p99 / max   | 1 / 20 / 54 / 238 |
| layers above 32 polygons        |             2,496 |
| layers above 64 / 128 polygons  |          684 / 70 |
| Detour materialization failures |                 5 |

The report is
`work/staging/navigation-slice0/polycount-17-5.json`. It is deterministic on
this artifact and completes in about 12 seconds; it is not another raster bake.

The existing fine TSET cannot become one monolithic 32-bit Detour navmesh:
104,898 non-empty materialized layers require 17 tile bits, while the measured
maximum of 238 requires 8 polygon bits. The required 25 bits exceed the
32-bit ABI's 22-bit tile-plus-polygon budget. The proposed 17/5 layout therefore
fails by 2,496 layers, not merely by total tile count.

A larger **direct-only** raster tile remains a bounded diagnostic question, not
a production answer. A 256-cell direct grid would nominally use 15/7, but the
TileCache layer header stores width and height in bytes and cannot represent
256 cells as-is. It would also use a different tile coordinate system from the
current 128-cell dynamic-obstacle cache. A regional worst-case direct probe may
measure whether larger direct tiles fit, but no whole-map 256-cell bake is
approved unless dynamic-obstacle compatibility is designed first.

Acceptance for any remaining 32-bit candidate is exact: all expected tiles are
admitted, no tile exceeds the configured polygon ceiling, there are zero
rejected tiles and zero materialization failures, distributed nearest-poly
probes pass, dynamic obstacles retain the same coordinate contract, and long
routes do not truncate silently.

The five current failures are `DT_FAILURE | DT_BUFFER_TOO_SMALL` from region-id
overflow in `dtBuildTileCacheRegions` at columns `(111,237)`, `(232,261)`,
`(233,261)`, `(235,262)`, and `(236,262)`. Because
`buildNavMeshTilesAt()` stops on the first failing layer, these are runtime
column holes. They must be repaired with bounded local rebakes or a deliberate
builder change regardless of reference width.

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

- The existing fine cache fails monolithic 32-bit reference capacity; proceed
  with a bounded Candidate A ABI/consumer spike that reuses the compressed
  cache rather than rerastering the world.
- A larger direct-only 32-bit regional probe is optional diagnostic evidence,
  not permission for a full bake or a production decision.
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

Use this now that Slice 0 proves the existing fine cache cannot fit a complete
monolithic 32-bit reference layout.

Upstream `DT_POLYREF64` provides 28 tile bits and 20 polygon bits. The vendored
option in `recastnavigation/CMakeLists.txt` is currently unreachable by the
actual baker targets because the root build globs Recast/Detour sources directly.
The exact baker and overlay targets therefore need explicit, matching compile
definitions.

This is not a compiler-flag-only change:

- current direct MSET tiles are 32-bit and must be regenerated or replaced by
  materializing the portable compressed TSET;
- `recast-navigation` 0.43.1 exposes references through 32-bit IDL surfaces;
- scalar and array query paths must not silently coerce references to numbers;
- serialized tile headers change size and acquire padding if raw structs are
  written.

### Raw ABI spike result

The exact `@recast-navigation/wasm` 0.43.1 source (`gitHead`
`8769e8b9995f127033af9f6e6eeac3fad7d66201`) now has an isolated fork spike at
`xsploit/recast-navigation-js`, branch `spike/dt-polyref64-h1emu`, commit
`5baae6f`.

The spike proves that Emscripten 6.0.5's WebIDL binder can expose
`unsigned long long` through `WASM_BIGINT=1`; an opaque-handle bridge is not
required merely to cross the JavaScript boundary. The build conditionally
changes all bound polygon/tile reference scalars, result arrays, raycast paths,
link fields, corridor/crowd target refs, and debug-draw refs while preserving
the normal 32-bit build. Both modes compile and pass executable Node ABI tests:

- 32-bit refs remain JavaScript `number` values;
- 64-bit refs are JavaScript `bigint` values;
- encode/decode round-trips `0xffffffffffffffff` exactly;
- scalar out refs and ref arrays round-trip values above `2^53`; and
- callers normalize unsigned high-bit refs with `BigInt.asUintN(64)` and pass
  them back with `BigInt.asIntN(64)` because the generated boundary represents
  the raw i64 bit pattern as a signed BigInt.

This passes the raw binding feasibility question, not the consumer gate. The
remaining blockers are explicit:

- `@recast-navigation/core` still models refs and ref arrays as `number` /
  `UnsignedIntArray` and must gain a 64-bit build/runtime surface;
- upstream `webidl-dts-gen` mishandles `unsigned long long[]`, so the 64-bit
  package needs a BigInt-aware declaration path;
- the existing TSET importer trusts its generated 16,384-slot navmesh header,
  whereas the monolithic consumer must allocate at least 131,072 navmesh slots
  before materializing all layers; and
- query-array, raycast, Crowd, dynamic-obstacle churn, and server integration
  still require behavioral tests on real tiles, not only wrapper bit tests.

Opaque handles remain Candidate B's preferred process boundary, but Candidate
A can proceed with BigInt refs if the high-level wrapper and tests stay
fail-closed.

Direct MSET serialization now uses a distinct version in the raw spike so a
32-bit and 64-bit reader cannot silently reinterpret each other's tile header.
Production serialization must still use explicit little-endian fields and an
ABI tag rather than writing a padded native `NavMeshTileHeader`.

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
| Artifact completeness | Every expected tile is admitted with zero rejection or materialization failure; distributed probes and long routes succeed.                |
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
- exact 32-bit capacity/materialization report:
  `work/staging/navigation-slice0/polycount-17-5.json`;
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
