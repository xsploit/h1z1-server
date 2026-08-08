# H1Emu Nav64 experimental preview 0.3.0

This is a community test build for the 2016 H1Z1 client. It is not an official H1Emu release, it is not an upstream pull request, and it does not claim that NPC navigation is finished.

The preview packages the open server/runtime changes, the `DT_POLYREF64` Recast/Detour runtime, the reviewed collision policy, authored navigation transitions, a prebuilt open-source baker, and a backed-up installer. It deliberately does **not** contain H1Z1 client files, extracted geometry, the generated heightmap, collision blobs, or the roughly 535 MiB baked navigation cache. Those are generated once on the tester's own computer from their own compatible client.

The download is therefore only about 2–3 MiB. The first local extraction and full-map bake normally takes 90–120 minutes on the machine used for development. Later installs can reuse the completed work directory.

## Fastest installation

1. Install a compatible H1Z1 2016 client and H1Emu 2016 QuickStart.
2. Install Git and 64-bit Python 3.12.
3. Stop the H1Emu server.
4. Extract this preview somewhere outside the QuickStart directory.
5. Double-click **`INSTALL-NAV64.cmd`**.
6. Confirm the detected H1Z1 and QuickStart folders, then type `YES`.
7. Leave the window open. The persistent logs are printed in the window and stored under `%LOCALAPPDATA%\H1Emu\Nav64Builder\logs` by default.
8. After success, start H1Emu normally and wait for the complete-map readiness block shown below before joining.

The setup detects the common `Documents\H1Z1-2016`, Steam depot, Steam common-library, and H1Emu locations. If it cannot identify one unambiguously, it opens a folder picker. It accepts the H1Z1 root, `Resources`, or `Resources\Assets` folder.

## What the installer does

The pipeline is intentionally explicit and fail-closed:

```text
tester-owned H1Z1 2016 Assets_*.pack
  -> isolated pinned extractor environment
  -> collision, semantics, and 8192x8192 terrain heightmap
  -> full-map fine TileCache bake with the DT_POLYREF64 baker
  -> manifest and exact hash validation
  -> transactional QuickStart backup
  -> compiled server + 64-bit Detour runtime install
  -> QuickStart launch configuration
```

It does not patch the H1Z1 client. It modifies only the selected H1Emu QuickStart installation and its generated server data. Before changing QuickStart it verifies the package and generated artifact, confirms that the server is stopped, and creates a timestamped backup under `QuickStart\backups`.

Completed extraction stages are reused. If the process is interrupted during the long bake, rerun the same command. A partial or mismatched bake is rejected instead of silently installed. Use `-Rebuild` only when you intentionally want to archive the existing generated work and start again.

## Requirements

- Windows 10 or 11 x64
- a compatible 2016 H1Z1 client containing `Resources\Assets\Assets_*.pack`
- an installed H1Emu 2016 QuickStart tree containing `h1emu-2016.js`
- Git on `PATH`
- Python 3.12 x64 (`py -3.12` must work)
- internet access during first setup for the pinned extractor repository and Python dependencies
- at least 5 GiB free on the drive holding the work directory
- H1Emu fully stopped during installation or rollback

Node is supplied by a normal QuickStart installation. The server/runtime was developed and tested with Node 24.18.0.

## Manual prerequisite check

Run this from the extracted preview folder. `-Plan` performs validation and prints the intended paths without extracting, baking, or installing anything.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\startExperimentalNav64Setup.ps1 `
  -H1Z1Assets 'C:\path\to\H1Z1\Resources\Assets' `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -Plan
```

To use a larger drive for resumable work:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\startExperimentalNav64Setup.ps1 `
  -H1Z1Assets 'C:\path\to\H1Z1\Resources\Assets' `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -WorkRoot 'D:\H1Emu-Nav64-Work'
```

For unattended use after reviewing the plan, add `-Yes`.

## Direct builder command

The lower-level command is available when automatic discovery is undesirable:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\buildAndInstallExperimentalNav64.ps1 `
  -H1Z1Assets 'C:\path\to\H1Z1\Resources\Assets' `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master'
