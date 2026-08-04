# Navmesh streaming (fine tilecache)

Optional mode that loads a **fine, whole-map navmesh** as a compressed
`TileCache` indexed from disk, instead of the coarse pre-baked navmesh in
`data/2016/navData/`. Enabled with the `NAV_STREAMING=1` environment variable.

This mode is currently a solo/small-group compatibility path, not a proven
full-population server architecture. See
[`navigation-full-pop-architecture.md`](navigation-full-pop-architecture.md)
for the production proof gate and alternatives.

## Why streaming

A fine monolithic navmesh of the whole map (~108k tiles) overflows Detour's
32-bit `dtPolyRef` budget (`tileBits + polyBits = 22`), so only a handful of
polys per tile survive and paths get truncated. Streaming keeps the **active**
navmesh bounded: the compressed tilecache remains split and disk-backed, while
only layers near a live player enter the TileCache/NavMesh runtime. The
streamed runtime periodically recycles its bounded layer set and rebuilds the
active crowd wrappers. This stays within the WASM and Detour reference budgets
while retaining whole-map coverage on disk. In the current default
**additive-safe** mode, columns are added but not evicted because the mutable
crowd/tile lifecycle previously produced WASM corruption. A long-running or
widely distributed multiplayer session can therefore exhaust the bounded
runtime layer budget. Mutable eviction is available only for explicit testing
with `NAV_STREAMING_MUTATION=1`; it is not production-approved.

## Enabling it

```bash
NAV_STREAMING=1 npm start
```

PowerShell:

```powershell
$env:NAV_STREAMING = "1"
npm start
```

Windows Command Prompt:

```bat
set NAV_STREAMING=1
npm start
```

At boot the server verifies `data/2016/navigation-artifact-manifest.json`, then
loads `data/2016/collision/z1_cache_*.bin` (TileCacheSet, magic `TSET`). Every
manifested runtime file is checked by size and SHA-256, cache part numbering
must be contiguous, and unmanifested cache parts are rejected. If streaming is
requested and the manifest or cache is absent, startup fails instead of
silently mixing or falling back to another artifact set.

Debug namespaces (via the `debug` module):

- `DEBUG=nav:stream` — tile window changes (`+N -M columns (loaded: K)`)
- `DEBUG=nav` — obstacle carving (`requests`, obstacle `total`)

## Regenerating the tilecache

The tilecache (~600 MB) is **gitignored** (`/data/2016/collision/`) and must be
generated with the official h1emu pipeline (it replaces the old in-repo
tooling). High-level steps:

1. Build [`h1emu-map-data-extraction`](https://github.com/H1emu/h1emu-map-data-extraction)
   (Rust) and [`h1emu-recast`](https://github.com/H1emu/h1emu-recast)
   (C++/CMake).
2. Extract the Z1 map (from the game's `Assets_*.pack`) to a `world.obj` with
   `h1emu-map-data-extraction`.
3. Set the **fine** parameters in `h1emu-recast/main.cpp` before building:
   | Constant | Fine value |
   |---|---|
   | `CELL_SIZE` | `0.2f` |
   | `CELL_HEIGHT` | `0.1f` |
   | `AGENT_MAX_CLIMB` | `1.5f` |
   | `AGENT_MAX_SLOPE` | `70.0f` |
   | `TILE_SIZE` | `128` |
   (On MSVC, wrap the GCC-only flags in `if(MSVC) ... else() ... endif()` in
   `CMakeLists.txt`.)
4. Run the builder on `world.obj`; it writes `z1_cache_*.bin` (the `TSET`
   tilecache) next to the navmesh.
5. Stage the cache, collision, heightmap, metadata, and transitions under one
   `data/2016` bundle.
6. Run `npm run navmesh-artifact-create`, including the source/tool commit
   options documented in `docs/navmesh-source-pipeline.md`.
7. Run `npm run navmesh-artifact-check` before installing the bundle.

For a QuickStart installation, deploy the already-verified runtime contract with
a recoverable backup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deployNavigationArtifact.ps1 `
  -QuickStartRoot "C:\Users\SUBSECT\Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master"
```

The deployment script refuses to modify a running installed server, verifies
the bundle before and after copying the compiled verifier/runtime files, and
prints the backup directory it created.

The default (coarse) parameters reproduce the stock `data/2016/navData` navmesh
exactly, which is a good sanity check that the pipeline is set up correctly.

## Runtime (`src/utils/recast.ts`)

- **artifact verification** — validates the deterministic bundle identity and
  all runtime hashes before any streamed cache is accepted.
- **`loadNavStreaming`** — indexes the split `TSET` files on disk, then inits an
  empty `TileCache` and tiled `NavMesh`. Compressed layers enter the WASM
  runtime only when their columns are visited.
- **`streamAround(playerPositions)`** — called from
  `zoneserver.updatePathfindingPositions()`; materialises columns around
  players. It removes columns that left the window only when the experimental
  `NAV_STREAMING_MUTATION=1` mode is enabled. Throttled by `STREAM_INTERVAL`.
- **Carving** — `addObstacle` / `removeObstacle` feed the tilecache
  (`addBoxObstacle`) and `updt()` pumps `tilecache.update()`, so player
  constructions carve the streamed navmesh natively (NPCs route around them).

## Tunables (`src/utils/recast.ts`)

| Constant          | Default | Meaning                                  |
| ----------------- | ------- | ---------------------------------------- |
| `STREAM_RADIUS`   | `300`   | meters around a player kept materialised |
| `STREAM_INTERVAL` | `1000`  | ms between window updates                |
