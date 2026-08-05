# H1Emu monolithic64 claim audit

Audited: 2026-08-05

This is the strict evidence ledger for the proposed H1Emu `dev` pull request.
Anything under **Pending** must not be presented as completed or proven.

## Exact code and installation identity

- Clean PR worktree: `work/h1z1-nav64-dev-pr`.
- Branch: `feat/monolithic64-navmesh`.
- HEAD: `d08d814fdd2ef0ba0d2d45274a00c32d6a3101fd`.
- Base: fetched `QuentinGruber/dev` at
  `d4aeac97c851fec539dfe8709aa5939e50b0cbbe`.
- Relationship at the audit: zero commits behind and seven commits ahead.
- The worktree is clean and the branch is pushed to
  `xsploit/h1z1-server:feat/monolithic64-navmesh`.
- QuickStart was transactionally updated from that clean compiled worktree.
  Backup: `clean-server-build-20260805-002335`.
- The complete installed `out` tree contains 957 files and has SHA-256 tree
  identity
  `2e1d99e381fd97e9e46bb3603bdecba870e44202c2ba187a4ecd6918db37a799`,
  byte-identical to the clean worktree. The deployment removed 72 stale
  experimental compiled files rather than overlaying the new build on them.
- Installed `out/utils/recast.js` SHA-256:
  `6c6d353fe4cef35191004ed87ca7ad4b0612fde0e14535965685f23db690e7fb`.

The installed Survivor Encounters plugin is not part of this seven-commit PR.
It may load beside the PR build during client testing, but its behavior cannot
be claimed as part of the navigation diff.

## Proven on the exact clean build

- TypeScript build passes.
- Oxlint passes.
- Focused navigation and ZoneServer tests pass 27/27, with one intentional
  Mongo test skip.
- Real-cache server startup under bundled Node 24.18.0 succeeds.
- The loader imports 104,935/104,935 compressed layers and builds
  100,289/100,289 indexed columns.
- The active navmesh contains 104,903 tiles within 131,072 tile-reference
  slots. The deterministic polygon inspector classifies the 32-layer difference
  as zero-polygon compressed layers; 104,935 - 32 = 104,903 exactly. Their
  underlying geometric cause remains open.
- The offline inspector also recorded five pre-patch region-buffer failures.
  The wider intermediate-region dependency listed below is what lets the final
  patched runtime build all 100,289 columns.
- 176/177 authored transitions are admitted in 68 columns. The unattached
  House36B transition is reported by name rather than silently duplicated.
- Exact final-HEAD runs loaded the complete cache in 17.943 and 23.848 seconds
  on this machine.
- The WASM linear memory is approximately 667 MiB after materialization.
- The installed WASM ABI directly passes the 64-bit PolyRef smoke, including
  values above `2^53` and the complete unsigned 64-bit bit pattern. This is a
  `DT_POLYREF64` build running in wasm32; it is not a wasm64 memory build and
  does not need to be one.
- The exact final-HEAD qualification smoke registered 10 fake character
  entities as valid server clients, ran two native NPC churn waves of 25, and
  started its capacity probe from 1,012 agents. The probe created 988 agents to
  fill all 2,000 slots, rejected one overflow agent, returned to the exact
  baseline, and kept Crowd and obstacle health true.
- The exact installed final branch completed a guarded two-hour wall-clock
  synthetic navigation soak. The worker reached 7,200.045 workload seconds
  and 602,003 Crowd steps, wrote its final report, and exited zero.
- All 100 synthetic character objects registered through the server client
  registry. They are not network clients and do not prove replication,
  bandwidth, prediction, or login/session scale.
- Final native Crowd accounting was exact at 1,551 active and 1,551 expected
  agents, with zero invalid indexes. Fifty waves of 50 native NPC creations
  and deletions created/deleted 2,500 agents and returned to the exact 1,551
  baseline.
- The native capacity probe filled all remaining slots to the configured 2,000
  agent limit, rejected exactly one overflow agent, removed every probe agent,
  and returned to the 1,551 baseline.