```

Useful switches:

- `-Plan`: validate prerequisites and identities without changing files.
- `-SkipInstall`: extract, bake, and verify but do not modify QuickStart.
- `-WorkRoot D:\path`: put resumable generated data and logs elsewhere.
- `-Rebuild`: archive previous extraction/bake outputs and regenerate them.

Default work layout:

```text
%LOCALAPPDATA%\H1Emu\Nav64Builder\
  artifact\data\2016\
    collision\z1_collision.bin
    collision\z1_cache_0.bin ... z1_cache_21.bin
    zoneData\heightmap.png
    navigationTransitions.json
    navigation-artifact-manifest.json
  bake\
  logs\setup.log
  logs\extract.log
  logs\bake.log
  pydmod\
```

Do not upload the generated `artifact`, `bake`, collision, heightmap, cache, or original client asset files when reporting a bug. Logs, coordinates, screenshots, and the small manifest are sufficient.

## Exact frozen release target

The release builder rejects inputs that do not reproduce the reviewed 2016 corpus and current full bake:

- collision: 820 meshes, 149,976 instances, 505,628 source triangles
- collision SHA-256: `ce8ca93c8b3d3607d829b323580b6cad60723ea46c7f46eb0e8f16ed38656065`
- semantics SHA-256: `eab9ecb7b880ce5fd2ed0571850d7d5467152e176123e407ff764bde2689fe97`
- heightmap: 8192x8192, SHA-256 `78799a6429aaf910cc5c38fe4d8ebfa15d79096c272e77faa3cc2a089ecadc21`
- cache: 105,030 compressed layers in 22 parts
- complete-map runtime columns: 100,288
- runtime transitions: 355, SHA-256 `27e26a54a0784937b23048c1f9e2842c7c8f4fb1a941397fe02e1be95b4f45b5`
- generated artifact tested locally: `90c69be70ed2bcbbdb16162d59af2a69dac6e38bbad0d1d6a0e0e45c56918763`

The generated artifact ID is reference evidence, not a file included in this download. Each local run produces and verifies its own manifest.

## Required startup evidence

Do not join immediately. Wait for this sequence:

```text
[NAV] monolithic64 imported ...
[NAV] monolithic64 built ...
[NAV] monolithic64 installed 353/355 transitions in 68 columns
[NAV] monolithic64 tilecache ready (105030 layers, 100288 columns, ... complete-map mode)
[Heightmap] loaded 8192x8192
[Collision] loaded 820 meshes (...), 149976 instances
Server is ready and accepting connections.
```

The two known unattached transitions in this frozen artifact are:

- `Common_Structures_Houses_House36B.adr #146659 north entrance upper seam`
- `Common_Structures_HardwareStore01.adr #148607 east threshold seam`

An unattached transition is reported and skipped; it does not abort server startup.

On the tested machine, complete-map materialization used about 667.3 MiB of WebAssembly heap and the navigation load took about 25 seconds. `DT_POLYREF64` means Detour polygon references are 64-bit. The WebAssembly host itself remains `wasm32`; those are separate facts.

## What currently works

- The entire fine cache is materialized without player-centered streaming windows or tile eviction.
- NPC path queries are no longer limited to the neighborhood of one live player.
- The 64-bit Detour reference layout has capacity for the complete tested map.
- Extracted structure geometry supports NPC ground sampling and structure-aware melee line-of-sight.
- Authored threshold/stair transitions are installed for the reviewed repeated building archetypes.
- Pleasant Valley road-to-police-station access, internal police-station floors, several offices/storefronts, and tested apartment routes are materially better than the upstream coarse navigation.
- A focused Pleasant Valley storefront validation passed 392/392 prepared crowd routes across StoreFront01-04.
- Installation and rollback are transactional and hash-verified.

## What is still incomplete

This is the reason the release is marked **experimental**:

- It is not universal physical collision. NPC movement still lacks a final hard swept capsule against every structure and vehicle shape.
- Zombies can still clip through some walls or doors, float outside upper floors, jitter, or rubber-band back to the navigation surface.
- Small entrance steps, thresholds, stairs, balconies, roofs, and upper-floor seams vary by building asset.
- Some buildings work from one entrance or direction but route around from another.
- A broader StoreFront01 validation passed 204/216 routes; 12 failures were concentrated at three non-Pleasant-Valley placements. The Pleasant Valley subset passed.
- Static and drivable vehicle avoidance is not equivalent to original client physics.
- Building semantic classification is incomplete. The current campaign covers 12 reviewed archetypes, not every structure on the map.
- Human NPCs, factions, survivor recruitment, lootable corpses, and Survivor Encounters are separate experiments and are not bundled by this preview.
- The earlier 100-character soak used synthetic in-process characters, not 100 real network clients. Full public-population scaling is not proven.
- One working route, one clean process, or one synthetic load test does not prove feature completeness.

