# H1Emu monolithic64 claim audit

Audited: 2026-08-04

This is the strict evidence ledger for the proposed H1Emu `dev` pull request.
Anything under **Pending** must not be presented as completed or proven.

## Exact code and installation identity

- Clean PR worktree: `work/h1z1-nav64-dev-pr`.
- Branch: `feat/monolithic64-navmesh`.
- HEAD: `296c6e4099bce9ef81596ec54c1061b329abb6b6`.
- Base: fetched `QuentinGruber/dev` at
  `d4aeac97c851fec539dfe8709aa5939e50b0cbbe`.
- Relationship at the audit: zero commits behind and six commits ahead.
- The worktree is clean and the branch is pushed to
  `xsploit/h1z1-server:feat/monolithic64-navmesh`.
- QuickStart was transactionally updated from that clean compiled worktree.
  Backup: `clean-server-build-20260804-230233`.
- Installed `out/utils/recast.js` SHA-256:
  `7303BBDC90D7BB7653A180A31E88A70F9E896B044AF5B3F5F4BCC2FBDD875930`.
  It is byte-identical to the clean worktree and different from the prior
  experimental installation.

The installed Survivor Encounters plugin is not part of this six-commit PR.
It may load beside the PR build during client testing, but its behavior cannot
be claimed as part of the navigation diff.

## Proven on the exact clean build

- TypeScript build passes.
- Oxlint passes.
- Focused navigation tests pass 13/13.
- Real-cache server startup under bundled Node 24.18.0 succeeds.
- The loader imports 104,935/104,935 compressed layers and builds
  100,289/100,289 indexed columns.
- The active navmesh contains 104,903 tiles within 131,072 tile-reference
  slots. The 32-layer difference is recorded as compressed layers without an
  active navmesh tile; its geometric cause has not yet been classified.
- 176/177 authored transitions are admitted in 68 columns. The unattached
  House36B transition is reported by name rather than silently duplicated.
- Complete-cache startup takes approximately 18 seconds on this machine.
- The WASM linear memory is approximately 667 MiB after materialization.
- A corrected exact-install runtime smoke registered 100 fake character
  entities as valid server clients, produced no `CharacterId not found` damage
  spam, and kept Crowd and obstacle health true.
- A native churn probe on the exact installed build ran 20 waves of 50 real
  NPC objects. Every wave returned the active native Crowd count to its exact
  baseline. The first version of this probe accidentally double-created each
  NPC agent; that harness defect was corrected before accepting the result.
- The real client has now launched against the byte-verified clean server
  build. NPC navigation remained active through Pleasant Valley, an office
  interior, and at least one multi-floor apartment route. Small single-step
  business entrances still failed in the same session.

## Important wording correction: stock mode

The feature selection is opt-in: the 64-bit runtime is selected only when
`NAV_MONOLITHIC_64=1` and explicit core/WASM module paths are supplied.

Do **not** say that the stock runtime is wholly unchanged. The stock navmesh
and TileCache data format/path remain selected by default, but shared obstacle
accounting and fault-containment behavior also changed:

- obstacle counts now change only after successful add/remove operations;
- pending obstacle processing is capped per tick;
- obstacle addition can return `null` when capacity/backlog cannot be cleared;
- Crowd and obstacle-update faults are latched to prevent re-entering a
  potentially invalid native WASM state;
- the stock TileCache mesh process uses the explicit equivalent area/flag
  assignment used by the new loader.

The PR must describe those shared changes and test them; it must not hide them
behind “nothing changes unless enabled.”

## Withdrawn or superseded evidence

The earlier 40,000-step report is **not final-branch evidence**. Commit
timestamps and its missing transition log show that it ran after
`980d5d8b1` but before final commits `c1f000a85` and `296c6e409`.
It also had three harness limitations:

- fake characters were not valid damage targets, producing 25,399
  `CharacterId not found` lines;
- fake positions were not distributed unless tour mode was selected;
- no NPC batch-despawn churn occurred.