- The run completed 30,101 successful obstacle additions and 30,101 removals.
  Crowd and obstacle health remained true, pending obstacle requests ended at
  zero, and stderr contained no WASM/runtime fault.
- WASM linear memory was 667 MiB at the post-load baseline and at exit, with
  zero post-load growth events against a statically verified 2,048 MiB maximum.
  Twenty-four post-warmup forced-GC samples passed the evaluator's memory
  bounds. The final evaluator passed with no failures or warnings.

## Earlier client evidence, not final-HEAD proof

The real-client acceptance session ran against six-commit candidate
`296c6e409`, not final HEAD `d08d814fd`. That earlier candidate remained active
through Pleasant Valley, an office interior, and one multi-floor apartment;
small single-step business entrances still failed. Final-HEAD client acceptance
remains pending.

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

- fake characters were not registered through the server client registry, so
  the report does not establish client/damage-target validity;
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

- Crowd capacity is 2,000 agents. The final sustained workload retained 1,551
  agents (77.55%); the explicit boundary probe temporarily filled all 2,000
  slots and verified fail-closed overflow behavior before returning to
  baseline. The evaluator reports an 80.05% peak for the ordinary churn phase,
  below its 90% sustained-load gate.
- The loader selected `maxTiles=131,072`, the next power of two above the
  104,935 imported layers; 104,903 active tiles occupy 80.03% of that allocation.
  Because the allocation is derived from the input count, that percentage is
  not evidence of spare architectural capacity. The `DT_POLYREF64` layout's
  actual tile-index field is 28 bits; the selected runtime allocation is much
  smaller.
- The WASM memory section is wasm32, unshared, with 1,024 initial pages
  (64 MiB) and 32,768 maximum pages (2,048 MiB). The heap grows to 667 MiB
  during full-cache load and did not grow afterward during the two-hour run.
  `_malloc` and `_free` are exported, but allocator free-space telemetry is not;
  the 1,381 MiB difference to the linear-memory maximum is address-space
  headroom, not proven contiguous allocator capacity.
- A constant `HEAPU8.buffer.byteLength` during a run proves only that the
  linear-memory allocation did not change in that interval. It does not prove
  absence of fragmentation, available native allocator headroom, or bounded
  total process RSS.

## What remains unproven

- The deterministic soak clears real AI/pathfinding timers and advances a
  synthetic clock while its outer duration is real wall time. Its pass proves
  sustained server-side navigation/Crowd/obstacle workload, not a production
  server soak.
- One machine with 100 registered synthetic character objects is not 100
  network clients. Login/session behavior, replication, bandwidth, remote
  visibility, prediction, and packet backpressure remain untested.
- Distributed real-player explosions, screamers, construction churn, vehicles,
  and remote NPC activation remain untested at public population.
- Universal building topology is not proven. Known small thresholds and some
  upper-floor routes still fail.
- Physical wall, door, player, and drivable-vehicle collision is not solved by
  the navigation PR.
- A native WASM `RuntimeError` now fails navigation closed: Crowd, queries,
  agent calls, FSM entry, position synchronization, and obstacle mutation stop
  rather than re-entering a potentially poisoned runtime. `/serverinfo nav`
  exposes latch state and rejection/release counters. Recovery is an operator
  restart, not speculative in-process native recovery.
- “Mergeable” dependency PRs are not approved, CI-green, merged, or published.

## Test-suite truth

The latest full test command reports 89 pass, 2 fail, and 5 skip. The two
reported failures are parent/subtest output for one unrelated local fixture:
`plugins/TestPlugin/plugin.js` cannot load its absent `./out/plugin` build.

Focused navigation and ZoneServer tests pass 27/27 with one Mongo skip; build
and oxlint pass. The PR must not present the full suite as green or silently
modify that unrelated fixture inside the navigation change.

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

1. update the draft and long-form state documents so every statement matches
   this final report;
2. obtain one last adversarial diff/evidence review;
3. let the user run the final exact-build client acceptance test;
4. run the final build/lint/focused tests after any review fix;
5. stop and ask the user for explicit permission before opening any PR.
