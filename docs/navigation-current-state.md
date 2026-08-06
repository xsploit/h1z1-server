# Navigation current state

Last verified: 2026-08-05

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

The 64-bit path is opt-in. The stock navmesh/TileCache data path remains the
default when `NAV_MONOLITHIC_64` is not `1`. Shared obstacle-accounting and
fault-containment fixes do apply in both modes; do not describe stock behavior
as wholly unchanged.

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
contains seven bounded commits:

1. `b5fbd2cb1` - opt-in monolithic 64-bit loader and runtime selection;
2. `0e0946cd7` - release Crowd agents during batch NPC despawn;
3. `93d8201b5` - contain Crowd and obstacle-update WASM faults;
4. `980d5d8b1` - regression test for batch-despawn Crowd slots;
5. `c1f000a85` - preserve authored traversal transitions without duplicating
   them across vertically overlapping TileCache layers.
6. `296c6e409` - resolve the default transition file beside the selected cache
   bundle.
7. `d08d814fd` - fail navigation closed after a native runtime fault, reject
   invalid/overflow Crowd agents, expose operator health, and prevent native
   re-entry from NPC FSM and synchronization paths.

The branch is pushed to `xsploit/h1z1-server:feat/monolithic64-navmesh`. Do not
open the H1Emu pull request until the final readiness gate and user approval.
The pull request target is `QuentinGruber/h1z1-server:dev`, not `master`.

## Runtime and artifact

QuickStart now contains the exact compiled clean seven-commit server build at
`d08d814fd`. Its complete 957-file `out` tree has SHA-256 tree identity
`2e1d99e381fd97e9e46bb3603bdecba870e44202c2ba187a4ecd6918db37a799`,
byte-identical to `work/h1z1-nav64-dev-pr`; deployment removed 72 stale
experimental compiled files. Installed `out/utils/recast.js` is
`6c6d353fe4cef35191004ed87ca7ad4b0612fde0e14535965685f23db690e7fb`.
The recoverable pre-deployment backup is
`clean-server-build-20260805-002335`. The separately installed Survivor
Encounters plugin is not part of the PR diff.

The exact installed runtime demonstrated:

- 104,935 compressed layers;
- 100,289 materialized columns;
- 104,903 active navmesh tiles; the deterministic polygon inspector classifies
  the 32-layer difference as zero-polygon compressed layers, while their
  underlying geometric cause remains open;
- five pre-patch offline-inspector region-buffer failures, addressed by the
  wider intermediate-region dependency used by the final runtime;
- a selected runtime allocation of 131,072 tile slots and a `DT_POLYREF64`
  capacity of 1,048,576 polygon references per tile;
- approximately 667.3 MiB of WASM linear memory after load;
- 17.943 and 23.848 seconds in the two exact final-HEAD runs;
- heightmap, collision, plugins, loot tables, world NPCs, and PvE startup all
  complete afterward.

The launcher-verified runtime artifact is
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

## Earlier client checkpoint and final-HEAD gap

The real 2016 client session ran against six-commit candidate `296c6e409`. It
did not run against final HEAD `d08d814fd`, which adds the
fail-closed native fault containment. NPC navigation remained active while
traveling through Pleasant Valley. That earlier candidate supports:

- road to Pleasant Valley police-station front entrance;
- police basement to main floor;
- police main floor to second floor;
- multiple office interiors;
- at least one multi-floor apartment route to the roof;
- zombies active across normal travel rather than a player-local streamed
  window.

This is earlier runtime/topology evidence, not final-HEAD acceptance or
universal building coverage. That client pass found small single-step
storefront/business thresholds that NPCs would not cross, and not every
apartment/top-floor route has been validated.

The follow-up regional admission identified the three remaining repeated
storefront actors instead of assuming they were `StoreFront04`. Hash-bound,
fail-closed rules now classify only their ground-floor and entrance surfaces;
their walls and roofs remain obstacles. The exact combined policy and compiled
279-link transition source passed 408/408 bidirectional route probes across all
51 StoreFront01 through StoreFront03 placements. All 153 forbidden roof probes
also passed. This is reproducible regional source evidence, not a full-map bake
or client acceptance result: the currently installed 104,935-layer artifact
still predates this business batch.

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
transition-route verification pass. A corrected synthetic scale validator
creates 100 registered fake character entities with passive Crowd agents plus
the generated NPC and vehicle population, retains native Crowd wrapper
accounting, performs repeated native NPC spawn/batch-despawn waves, churns
dynamic obstacles, checks a recovery probe, samples process memory before and
after forced GC, records Crowd/tile/obstacle headroom, and fails on Crowd or
obstacle faults. It does not create 100 network clients and therefore does not test
login/session handling, packet replication, bandwidth, client prediction, or
remote visibility.

The clean branch's full test run has one unrelated local-fixture failure: the
tracked `plugins/TestPlugin` has no compiled `out/plugin` in this checkout, so
its load assertion and parent suite fail. All navigation, ZoneServer,
batch-despawn, Crowd, and obstacle tests pass. Do not misreport that fixture
failure as a navigation regression or silently modify it inside the navigation
PR.

The older externally logged 40,000-step run is withdrawn as final-branch
evidence. It ran before the final transition commits, did not register fake
characters through the server client registry, and performed no native NPC
despawn churn. Its strongest narrow,
historical result is that RSS moved only from 1,768 MiB at step 5,000 to
1,777 MiB at step 40,000 after warm-up while processing 8,000 seconds of
simulated Crowd time in 1,497.179 seconds. It does not prove the final branch,
real clients, or public-server scale.

A short exact-final-HEAD qualification smoke proved:

- 10/10 fake characters resolve through the server client registry;
- two native NPC churn waves of 25 agents each return to the exact baseline;
- from its 1,012-agent baseline, the capacity probe creates 988 agents to fill
  all 2,000 Crowd slots, rejects one overflow agent, and returns to baseline;
- healthy Crowd and obstacle updates;
- process-memory samples run with `--expose-gc` and record before/after GC;
- approximately 667 MiB of WASM linear memory during the smoke;
- validator pass and process exit code 0.

The exact installed final branch then completed the guarded two-hour run:

- 7,200.045 workload wall seconds and 602,003 Crowd steps, final report present,
  clean exit code 0;
- 100/100 registered synthetic character objects (not network clients);
- 1,551 active / 1,551 expected final agents with zero invalid indexes;
- 50 waves x 50 native NPC agents, 2,500 created and 2,500 deleted, exact
  baseline recovery;
- explicit fill to the 2,000-agent capacity, one clean overflow rejection, and
  exact return to baseline;
- 30,101 obstacle additions and 30,101 removals, zero pending requests, healthy
  Crowd and obstacle latches;
- 667 MiB post-load and final WASM allocation, zero post-load growth events,
  and a statically verified 2,048 MiB wasm32 linear-memory maximum;
- 24 post-warmup forced-GC samples within the evaluator's memory limits;
- final evaluator pass with no failures or warnings.

Evidence is under `work/staging/installed-distributed-100-player-2h-d08d814fd-20260805.*`.
This clears the exact-build sustained synthetic navigation gate. It does not
convert the synthetic characters into real network clients or prove public
server replication/event behavior.

The WASM heap grows from its initial allocation to the loaded value, so an
unchanged `HEAPU8` size during a soak must not be described as “fixed heap” or
free-memory proof. Native allocator free space is not currently exported.

The remaining pull-request readiness work is documentation reconciliation, a
final adversarial diff/evidence review, the user's final exact-build client
test, and the user's explicit approval to open it.

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
