# Regional hybrid navigation source

The regional hybrid source is a guarded experiment for locations where neither
available source is complete by itself. It is not an OBJ concatenation and it
is not a deployment artifact.

The ownership contract is deliberately asymmetric:

- Collision-first H1COL2 geometry owns terrain and every unmapped actor,
  including props, dynamic doors, static obstacles, and `nav_exclude` faces.
- One exact collision object can be replaced by one exact render object.
- The mapped render object contributes all its canonical faces and materials,
  including its static obstacles. This preserves walls that a slope check would
  make non-walkable even when the collision actor labels them
  `nav_floor_exterior`.
- Material changes inside a mapped actor emit `usemtl` without repeating `o`,
  preserving one exact OBJ object identity for downstream same-object semantic
  precedence and coplanar-floor protection.
- Both exact objects must occur once. Their portions selected by the policy
  build bounds must fit completely inside the same reviewed ownership bounds.
  The collision object is omitted and the render object is inserted, so the
  actor is never stacked with itself.
- Geometry is clipped to the regional build bounds in X/Z with interpolated
  height. Rectangle clipping remains available for evidence checks, not as a
  substitute for object identity.
- A reviewed structure replacement may additionally declare one contained
  `terrainOcclusionBounds` footprint. Only `nav_terrain` is clipped out of that
  exact footprint; roads, props, doors, and every other actor keep their normal
  ownership. This is intended for terrain proven to sit underneath an authored
  building, not as a generic overlap repair.

`compose_regional_nav_source.js` fails before leaving an output when:

- the collision source report does not match the requested regional bounds;
- the render manifest does not bind the exact overlay OBJ;
- the render lint report is not schema 3, strict, matching, and zero-error;
- the manifest and lint bounds differ or do not overlap the policy build bounds;
- ownership evidence bounds leave the regional bounds;
- terrain-occlusion bounds leave their owning evidence bounds, or the owner has
  no required structure surface;
- an exact base or overlay object is mapped more than once, missing, or extends
  outside its ownership evidence bounds;
- the mapped render object emits none of an explicitly required walkable
  semantic material.

## Ownership policy

The ownership bounds must contain the complete portion of each mapped object
selected by the policy build bounds. Extractors may include complete actors
that extend beyond their requested region; those out-of-region faces are not
part of this evidence gate. Ownership bounds are evidence envelopes, not
geometry partitions, so bounds for distinct exact actors may overlap. Exact
object names prevent a broad material or rectangle rule from deleting unrelated
actors, while duplicate mappings fail closed. The measured PoliceStation02
bounds in the current regional evidence are approximately X
`[-243.11439, -224.186086]` and Z `[-1166.95, -1133.545109]`. A policy has this
shape:

```json
{
  "schema": "h1emu-regional-hybrid-policy-v1",
  "coordinateSpace": "h1z1-world-y-up-meters",
  "bounds": {
    "minX": -255,
    "minZ": -1180,
    "maxX": -210,
    "maxZ": -1125
  },
  "ownership": [
    {
      "id": "pv-police-station-02-reviewed",
      "owner": "render-semantic-object",
      "bounds": {
        "minX": -243.2,
        "minZ": -1167,
        "maxX": -224.1,
        "maxZ": -1133.5
      },
      "objectReplacement": {
        "baseObject": "Common_Structures_PoliceStation02__instance_292492",
        "overlayObject": "Common_Structures_PoliceStation02__instance_3246446299"
      },
      "terrainOcclusionBounds": {
        "minX": -243.12,
        "minZ": -1166.96,
        "maxX": -224.18,
        "maxZ": -1133.54
      },
      "requiredMaterials": ["nav_floor_interior", "nav_stair", "nav_threshold"]
    }
  ]
}
```

The names and bounds above come from the current regional source evidence, but
they are not approved production ownership. Regenerated sources can change
instance identifiers. Only a policy that revalidates exact occurrence and
containment and then passes the factual regional topology gates should be
retained.

The render extraction bounds may be smaller than the build bounds because the
extractor emits complete intersecting actors. This is accepted only when the
manifest binds the exact OBJ, the strict zero-error lint report binds the same
extraction bounds, the evidence and build regions overlap, and every selected
mapped actor portion passes the ownership envelope. The output report records
both build and render-evidence bounds.

Exact replacement prevents cross-source duplication of the mapped actor. It
does not silently delete separate collision actors. Terrain also remains
collision-owned unless the policy contains the explicit, contained occlusion
footprint above. The source report records the number of affected source
triangles and removed projected area. Normal, topology-only, and island gates
remain mandatory because the footprint is evidence, not proof of connectivity.

## Compose a candidate

The reviewed Pleasant Valley ownership seam is frozen in
`data/2016/navigationHybridOwnership.pvPoliceRegional.json` for bounded A/B
work and `data/2016/navigationHybridOwnership.pvPoliceFull.json` for a
full-world collision-first source. Both policies replace the same exact actor
objects; only the base-source bounds differ.

`data/2016/navigationHybridOwnership.pvPoliceOverlay.json` keeps that same
ownership seam inside whole global tile columns plus at least one complete
halo column on every side. Use it when producing a bounded cache overlay: the
halo prevents the replacement columns from inheriting clipped geometry at
their tile borders and is discarded before promotion.

```powershell
npm run navmesh-regional-source-compose -- `
  --base-obj C:\temp\pv-collision-first.obj `
  --base-report C:\temp\pv-collision-first.obj.source.json `
  --overlay-obj C:\temp\render\world.obj `
  --overlay-manifest C:\temp\render\navigation_build_manifest.json `
  --overlay-lint C:\temp\render\navigation-lint.json `
  --policy C:\temp\pv-hybrid-policy.json `
  --output C:\temp\pv-hybrid.obj
```

The adjacent `pv-hybrid.obj.source.json` binds every input and the output by
SHA-256, records the ownership partition, and counts kept, replaced, and
discarded semantic triangles. It truthfully records `renderGeometryMerged` as
`true`; exact object replacement prevents duplication but still incorporates
render geometry. Bake it only into a staged regional bundle. Run normal and
topology-only regional gates before considering a wider policy.

This source report uses
`h1emu-regional-hybrid-nav-source-v1`. Full artifact provenance currently
accepts the standalone collision-first source contract only, so the hybrid
candidate cannot accidentally be promoted as a complete full-world artifact.
