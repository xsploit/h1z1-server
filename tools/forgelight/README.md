# Forgelight Z1 terrain and collision exporters

These tools extract two complementary parts of the H1Z1 map **Z1**:

- the native CNK0 terrain mesh into the server's `heightmap.png`; and
- **static structure geometry** (roads,
  sidewalks, building floors, foundations, bridges, wrecked props, …) from the
  game's Forgelight assets into a compact **`z1_collision.bin`**.

The Zone server (`CollisionManager`) loads that file, builds one BVH per unique
mesh + an XZ broadphase, and ray-casts downward to place NPC feet on the visible
surface — the man-made surfaces that the terrain heightmap alone cannot follow.
The terrain heightmap supplies the authoritative outdoor ground beneath those
structures.

> The mesh is **derived from your own copy of the game's assets** and is **not**
> shipped in this repository (`data/2016/collision/` is gitignored, like the
> heightmap). Each user regenerates it locally with the steps below.

## What it produces

`z1_collision.bin` — format `H1COL2`:

```
header     : magic "H1COL2\0\0" (8 bytes), version u32, meshCount u32, instCount u32
meshes     : meshCount × [ kind u8, vertCount u32, idxCount u32,
                           positions (vertCount*3 f32), indices (idxCount u32) ]
instances  : meshIndex (instCount u32)
             transforms (instCount × 16 f32: tx ty tz, qx qy qz qw, sx sy sz,
                         worldAABB min xyz, worldAABB max xyz)
```

Mesh kinds are `0` walkable, `1` solid obstacle, `2` thin non-walkable, and
`3` door. Ground raycasts only consider walkable meshes.

Typical Z1 output: ~980 unique meshes, ~306k instances, ~80 MB.

## Prerequisites

- A legitimate copy of **H1Z1** (the `Resources/Assets/Assets_*.pack` archives).
- **Python 3.12** and **git**.
- The structure exporter is pure Python. The terrain exporter additionally uses
  pydmod's native `cnk_loader` plus `numba` for exact triangle rasterization.

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
   pip install numpy scipy pygltflib Pillow aabbtree bitstruct numpy-stl numba
   pip install ./dbg-pack          # the pack1/pack2 reader (DbgPack)
   pip install ./cnk_loader        # native CNK0 decompressor for heightmap export
   ```

3. Copy the scripts from this folder into the pydmod checkout root (next to
   `zone_converter.py`), so they can import pydmod's modules:

   ```bash
   cp <h1z1-server>/tools/forgelight/export_z1_collision.py .
   cp <h1z1-server>/tools/forgelight/export_z1_instanced.py .
   cp <h1z1-server>/tools/forgelight/export_z1_heightmap.py .
   ```

## Export structure collision

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

## Export native terrain

```bash
export H1Z1_ASSETS="/path/to/H1Z1/Resources/Assets"
export HEIGHTMAP_OUT="<h1z1-server>/data/2016/zoneData/heightmap.png"

python export_z1_heightmap.py
```

The exporter reads the high-detail native triangle batches from every Z1 CNK0
chunk, selects the upper surface where the client contains duplicate XY
vertices, and rasterizes the actual triangles at one-metre resolution. It
refuses to write an output if those triangles do not cover the complete
8192×8192 map.

The PNG is derived client data and is gitignored. Each pixel uses the same
encoding as the server loader:

```text
height_meters = (red - 16) * 8 + green / 32
```

For a quick parser/topology check without writing the map:

```bash
python export_z1_heightmap.py --inspect-only
python export_z1_heightmap.py --validate-topology-only
```

## Environment variables

| var             | meaning                                                   | default                    |
| --------------- | --------------------------------------------------------- | -------------------------- |
| `H1Z1_ASSETS`   | directory holding `Assets_*.pack`                         | `D:/h1z1/Resources/Assets` |
| `Z1_ZONE`       | optional pre-extracted `Z1.zone` (else pulled from packs) | —                          |
| `COLLISION_OUT` | output `.bin` path                                        | `./z1_collision.bin`       |
| `HEIGHTMAP_OUT` | output terrain PNG                                        | `./heightmap.png`          |

## Notes / caveats

- Only **LOD0** structure geometry is exported.
- pydmod's material database is PS2-derived; a handful of H1Z1 materials are
  unknown, so the exporter falls back to a position-only layout (`ModelRigid`) —
  fine here because collision needs vertex **positions** only.
- Instance transforms reuse pydmod's proven georeferencing; world coordinates
  line up with the server's space (x, y = height, z, within ±4096).
