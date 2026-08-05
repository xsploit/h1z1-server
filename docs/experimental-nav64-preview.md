# H1Emu Nav64 experimental preview

This is a community test build, not an upstream H1Emu release and not a claim that navigation is finished. It combines a complete-map `DT_POLYREF64` Detour runtime with the current fine TileCache bake, authored transitions, extracted structure ground sampling, and structure-aware melee line-of-sight.

No upstream pull request is being proposed from this preview. The purpose is to let technically comfortable testers reproduce the current behavior and return useful evidence.

## What is actually working

- The complete fine cache can be materialized at once without player-centered streaming windows.
- The tested cache contains 104,935 compressed layers in 100,289 columns.
- The packaged runtime uses 64-bit Detour polygon references. WebAssembly itself remains `wasm32` and used about 667 MiB after the tested cache loaded.
- The current artifact installed 176 of 177 authored transitions.
- Extracted structure geometry is used for NPC ground sampling and melee line-of-sight.
- In the latest solo client smoke, Pleasant Valley and an office/apartment route were usable enough to test, and the server log showed no new WASM trap, crowd disable, or unhandled rejection.

## What is not solved

- This is not universal physical collision. NPC movement does not yet use a hard swept capsule against structure geometry.
- Some NPCs still cross walls, float outside upper floors, jitter, or rubber-band back to navigation.
- Building topology is incomplete. Door thresholds, small entrance steps, upper floors, roofs, and some stairs still vary by asset.
- One authored House36B transition is currently unattached.
- The exact collision-parity commit has a short real-client smoke, not a two-hour public-server soak.
- The earlier 100-character soak used synthetic in-process characters, not 100 network clients. Public population scaling is unproven.
- Survivor Encounters and human-NPC gameplay are separate experiments and are not part of this package.

## One-command build and install

The archive includes the server build, `DT_POLYREF64` runtime, exact exporter policy, authored transitions, pinned Windows CNK decoder, and prebuilt open-source Recast baker. It does not redistribute extracted H1Z1 client geometry, heightmaps, collision data, or baked cache files. The guided builder generates those from the tester's own compatible client.

Requirements:

- Windows 10/11 x64
- Git
- Python 3.12 x64 (`py -3.12` must work)
- internet access for the pinned pydmod clone and Python packages
- a compatible 2016 H1Z1 client containing `Resources\Assets\Assets_*.pack`
- an installed H1Emu 2016 QuickStart tree
- at least 5 GiB of free disk space
- the H1Emu server fully stopped

First run the no-write prerequisite check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\buildAndInstallExperimentalNav64.ps1 `
  -H1Z1Assets 'C:\path\to\H1Z1\Resources\Assets' `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -Plan
```

Then run the complete pipeline:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\buildAndInstallExperimentalNav64.ps1 `
  -H1Z1Assets 'C:\path\to\H1Z1\Resources\Assets' `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master'
```

The script pins every source revision, creates an isolated Python environment, extracts collision/semantics/terrain, validates the exact reviewed 2016 corpus, performs the full bake with a persistent log, creates a manifest, and calls the backed-up installer. Completed extraction stages are reused after interruption. The full bake normally takes 90–120 minutes.

By default its resumable workspace is `%LOCALAPPDATA%\H1Emu\Nav64Builder`. Use `-WorkRoot` to place it on a drive with more space. Use `-SkipInstall` to build and verify without touching QuickStart.

The generated layout is:

The required `data\2016` layout is:

```text
data\2016\collision\z1_cache_0.bin ...
data\2016\collision\z1_collision.bin
data\2016\zoneData\heightmap.png
data\2016\navigationTransitions.json
data\2016\navigation-artifact-manifest.json   (recommended)
```

The builder requires the exact reviewed output: collision SHA-256, semantic SHA-256, heightmap SHA-256, 820 meshes, 149,976 instances, 505,628 triangles, 22 cache parts, and 104,935 compressed layers. A mismatched client or partial bake is rejected instead of installed.

## Install

Manual installation remains available for developers who already generated the artifact.

- Windows PowerShell 5.1 or newer
- Node 24 or 25
- generated navigation data in the installed server's `data\2016`, or in a separate source directory

Extract this preview outside QuickStart. Run a no-write check first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\installExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -Plan
```

Then install:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\installExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master'
```

If the generated artifact is outside QuickStart and the target contains no previous fine bake:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\installExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -NavigationDataRoot 'C:\path\to\generated\data\2016'
```

The installer verifies every packaged file, validates the generated data, refuses to run while H1Emu is active, backs up the existing compiled server/runtime/launcher, and configures Play for monolithic64 mode.

## Required startup evidence

Do not join until the server prints all of the following:

```text
[NAV] monolithic64 materialized ...
[NAV] monolithic64 tilecache ready (... complete-map mode)
[Heightmap] loaded 8192x8192
[Collision] loaded ...
Server is ready and accepting connections.
```

Report the entire startup block plus the exact place and direction of any bad route. Useful reports identify the building, floor, doorway/stair, start point, destination, and whether the NPC stopped, crossed a wall, floated, or rubber-banded.

## Roll back

Use the backup path printed by the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rollbackExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -BackupRoot 'C:\path\to\h1z1-server-QuickStart-master\backups\experimental-nav64-YYYYMMDD-HHMMSS'
```

## Source identities for preview 0.2.0

- Server branch: `xsploit/h1z1-server`, `feat/nav64-collision-parity`
- Base monolithic64 server commit: `d08d814fd`
- Collision parity commits: `f0d66ecfe`, `1de3eb58f`
- `recast-navigation-js` DT_POLYREF64 runtime source: `3a41b0d2198051ee5ffda6a4720d400b0f829bab`
- Runtime artifact: `7ec35b7039eb5382528ba44fb2b316c225aed79da933a948e519c970583fe7ad`
- Exporter/policy tooling: `ee3e2721c062bb0d5b3d0ed401aaa2025fbe71a5`
- Recast baker: `2646f66a7eae3d601579f86752cbf699ae2c3915`
- pydmod: `d220703826b39bdccd54956782e57809696226b5`

This preview should be discussed as an experiment. A clean process, one successful route, or one synthetic load test does not prove feature completeness or full-server stability.
