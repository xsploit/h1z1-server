# H1Emu monolithic64 claim audit

Audited: 2026-08-04

This file separates what the current evidence literally proves from what still
requires testing. It is intentionally stricter than release copy.

## Proven by current evidence

- `work/h1z1-nav64-dev-pr` is a clean six-commit branch based on
  `QuentinGruber/dev` at `d4aeac97c`; it is zero commits behind and six commits
  ahead.
- The feature is opt-in. The stock runtime path remains selected unless
  `NAV_MONOLITHIC_64=1`.
- The clean integration imported all 104,935 compressed candidate layers,
  built all 100,289 non-empty columns, and produced 104,903 active navmesh
  tiles with 131,072 tile-reference capacity.
- Its accelerated 40,000-step synthetic run completed all requested updates,
  retained exact Crowd wrapper/agent accounting for 100 fake character agents,
  1,438 NPC agents, and 14 vehicle agents, completed 2,000 obstacle add/remove
  cycles, kept Crowd and obstacle health flags true, kept the WASM heap at
  667 MiB, passed its validator, and exited zero.
- The post-transition 1,000-step run on final clean commit `296c6e409` also
  passed exact agent accounting, obstacle churn, recovery movement, health
  flags, fixed WASM heap, validation, and clean exit.
- The real client ran the same complete-map architecture and candidate artifact
  through the experimental integration branch and exercised several Pleasant
  Valley interiors and vertical routes.
- The four dependency PRs are open and GitHub reports them mergeable. As of the
  audit, none has a review decision or status checks.

Evidence hashes:

- long report: `10EDF56954D1E6117A49A778EB84C408CFE87229C312BE714CF25C3FDC8100CE`;
- long stdout: `F3F67F514370BDBB52FF6E6BEB751DDB1F33AF4FD91D2B0FC3A65B05EF4828E4`;
- long stderr: `D020EBD5876DD021230C94723F63C38E3D5FBBDDC44614D8B953870B21466D25`;
- final-branch short report:
  `A9318082D62125A21582F3C201959F3284D33A133D517F9E8B6D3169C209222F`.

## Not proven

- The exact clean six-commit upstream branch has not yet been installed into
  QuickStart and exercised by the real client. The installed `recast.js` hash
  matches the experimental branch, not the clean PR worktree.
- The synthetic 100-character harness is not a 100-client network test. It does
  not prove replication, bandwidth, session/login, remote visibility, client
  prediction, or public-server population behavior.
- The accelerated 40,000-step run is not a two-hour wall-clock soak. It models
  8,000 seconds of Crowd updates in about 1,497 seconds of wall time.
- Fixed WASM heap does not prove total process memory is leak-free. RSS rose
  from 1,117 MiB to 1,796 MiB and JavaScript heap use rose from 243 MiB to
  291 MiB during the long synthetic run.
- Importing the complete candidate does not prove universal or correct building
  topology. Small thresholds and some upper-floor routes still fail.
- The 177 endpoint micro-route checks do not prove all real NPC routes. One
  House36B transition was not attached even though its endpoint route resolves
  through the remaining topology.
- This work does not solve hard wall, player, drivable-vehicle, or dynamic-door
  collision, nor does it prove NPC combat line of sight in every structure.
- "Mergeable" does not mean dependency PRs are reviewed, CI-green, accepted,
  or published.
- The full test command is not entirely green: 81 pass, 2 fail, 5 skip. Both
  failures represent the existing TestPlugin fixture's TypeScript 6 compile
  incompatibility; navigation-related tests pass.

## Required before saying the branch is PR-ready

1. Package and install the exact clean six-commit build in a recoverable test
   deployment, verify its hashes, and run a focused real-client smoke.
2. Re-run and archive the build, lint, focused tests, full test counts, real
   cache load, transition counts, stderr scan, and installed hash evidence.
3. Ensure the PR explains that the generated cache and 64-bit WASM dependencies
   are external and not present in published `recast-navigation@0.43.1`.
4. Present dependency status as factual status, not implied acceptance.
5. Do not claim public-server production readiness until a real multi-client,
   distributed-event, vehicle/construction, and long-duration memory test has
   been run.
