# Navigation current state

Last verified: 2026-08-04

This is the short operational truth for the H1Emu Z1 navigation project. The
long-form history remains in `navigation-project-journey.md`; the architecture
and scale evidence remain in `navigation-full-pop-architecture.md`.

## Current decision

The preferred candidate server architecture is now an opt-in, complete-map, 64-bit
Recast/Detour WASM runtime. It materializes all 104,935 compressed TileCache
layers in 100,289 non-empty columns into one 64-bit navmesh before Crowd is
created. It does not evict tiles as players travel and therefore does not need
Skyline's mutable-streaming Crowd teardown/recreation lifecycle.

The older disk-indexed 32-bit streamer remains useful as a fallback and as
historical evidence, but it is not the intended full-population candidate.
Additive-safe streaming eventually exhausts its bounded active-tile budget;
mutable streaming invalidates Crowd polygon references during tile eviction
unless every native reference is coordinated. Those limitations matter for
distributed players and distant sound/explosion events.

The 64-bit path is opt-in. Stock H1Emu behavior remains the default when
`NAV_MONOLITHIC_64` is not `1`.

## Exact source map

| Purpose                                                                                   | Worktree / branch                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Clean H1Emu `dev` integration proposed for upstream                                       | `work/h1z1-nav64-dev-pr`, `feat/monolithic64-navmesh` |
| Experimental server, baker orchestration, validators, deployment, collision, and NPC work | `work/h1z1-pv-nav`, `feat/navigation-batch-crawler`   |
| Native Recast baker                                                                       | `work/h1emu-recast`                                   |
| JavaScript/WASM bindings and 64-bit runtime build                                         | `work/recast-navigation-js`                           |
| Deterministic ForgeLight extraction                                                       | `work/h1emu-map-data-extraction`                      |
| ForgeLight asset decoding                                                                 | `work/pydmod`                                         |

The clean integration is based on QuentinGruber `dev` commit `d4aeac97c` and
contains six bounded commits:

1. `b5fbd2cb1` - opt-in monolithic 64-bit loader and runtime selection;
2. `0e0946cd7` - release Crowd agents during batch NPC despawn;
3. `93d8201b5` - contain Crowd and obstacle-update WASM faults;
4. `980d5d8b1` - regression test for batch-despawn Crowd slots;
5. `c1f000a85` - preserve authored traversal transitions without duplicating
   them across vertically overlapping TileCache layers.
6. `296c6e409` - resolve the default transition file beside the selected cache
   bundle.

The branch is pushed to `xsploit/h1z1-server:feat/monolithic64-navmesh`. Do not
open the H1Emu pull request until the final readiness gate and user approval.
The pull request target is `QuentinGruber/h1z1-server:dev`, not `master`.

## Runtime and artifact

The currently installed QuickStart runtime has already demonstrated the
complete-map 64-bit startup path in the real server, but it is the experimental
`feat/navigation-batch-crawler` build rather than the exact clean
`feat/monolithic64-navmesh` package proposed for upstream. The installed
`out/utils/recast.js` hash is
`6F2563EED255E42E91A5CEEDD0592C9951E0697098B26BECE6D3C92BB7CD525C`,
matching the experimental worktree; the clean integration's corresponding hash
is `7303BBDC90D7BB7653A180A31E88A70F9E896B044AF5B3F5F4BCC2FBDD875930`.
The installed runtime demonstrated:

- 104,935 compressed layers;
- 100,289 materialized columns;
- 131,072 tile slots and 1,048,576 polygons per tile reference capacity;
- 667.3 MiB fixed WASM heap after load;
- approximately 17.6 seconds to import and materialize the full cache;
- heightmap, collision, plugins, loot tables, world NPCs, and PvE startup all
  complete afterward.

The installed log identified runtime artifact
`4b8368d7afdb72fdfe3ae73a7bc5a521dbe3caf860ce1d384f199f7cc42a2e2b` as
26 files / 619.3 MB with `runtime-only` provenance. `runtime-only` means the
installed files are hash-verified and playable, not that the complete baker
input lineage is ready for release.

The latest full candidate data is under:

`work/staging/full-apartments06-v1-bundle/data/2016`

Its collision directory contains the split TSET, direct diagnostic navmesh,
and H1COL2 collision. Its compiled `navigationTransitions.json` contains 177
reviewed traversal links.

## Authored transition parity

The compressed TSET does not serialize the runtime-authored off-mesh
connections. A TileCache mesh process must inject them whenever affected
columns are materialized or rebuilt.

The clean 64-bit loader now performs a deterministic two-pass load:

1. materialize the complete topology without transitions;
2. find the start polygon and owning tile layer for each authored transition;
3. rebuild only the 68 affected columns with each transition attached to one
   owner layer;
4. count what Detour actually admitted and report any unattached input.

Real-candidate verification produced 176 installed links from 177 inputs, no
duplicate user IDs, and 177/177 authored endpoint micro-route checks within
each link's configured radius. The one unattached entry is
`Common_Structures_Houses_House36B.adr #146659 north entrance upper seam`.
Its endpoint route succeeds through the remaining topology, so the runtime
reports it truthfully instead of duplicating it across layers. That micro-check
does not prove the link is unnecessary for every possible NPC route.

## What the client has proved

The real 2016 client has shown that the experimental 64-bit complete-map
runtime loads and NPC navigation remains active while traveling through
Pleasant Valley. This proves the architecture and candidate artifact can run in
the client, not that the exact clean six-commit `dev` integration has already
been client-tested. The tested experimental candidate supports:

- road to Pleasant Valley police-station front entrance;
- police basement to main floor;
- police main floor to second floor;
- multiple office interiors;
- at least one multi-floor apartment route to the roof;
- zombies active across normal travel rather than a player-local streamed
  window.

