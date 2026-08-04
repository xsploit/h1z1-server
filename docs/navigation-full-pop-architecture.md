# Full-population navigation architecture

Status: proposed proof gate; no production claim yet.

This document deliberately pauses further whole-map semantic grinding until the
runtime architecture can support a populated public server. The current
disk-indexed streamer is useful evidence and remains the working solo artifact,
but its default additive-safe mode is not the final multiplayer architecture.

## Decision

Evaluate these implementations in order:

1. a 64-bit monolithic Recast/Detour WASM runtime;
2. a native 64-bit navigation worker that keeps Detour references out of
   JavaScript;
3. only if both fail, sharded static navigation contexts with a high-level
   portal graph.

Do not resume the repeated-building classification batch and do not run another
full bake until candidate 1 passes the artifact and runtime gates below. A
regional fixture bake is allowed when it proves an ABI or loader change.

## Confirmed limits in the current build

The current fine Apartments06 artifact provides a concrete capacity baseline:

- 102,400 world tile coordinates were considered;
- 100,280 non-empty columns produced compressed data;
- 104,935 compressed layers were serialized;
- the split TileCache is 561,150,989 bytes (535.16 MiB);
- the 32-bit direct navmesh admitted only 16,384 tiles and is 21,704,224 bytes;
- streaming mode creates a 16,384-tile/16,384-layer runtime;
- the default server list advertises a maximum population of 100;
- the current runtime crowd limits are 1,000 agents in streaming mode and
  2,000 in the direct-navmesh mode.

The additive-safe runtime never removes a previously admitted column. This
avoids the stale-reference/WASM corruption seen during mutable streaming, but
widely separated players eventually fill the 16,384-layer budget. It therefore
cannot be represented as full-population support.

Mutable streaming is opt-in with `NAV_STREAMING_MUTATION=1`. Before a runtime
mutation, the server clears entity `navAgent` references and removes the crowd
agents; it then removes/builds tiles and recreates eligible agents. This fixed
one stale-reference ordering problem, but the mutable path has not passed a
public-population soak and is not the default.

### Audited implementation surfaces

The relevant local sources and artifacts are deliberately listed so a future
review does not inspect an adjacent checkout:

- server runtime and bindings use:
  `work/h1z1-pv-nav/src/utils/recast.ts`;
- player-window and NPC-agent lifecycle:
  `work/h1z1-pv-nav/src/servers/ZoneServer2016/zoneserver.ts`,
  `updatePathfindingPositions()`;
- exact JavaScript dependency: `recast-navigation` 0.43.1 from
  `work/h1z1-pv-nav/package-lock.json` and
  `work/h1z1-pv-nav/node_modules/@recast-navigation/{core,wasm}`;
- native baker capacity and serialization:
  `work/h1emu-recast/main.cpp`;
- vendored native 64-bit build option:
  `work/h1emu-recast/recastnavigation/CMakeLists.txt`;
- measured artifact and its completion log:
  `work/staging/full-apartments06-v1/`;
- advertised 100-player default:
  `work/h1z1-pv-nav/data/defaultDatabase/shared/servers.json`;
