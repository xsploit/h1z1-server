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
  --source-report data\2016\navigation-source-report.json `
  --classifier-config C:\path\to\config.yml `
  --semantic-report C:\path\to\navigation-semantics.json `
  --extractor-commit <sha> `
  --recast-commit <sha> `
  --recast-navigation-commit <sha>
npm run navmesh-artifact-check -- --bundle-root data/2016
```

When comparing a reconstructed cache with a preserved runtime, compare their
logical contents as well as their serialized files:

```powershell
npm run navmesh-cache-identity -- C:\preserved\collision C:\rebuilt\collision
```

The logical identity sorts layers by stable `(tx,ty,tlayer)`, hashes each
compressed payload, and deliberately excludes serialized tile references,
record order, and part boundaries. The command reports separate header,
logical-payload, and complete canonical hashes, along with every missing,
extra, or payload-mismatched layer. A mismatch exits with status 2. Passing one
cache directory prints its identity without comparing it. The ordered physical
part hashes and raw concatenated hash remain in the report so byte-exact
reproduction can be distinguished from logically identical reserialization.

New builds must use `provenance.status=complete`. Complete provenance requires
all three tool commits, source/classifier hashes, navigation metadata, and a
valid `h1emu-collision-semantic-obj-v1` source report whose input hashes match
the runtime collision and heightmap, whose output name and hash match the
manifested source OBJ, and whose collision metadata sidecar is marked matched,
plus a strict `h1emu-nav-semantics-v1` bake report with zero fallback triangles,
ordinary materials, or warnings. The source report must be staged inside the
bundle so its bytes, source strategy, bounds, render-merge policy, sidecar match
state, output identity, and known limitations are all bound by the manifest. A
pre-contract rollback can be recorded honestly as
`runtime-only`; it still receives full runtime hashes but does not pretend that
its original `world.obj` or tool commits are known.

### Composed full-cache provenance

A verified regional cache may overlay a verified full cache without falsely
claiming that the result came from one source OBJ. Create the base input with
`--cache-coverage full` and the regional input with both
`--cache-coverage regional` and
`--cache-bounds minX,minZ,maxX,maxZ`. Both input manifests must already have
complete direct provenance and must be staged inside the final bundle.
The manifest creator verifies them against their original cache directories,
then copies their exact bytes and the exact merge report into the final
bundle's `provenance` directory.

The merge tool must emit `h1emu-navigation-cache-merge-v1` JSON with its name,
version, Git commit, `regional-overlay` mode, the artifact ID, manifest SHA-256,
and ordered cache records for each input, plus the exact output cache,
collision, heightmap, navigation metadata, semantic report, and transition
records. Create the final manifest with:

```powershell
npm run navmesh-artifact-create -- --bundle-root C:\staging\data\2016 `
  --cache-coverage full `
  --base-artifact-manifest C:\base\data\2016\navigation-artifact-manifest.json `
  --base-cache-dir C:\base\data\2016\collision `
  --regional-artifact-manifest C:\regional\data\2016\navigation-artifact-manifest.json `
  --regional-cache-dir C:\regional\data\2016\collision `
  --cache-merge-report C:\merge-output\cache-merge-report.json
npm run navmesh-artifact-check -- --bundle-root C:\staging\data\2016
```

Composition verification fails closed unless the base coverage is full, the
overlay coverage is regional, the result coverage is full, both staged input
manifests exactly match their embedded snapshots and hashes, every input and
output cache record matches the merge report, and collision, heightmap,
navigation metadata, and transitions describe the same runtime revision in
the base, regional, and output artifacts. Nested compositions are rejected so
the proof remains bounded and auditable. A `runtime-only` input cannot promote
the result to complete provenance.

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

`data/2016/navigationTransitions.authored.json` contains the five manually
reviewed Pleasant Valley police links. Model-local templates emit transformed
per-placement links during preparation. The deterministic compiler merges
those two sources into the runtime/full-bake input
`data/2016/navigationTransitions.json` and records its input/output hashes in
`data/2016/navigationTransitions.provenance.json`.

For the House36B checkpoint the compiled artifact contains 69 links: five
authored PV links plus eight reviewed seams at each of eight exact House36B
placements. Rebuild it after model preparation with:

```powershell
py -3 tools/forgelight/compile_navigation_transitions.py `
  --authored data/2016/navigationTransitions.authored.json `
  --generated "house36B=C:\path\to\house36b-prepared\transitions.json" `
  --output data/2016/navigationTransitions.json `
  --provenance data/2016/navigationTransitions.provenance.json
```

Compilation is deterministic and idempotent. Exact repeated entries collapse;
conflicting links at the same endpoints fail instead of silently appending.
Generator-only `actorFile` and `instanceIndex` fields are recorded by
provenance but stripped from the compiled artifact. Ordering uses the runtime
link geometry itself, so recompiling an already stripped artifact is stable
even when source instance indices cross a digit boundary. The same canonical
JSON is accepted by both the TypeScript runtime and the strict C++ baker parser.
Door thresholds are not linked blindly: an off-mesh link across every door
would let NPCs bypass a closed door. Add a transition only after the matching
validator proves that ordinary navmesh connectivity cannot represent the
stair or threshold.

Useful focused checks:

```powershell
npx tsx scripts/validatePvPoliceFrontSteps.ts
npx tsx scripts/validatePvPoliceEntrance.ts
npx tsx scripts/validatePvPoliceBasement.ts
npx tsx scripts/validateStreamingDoorways.ts
```