This is acceptance evidence, not universal building coverage. The latest
client pass still found small single-step storefront/business thresholds that
NPCs would not cross, and not every apartment/top-floor route has been
validated. The exact failing actor and placement must be identified before
another regional repair; `StoreFront04` itself already passes its authored
model validator, so a visual storefront failure must not be assumed to be that
model.

## What is not solved

Navigation is not physical collision. The current work does not justify any
claim that NPCs can never pass through a wall, door, player, or drivable
vehicle.

- Static H1COL2 BVH segment queries are available in the experimental server
  and are used for melee and ranged line-of-sight gates.
- The navmesh and authored transitions reduce wall shortcuts only where the
  baked topology is correct.
- Drivable vehicles and players currently contribute soft Crowd avoidance;
  they are not a hard swept-capsule collision solution.
- The previous server-authoritative position correction experiment was
  reverted because it caused visible jitter and rubber-banding.
- A client-controlled player character cannot simply donate its collision
  controller to a server-controlled NPC. The server needs its own stable sweep
  and slide implementation over the extracted collision world.

Human survivor/bandit gameplay, lootable corpses, factions, POI patrols, sound
investigation, and recruitment remain separate game-feature work. They should
not be folded into the focused 64-bit navigation pull request.

## Scale evidence and remaining gate

Focused unit tests, TypeScript build, lint, real-cache materialization, and the
transition-route verification pass. A corrected synthetic full-pop validator
creates 100 fake character entities with passive Crowd agents plus the
generated NPC and vehicle population,
retains native Crowd wrapper accounting, churns dynamic obstacles, checks a
recovery probe, watches the fixed WASM heap, and fails on Crowd or obstacle
faults. It does not create 100 network clients and therefore does not test
login/session handling, packet replication, bandwidth, client prediction, or
remote visibility.

The clean branch's full test run has one unrelated environment failure: the
tracked `plugins/TestPlugin` fixture has no compiled `out/plugin` because its
TypeScript 5-era configuration fails under the workspace TypeScript 6 compiler
(`rootDir` and deprecated `baseUrl`). All navigation, ZoneServer, batch-despawn,
Crowd, and obstacle tests pass. Do not misreport that fixture failure as a
navigation regression or silently modify it inside the navigation PR.

The externally logged 40,000-step, 100-synthetic-character obstacle-churn run
passed on the clean integration. Its 0.2-second update step represents 8,000
seconds of simulated Crowd time, but it completed in 1,497.179 seconds of wall
time. It is therefore an accelerated stress run, not a two-hour wall-clock
public-server soak. It recorded:

- 1,553 active agents / wrappers / expected agents;
- 1,438 current NPCs and 1,438 NPC agents;
- all 1,438 surviving initial NPC wrappers retained;
- 2,000 obstacle additions and 2,000 removals;
- healthy Crowd and obstacle updates;
- a recovery probe that moved 21.424 m with zero invalid steps;
- a fixed 667 MiB WASM heap;
- RSS from 1,117 MiB to 1,796 MiB while the JavaScript heap grew under the
  deliberately synthetic AI/damage workload;
- validator pass and process exit code 0.

The stderr file contained only H1Emu's unconditional clean-exit
`h1z1-server version` footer; there was no exception, rejection, WASM trap, or
fault latch. The final report is
`work/staging/full-apartments06-v1/clean-dev-monolithic64-40000-20260804.json`.
The fixed WASM heap is good evidence against native heap growth in this run,
but the RSS increase means this single run does not prove leak-free or
indefinitely bounded process memory.

A post-transition 1,000-step smoke then passed on `296c6e409` with 100 fake
character/Crowd entities, 1,435 NPC agents, 15 vehicle agents, exact
1,551-agent accounting, 50 obstacle add/remove cycles, a 16.175 m
recovery-probe displacement, fixed 667 MiB WASM heap, 176/177 transition
admission, and exit code 0. The report is
`clean-dev-transition-100-player-1000-20260804.json` in the same directory.

The remaining pull-request readiness work is an exact-build QuickStart/client
smoke of the clean six-commit integration, a final diff/truth review, and the
user's explicit approval to open it.

## Dependency pull requests

The clean server integration depends on four upstreamable native/binding
changes. GitHub currently reports all four as open and mergeable, but none has
a review decision or status checks:

- `isaac-mason/recast-navigation-js#511` - opt-in 64-bit polygon references;
- `isaac-mason/recast-navigation-js#512` - Detour-owned TileCache input copy;
- `isaac-mason/recast-navigation-js#513` - safe active Crowd-agent counting;
- `isaac-mason/recastnavigation#1` - widen intermediate TileCache region IDs.

The H1Emu PR must state these dependencies explicitly and must not imply that
the published `recast-navigation@0.43.1` package already contains them.

## Next work after the runtime PR is ready

1. Identify exact failing storefront/business/apartment actor IDs and instance
   transforms from client coordinates.
2. Run the regional doctor/crawler for only those actors; do not repeat a blind
   90-minute whole-map bake.
3. Repair model-local semantics or add evidence-backed transitions, validate
   all placements, merge the regional result into the base TSET, and only then
   publish a new full artifact.
4. Add stable server-side LOS and movement collision as separate, bounded
   changes with no rubber-band correction visible to the client.
5. Run real multi-client tests for distributed travel, explosions/screamers,
   remote NPC activation, vehicles, constructions, replication, and public
   population behavior before claiming production scale.

When these PR-readiness gates pass, stop and tell the user that the branch is
ready. Do not create the H1Emu pull request until the user explicitly approves
it.