- upstream 64-bit definition and serialization warning:
  [DetourNavMesh.h](https://github.com/recastnavigation/recastnavigation/blob/main/Detour/Include/DetourNavMesh.h);
- current WASM build and 32-bit IDL boundary:
  [recast-navigation-wasm](https://github.com/isaac-mason/recast-navigation-js/tree/main/packages/recast-navigation-wasm);
- the streaming proposal being compared:
  [QuentinGruber/h1z1-server#2840](https://github.com/QuentinGruber/h1z1-server/pull/2840).

## Candidate A: 64-bit monolithic WASM

### Why it is plausible

Upstream Detour's `DT_POLYREF64` layout reserves 28 tile bits and 20 polygon
bits. A 131,072-slot navmesh is therefore comfortably inside the reference
space needed by the current 104,935-layer artifact. A monolithic navmesh also
removes player-window eviction, remote-event coverage gaps, and crowd teardown
caused solely by global streaming.

The existing `h1emu-recast` checkout already vendors a Recast version with the
`RECASTNAVIGATION_DT_POLYREF64` build option. That option is not sufficient by
itself:

- `main.cpp` still calculates capacities using the 32-bit 22-bit budget;
- 32-bit navigation tiles are explicitly incompatible with a 64-bit Detour
  build, so `z1_0.bin` must be regenerated;
- `recast-navigation` 0.43.1 exposes polygon and tile references through
  `unsigned long`, `UnsignedIntRef`, and `UnsignedIntArray`;
- its WASM build explicitly sets `WASM_BIGINT=0`;
- the TypeScript core represents references as JavaScript `number` values.

Consequently, the spike must port every reference-bearing boundary to a
BigInt-safe or opaque representation. A compiler define with the existing
bindings would truncate references and would be rejected.

### Artifact approach

The preferred production artifact is a new, direct 64-bit navmesh containing
all 104,935 navigation layers. The 535 MiB compressed TileCache must not be
preloaded into the WASM heap merely to recover whole-map coverage.

The artifact manifest must declare at least:

- navigation ABI (`detour-polyref32` or `detour-polyref64`);
- Detour serialization version and tool commit;
- tile-slot count, admitted tile count, and maximum polygons per tile;
- source cache identity and semantic/transition identities.

Loaders must fail closed when the ABI is absent or mismatched. The current
32-bit `z1_0.bin` is not a valid input for this runtime.

### Dynamic obstacles

Monolithic static navigation does not remove the need for doors, construction,
and vehicles. The first experiment should keep the full direct navmesh resident
and use a small scratch TileCache for only the columns affected by an obstacle.
Those compressed layers can remain disk-indexed. Rebuilding a changed column
still invalidates references in that column, so ordinary obstacle churn needs a
separate crowd/path revalidation test; it must not reuse the old whole-runtime
recycle behavior by assumption.

If localized TileCache replacement cannot be made safe, dynamic objects must
use bounded local avoidance/collision while the static monolithic mesh remains
immutable. That is less exact but does not compromise global path coverage.

### Implementation slices

1. **64-bit binding fixture**
   - fork the exact `recast-navigation` 0.43.1 dependency;
   - compile with `DT_POLYREF64` and `WASM_BIGINT=1`;
   - add 64-bit scalar/ref/array wrappers;
   - prove round trips with values above `2^32` and `2^53`;
   - keep polygon references internal where a public API does not need them.
2. **64-bit baker and ABI**
   - remove the hard-coded 22-bit capacity calculations in `h1emu-recast`;
   - emit a versioned 64-bit navmesh set;
   - prove that all 104,935 layers are admitted, not merely generated;
   - make 32/64-bit loader mismatches deterministic errors.
3. **Server integration**
   - load the complete direct navmesh with streaming disabled;
   - create the crowd once and leave the static map immutable;
   - retain the current interest rules for expensive AI decisions;
   - add memory, event-loop, query, path, and crowd telemetry.
4. **Dynamic-obstacle experiment**
   - change a door, construction, and vehicle footprint repeatedly;
   - prove affected agents replan without global crowd destruction;
   - prove unaffected agents and cross-map queries remain stable.

### Go/no-go gates

Candidate A is not accepted based on a successful compile or server boot. It
must pass all of the following:

| Gate                  | Required evidence                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference ABI         | Exact values above `2^32` and `2^53` survive every binding, array, crowd, query, and serialization round trip.                                     |
| Artifact completeness | At least 104,935 expected layers are admitted; there is no 16,384-tile truncation; distributed nearest-poly probes and cross-map routes succeed.   |
| Memory                | Startup completes below 1.4 GiB WASM memory, retaining at least 30% headroom below the observed 2 GiB ceiling.                                     |
| Population            | 100 distributed synthetic player positions plus the configured world NPC population run without coverage loss.                                     |
| Crowd                 | At least 1,000 active agents, with a path to the existing 2,000-agent direct limit, complete a two-hour movement soak.                             |
| Events                | Concurrent gunshot, screamer, falling-tree, vehicle, grenade, and explosion events at separated map locations do not require navigation streaming. |
| Timing                | Crowd update p95 stays below 8 ms and p99 below 16 ms at the accepted agent count; event-loop lag p99 stays below 50 ms.                           |
| Safety                | Zero WASM out-of-bounds faults, invalid/stale reference reports, frozen server loops, non-finite positions, or silent crowd disablement.           |
| Dynamic obstacles     | Repeated add/remove/rebuild cycles do not corrupt crowd paths, and agents do not route through the tested blocker.                                 |

Thresholds may be tightened after the first baseline run, but they may not be
relaxed merely to label the candidate successful.

## Candidate B: native 64-bit navigation worker

This is the real fallback if WASM reference marshalling or the 2 GiB address
space prevents candidate A from passing.

Compile Recast, Detour, TileCache, and Crowd as native 64-bit code. The Node
server must not receive polygon or tile references. It communicates through an
opaque API:

- `loadArtifact(identity)`;
- `samplePosition(position, floorHint)`;
- `createAgent(entityId, position, parameters)`;
- `removeAgent(entityId)`;
- `setTarget(entityId, position)`;
- `addObstacle/removeObstacle(obstacleId, bounds)`;
- `tick(dt)` returning entity positions and status counters.

A dedicated worker thread owns all Detour state and publishes double-buffered
position snapshots. A Node-API addon is preferred for the production latency
path; a child-process sidecar is acceptable for the initial correctness spike
because a crash cannot poison the zone server. Windows and Linux build/package
proof is part of acceptance.

This option avoids JavaScript's integer precision boundary and the WASM heap
ceiling. Its costs are native packaging, process/thread lifecycle, observability,
and a larger integration surface. It uses the same extracted geometry,
semantics, transitions, and regional validators, so prior navigation work is
not discarded.

Candidate B must pass the same population, event, timing, obstacle, and soak
gates as candidate A. IPC/addon overhead is measured as part of the timing gate.

## Candidate C: sharded static contexts

If neither monolithic implementation fits memory or crowd performance, the
last scalable design is not additive global streaming. Partition the map into
independent, immutable navigation contexts. Each active region owns its own
navmesh and crowd; a high-level portal graph selects region-to-region routes.
Agents migrate only at validated portals. Player presence and queued sound
events activate regions, while dormant NPC entities remain in world state
without crowd agents.

This avoids mutating a navmesh under a live crowd and scales with occupied
regions, but cross-region routing, portal authoring, NPC migration, construction
ownership, and event propagation make it substantially more work. It is a
fallback, not a shortcut.

## Expected effort

These are engineering ranges, not delivery promises:

- candidate A binding and ABI spike: 2-4 focused days;
- full artifact loader and completeness harness: 2-4 days;
- population/event/soak harness: 2-4 days;
- dynamic-obstacle proof: 2-5 days;
- candidate B native worker, if needed: approximately 2-3 focused weeks,
  including Windows/Linux packaging;
- candidate C: multiple weeks and should be undertaken only with profiling
  evidence that rejects both monolithic paths.

The first decisive result should therefore come from a small 64-bit binding and
artifact-completeness spike, not from another 90-minute whole-map bake.

## What 64-bit does not solve

Even a successful monolithic runtime does not classify stairs, prevent roofs
from becoming walkable, create missing doorway connectivity, implement
character-vs-character physics, stop weapon damage through walls, or make all
NPC AI cheap. It makes the complete reviewed topology available everywhere.
The existing regional classification and route evidence remains necessary, but
it becomes worth finishing only after the runtime foundation passes.