## Manual installation with an existing local artifact

Developers who already generated the expected data can install without rebuilding:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\installExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -NavigationDataRoot 'D:\generated\artifact\data\2016' `
  -Plan
```

Remove `-Plan` after verifying the printed paths. The installer refuses to overwrite an unrelated existing generated artifact. Back it up or use the existing data in place.

## Rollback

Every successful installation prints its backup directory. Stop H1Emu, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rollbackExperimentalNav64Preview.ps1 `
  -QuickStartRoot 'C:\path\to\h1z1-server-QuickStart-master' `
  -BackupRoot 'C:\path\to\h1z1-server-QuickStart-master\backups\experimental-nav64-YYYYMMDD-HHMMSS'
```

The rollback restores the previous compiled server, runtime, launcher, and bootstrap state. Locally generated work under `%LOCALAPPDATA%\H1Emu\Nav64Builder` is retained so a later retry does not require another extraction/bake.

## Troubleshooting

### The double-click installer cannot find H1Z1

Select the folder that directly contains `Assets_*.pack`, or select its parent `Resources`/H1Z1 folder. The usual path is `H1Z1-2016\Resources\Assets`.

### Python 3.12 is missing

Install 64-bit Python 3.12 and enable the Python launcher, then confirm:

```powershell
py -3.12 -c "import sys; print(sys.version)"
```

### A previous bake is mismatched or partial

The builder stops instead of mixing artifacts. Preserve the printed logs, then rerun with `-Rebuild`. This archives the prior generated files under the work root before starting again.

### The server says the navigation artifact is missing

Confirm that the selected QuickStart contains:

```text
node_modules\h1z1-server\data\2016\collision\z1_cache_0.bin
node_modules\h1z1-server\data\2016\collision\z1_collision.bin
node_modules\h1z1-server\data\2016\zoneData\heightmap.png
node_modules\h1z1-server\data\2016\navigationTransitions.json
```

Then rerun the installer with `-Plan`; do not manually mix cache parts from different bakes.

### H1Emu is reported as running

Close the game/server launcher and stop the relevant QuickStart Node process. The installer intentionally refuses to replace runtime files while they are in use.

### The server loads but an NPC takes a bad route

Record the building, town, floor, entrance, direction of travel, and exact failure: stopped, routed around, crossed a wall, floated, or rubber-banded. Include the complete startup navigation block and server log around the incident.

## Useful bug report format

```text
Preview version: 0.3.0
Package sourceCommit: <from preview-manifest.json>
Navigation artifactId: <from navigation-artifact-manifest.json>
Town/building: Pleasant Valley / storefront beside ...
Start: street outside east door
Target: interior back room
Observed: stops at the single entrance step / crosses north wall / etc.
Expected: enters through the door and follows the player
Startup block: <paste NAV, Heightmap, Collision, ready lines>
```

Screenshots or a short video help. Do not attach original game packs or generated geometry/cache files.

## Source and artifact identities

The package's `preview-manifest.json` is authoritative for the exact release commit and every packaged file hash. Preview 0.3.0 is assembled from:

- server branch: `xsploit/h1z1-server`, `feat/nav64-collision-parity`
- Recast baker source: `5fc5facbdabeeed65dc4c0ee4d1fe809be0bdc1f`
- exporter/policy tooling: `8b65541ac7e2c0b24fb8ce796f7a72c62003b916`
- Recast Navigation JS runtime source: `3a41b0d2198051ee5ffda6a4720d400b0f829bab`
- runtime artifact: `7ec35b7039eb5382528ba44fb2b316c225aed79da933a948e519c970583fe7ad`
- pinned pydmod source: `d220703826b39bdccd54956782e57809696226b5`

The archive includes the relevant open-source licenses. It contains no baked navigation cache or original H1Z1 client assets.