It may be retained only as explicitly labelled historical pre-transition
stress evidence. Its strongest narrow result is that, after warm-up, RSS moved
from 1,768 MiB at step 5,000 to 1,777 MiB at step 40,000 while processing
8,000 seconds of simulated Crowd time in 1,497 seconds of wall time. It does
not prove the final branch, real clients, combat load, or public-server scale.

The final-commit 1,000-step report is also superseded by the corrected harness
because it predated valid fake-client registration and native despawn churn.

## Hard ceilings and honest interpretation

- Crowd capacity is 2,000 agents. The historical high-load run reached 1,553
  agents (77.7%). The corrected short run peaked below the 90% rejection gate,
  but the final two-hour result is pending.
- Navmesh capacity is 131,072 tiles and the candidate currently uses 104,903
  active tiles (80.0%). This is finite headroom, not unlimited capacity.
- The WASM heap grows from its initial allocation to approximately 667 MiB
  during full-cache load. `_malloc` and `_free` are exported, but allocator
  free-space telemetry is not. Absence of an externally visible
  `_emscripten_resize_heap` function does not prove a non-growable heap: the
  runtime demonstrably grows during materialization. A separate allocation
  headroom probe or a native allocator metric is still required before quoting
  a free-memory margin.
- A constant `HEAPU8.buffer.byteLength` during a run proves only that the
  linear-memory allocation did not change in that interval. It does not prove
  absence of fragmentation, available native allocator headroom, or bounded
  total process RSS.

## What remains unproven

- The corrected final branch has not completed a true two-hour wall-clock
  synthetic navigation soak.
- The deterministic soak clears real AI/pathfinding timers and advances a
  synthetic clock. Even a two-hour pass proves sustained navigation workload,
  not a production server soak.
- One machine with 100 registered synthetic character objects is not 100
  network clients. Login/session behavior, replication, bandwidth, remote
  visibility, prediction, and packet backpressure remain untested.
- Distributed real-player explosions, screamers, construction churn, vehicles,
  and remote NPC activation remain untested at public population.
- Universal building topology is not proven. Known small thresholds and some
  upper-floor routes still fail.
- Physical wall, door, player, and drivable-vehicle collision is not solved by
  the navigation PR.
- The permanent Crowd/obstacle fault latch intentionally fails closed, but its
  operator visibility and restart guidance still need a final decision.
- “Mergeable” dependency PRs are not approved, CI-green, merged, or published.

## Test-suite truth

The full test command reports 81 pass, 2 fail, and 5 skip. The two displayed
failures are parent/subtest output for the existing `plugins/TestPlugin`
fixture, whose TypeScript 5-era configuration fails under the workspace
TypeScript 6 compiler and leaves `out/plugin` absent. Navigation, ZoneServer,
Crowd, obstacle, and world tests pass. The PR should report this exactly and
must not silently fix the unrelated fixture inside the navigation change.

## Dependency truth

The clean server integration depends on:

- `isaac-mason/recast-navigation-js#511` — opt-in 64-bit polygon references;
- `isaac-mason/recast-navigation-js#512` — Detour-owned TileCache input copy;
- `isaac-mason/recast-navigation-js#513` — active Crowd-agent counting;
- `isaac-mason/recastnavigation#1` — wider intermediate TileCache region IDs.

All four were open and GitHub reported them mergeable at the audit. None had a
review decision or status checks. The fourth targets the maintainer's fork,
not the canonical RecastNavigation repository. None of these changes is in the
published `recast-navigation@0.43.1` package.

## PR-readiness gate

Before telling the user the PR is ready:

1. finish the corrected true two-hour wall-clock navigation run on the exact
   installed clean bytes, with post-GC samples, native NPC churn, hard-cap
   utilization, obstacle state, health latches, clean stderr, final JSON, and
   exit code;
2. decide and document the fail-closed operator behavior after a Crowd or
   TileCache fault;
3. run the final build/lint/focused tests and record the known full-suite
   fixture failure without embellishment;
4. update the draft so every statement matches this ledger;
5. obtain one last adversarial diff/evidence review;
6. stop and ask the user for explicit permission before opening any PR.
