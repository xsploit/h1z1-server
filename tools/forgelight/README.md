# Forgelight Z1 collision exporter

Extracts the **static structure geometry** of the H1Z1 map **Z1** (roads,
sidewalks, building floors, foundations, bridges, wrecked props, …) from the
game's Forgelight assets and bakes it into a compact **`z1_collision.bin`**.

The Zone server (`CollisionManager`) loads that file, builds one BVH per unique
mesh + an XZ broadphase, and ray-casts downward to place NPC feet on the visible
surface — the man-made surfaces that the terrain heightmap alone cannot follow.

> The mesh is **derived from your own copy of the game's assets** and is **not**
> shipped in this repository (`data/2016/collision/` is gitignored, like the
> heightmap). Each user regenerates it locally with the steps below.

## What it produces

`z1_collision.bin` — format `H1COL1`:

```
header     : magic "H1COL1\0\0" (8 bytes), version u32, meshCount u32, instCount u32
meshes     : meshCount × [ vertCount u32, idxCount u32,
                           positions (vertCount*3 f32), indices (idxCount u32) ]
instances  : meshIndex (instCount u32)
             transforms (instCount × 16 f32: tx ty tz, qx qy qz qw, sx sy sz,
                         worldAABB min xyz, worldAABB max xyz)
```

Typical Z1 output: ~980 unique meshes, ~306k instances, ~80 MB.

## Prerequisites

- A legitimate copy of **H1Z1** (the `Resources/Assets/Assets_*.pack` archives).
- **Python 3.12** and **git**.
- These tools only need **structure** geometry, so the C++ `cnk_loader` (terrain)
  is **not** required — the server uses the existing terrain heightmap and only
  needs the structures from here.

## Setup

1. Clone [`ryanjsims/pydmod`](https://github.com/ryanjsims/pydmod) and its
   submodules (it provides the `.zone` / `.dme` / pack readers this builds on):

   ```bash
   git clone https://github.com/ryanjsims/pydmod
   cd pydmod
   git submodule update --init
   ```

2. Create a virtualenv and install the **pure-Python** dependencies (skip the
   GUI / terrain extras in pydmod's `requirements.txt`):

   ```bash
   python -m venv venv
   # Windows: venv\Scripts\activate   |   Linux/macOS: . venv/bin/activate
   pip install numpy scipy pygltflib Pillow aabbtree bitstruct numpy-stl
   pip install ./dbg-pack          # the pack1/pack2 reader (DbgPack)
   ```

3. Copy the two scripts from this folder into the pydmod checkout root (next to
   `zone_converter.py`), so they can import pydmod's modules:

   ```bash
   cp <h1z1-server>/tools/forgelight/export_z1_collision.py .
   cp <h1z1-server>/tools/forgelight/export_z1_instanced.py .
   ```

## Run

```bash
# point at your H1Z1 assets and where the .bin should land
export H1Z1_ASSETS="/path/to/H1Z1/Resources/Assets"        # Windows: set H1Z1_ASSETS=...
export COLLISION_OUT="<h1z1-server>/data/2016/collision/z1_collision.bin"

python export_z1_instanced.py
```

`Z1.zone` is read straight from the packs (no manual extraction needed). The
script prints a coverage + a flat-surface sanity check (road/sidewalk/floor AABB
height span should be small, confirming correct orientation).

If `COLLISION_OUT` was left at its default, copy the resulting `z1_collision.bin`
into `data/2016/collision/` of this repo. On the next server boot you should see:

```
[Collision] loaded 980 meshes, 305951 instances
```

If the file is absent the server logs `structure collision disabled` and falls
back to the heightmap — nothing breaks.

### Optional: visual check

`python export_z1_collision.py` exports a small GLB of one town
(`z1_actors_town.glb`) you can open in any glTF viewer to eyeball the geometry.

## Environment variables

| var | meaning | default |
|-----|---------|---------|
| `H1Z1_ASSETS` | directory holding `Assets_*.pack` | `D:/h1z1/Resources/Assets` |
| `Z1_ZONE` | optional pre-extracted `Z1.zone` (else pulled from packs) | — |
| `COLLISION_OUT` | output `.bin` path | `./z1_collision.bin` |

## Notes / caveats

- Only **LOD0** structure geometry is exported; terrain comes from the heightmap.
- pydmod's material database is PS2-derived; a handful of H1Z1 materials are
  unknown, so the exporter falls back to a position-only layout (`ModelRigid`) —
  fine here because collision needs vertex **positions** only.
- Instance transforms reuse pydmod's proven georeferencing; world coordinates
  line up with the server's space (x, y = height, z, within ±4096).
