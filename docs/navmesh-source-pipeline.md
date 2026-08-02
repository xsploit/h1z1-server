# Navmesh source pipeline

The whole-map tile cache and the metadata describing doors and stairs must be
generated from the same extracted zone revision. This avoids treating client
animation problems as pathfinding fixes and keeps manual links auditable.

## Build artifacts

There are two mutually exclusive geometry-source paths. Never concatenate their
OBJs.

The render/ADR path from the `h1emu-map-data-extraction` integration branch
produces:

- `out/world.obj`: terrain and static walkable/collision geometry. Movable door
  panels are deliberately excluded, while their surrounding buildings remain.
- `out/navigation_metadata.json`: versioned world-space transforms for the
  extracted door and stair actors. Its `bakedDoorGeometryExcluded` marker is
  true only when every configured door rule is also excluded from the mesh.

Build the tile cache from that `world.obj` with the matching `h1emu-recast`
pipeline. Copy the cache parts and `navigation_metadata.json` into:

```text
data/2016/collision/z1_cache_*.bin
data/2016/navigation_metadata.json
```

The collision-first regional path uses `tools/forgelight/export_semantic_nav_obj.js`
to produce one canonical semantic OBJ directly from the native heightmap and
H1COL2 instanced collision used by server grounding. This is the authoritative
fallback when the render/ADR extraction has no triangle at a known road,
sidewalk, or approach anchor. Its source report hashes both runtime inputs and
states the mesh-level classification limitations. Feed that OBJ directly to
the same C++ baker; do not merge it with render geometry.

H1COL2 has only four mesh-level kinds. Walkable geometry is preserved (and can
retain road/stair/ramp identity when the optional actor metadata sidecar is
available); solid and thin geometry map fail-closed to `nav_obstacle_static`;
door panels map to `nav_door_panel_dynamic`. Because a merged composite actor
does not identify connected surface components, this bridge does not claim
perfect roof/interior classification. Regional topology gates decide whether
it is stronger than the render path before any full bake is considered.

Whichever path is selected, the runtime bundle still contains the matching
H1COL2 collision mesh and heightmap. They must describe the same world revision
as the bake and remain bound by the artifact manifest.

## Artifact contract

Every streamed runtime must contain
`data/2016/navigation-artifact-manifest.json`. The manifest binds the ordered
cache parts, H1COL2 collision mesh, heightmap, navigation metadata, semantic
bake report, and reviewed transitions by size and SHA-256. Its deterministic
`artifactId` identifies the complete runtime bundle.

Generate and verify a staged bundle with:

```powershell
npm run navmesh-artifact-create -- --bundle-root data/2016 `
  --source-world C:\path\to\world.obj `
  --classifier-config C:\path\to\config.yml `
  --semantic-report C:\path\to\navigation-semantics.json `
  --extractor-commit <sha> `
  --recast-commit <sha> `
  --recast-navigation-commit <sha>
npm run navmesh-artifact-check -- --bundle-root data/2016
```

New builds must use `provenance.status=complete`. Complete provenance requires
all three tool commits, source/classifier hashes, navigation metadata, and a
strict `h1emu-nav-semantics-v1` report with zero fallback triangles, ordinary
materials, or warnings. A pre-contract rollback can be recorded honestly as
`runtime-only`; it still receives full runtime hashes but does not pretend that
its original `world.obj` or tool commits are known.
When `NAV_STREAMING=1`, a missing, altered, mixed, or incomplete cache bundle
is a startup error. The server does not silently fall back to another navmesh.

Validate the sidecar before starting the server:

```powershell
npm run navmesh-metadata-check
```

When the validated sidecar says the baked door geometry was excluded, set
`H1EMU_DYNAMIC_DOOR_OBSTACLES=1` to make static world doors dynamic tile-cache
obstacles. Opening or destroying a door removes its obstacle; closing it
restores the obstacle. If the sidecar is absent or does not declare excluded
door geometry, the opt-in remains disabled.

## Transitions

`data/2016/navigationTransitions.json` contains only reviewed off-mesh links,
such as the Pleasant Valley police front steps. Door thresholds are not linked
blindly: an off-mesh link across every door would let NPCs bypass a closed
door. Add a transition only after the matching validator proves that ordinary
navmesh connectivity cannot represent the stair or threshold.

Useful focused checks:

```powershell
npx tsx scripts/validatePvPoliceFrontSteps.ts
npx tsx scripts/validatePvPoliceEntrance.ts
npx tsx scripts/validatePvPoliceBasement.ts
npx tsx scripts/validateStreamingDoorways.ts
```
