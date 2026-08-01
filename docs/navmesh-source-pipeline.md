# Navmesh source pipeline

The whole-map tile cache and the metadata describing doors and stairs must be
generated from the same extracted zone revision. This avoids treating client
animation problems as pathfinding fixes and keeps manual links auditable.

## Build artifacts

The `h1emu-map-data-extraction` integration branch produces:

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

Validate the sidecar before starting the server:

```powershell
npm run navmesh-metadata-check
```

When the validated sidecar says the baked door geometry was excluded, static
world doors automatically become dynamic tile-cache obstacles. Opening or
destroying a door removes its obstacle; closing it restores the obstacle. Set
`H1EMU_DYNAMIC_DOOR_OBSTACLES=0` for an emergency rollback. For a deliberate
test without a sidecar, set it to `1`.

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
