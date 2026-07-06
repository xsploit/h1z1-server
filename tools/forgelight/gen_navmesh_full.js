// Assemble ONE master tiled navmesh region-by-region: each region builds only
// its local geometry (bounded WASM memory) and its tiles are addTile'd into a
// shared master navmesh aligned to a GLOBAL tile grid. This is the foundation
// for whole-map generation + parallelism (regions are independent).
//
// Validation mode: node gen_navmesh_full.js  -> builds a 400x400 area as 4
// regions and checks connectivity across the region boundaries.
const { buildRegionGeometry, NAV_CONFIG } = require("./gen_navmesh");

async function buildMaster(x1, z1, x2, z2, regionSize) {
  const recast = require("recast-navigation");
  const {
    init, NavMesh, NavMeshParams, RecastChunkyTriMesh, VerticesArray,
    TrianglesArray, Raw
  } = recast;
  const gen = require("recast-navigation/generators");
  const { buildTiledNavMeshRcConfig, generateTileNavMeshData } = gen;
  await init();

  // a generous Y range for the whole area (heightmap ~ -30..414 across map)
  const bounds = [[x1, -100, z1], [x2, 600, z2]];
  const { config: rcConfig, tcs, orig, maxTiles, maxPolysPerTile } =
    buildTiledNavMeshRcConfig({ recastConfig: NAV_CONFIG, navMeshBounds: bounds });
  console.log(`tcs=${tcs.toFixed(2)}m maxTiles=${maxTiles} maxPolys/tile=${maxPolysPerTile}`);

  const master = new NavMesh();
  const params = NavMeshParams.create({
    orig,
    tileWidth: NAV_CONFIG.tileSize * NAV_CONFIG.cs,
    tileHeight: NAV_CONFIG.tileSize * NAV_CONFIG.cs,
    maxTiles,
    maxPolys: maxPolysPerTile
  });
  if (!master.initTiled(params)) throw new Error("initTiled failed");
  const FREE = Raw.Detour.TILE_FREE_DATA;

  const gtile = (v) => Math.floor((v - 0) / tcs); // global tile index from world-orig-relative
  const ox = orig.x ?? orig[0], oz = orig.z ?? orig[2];

  let added = 0, tilesTried = 0;
  for (let rx = x1; rx < x2; rx += regionSize) {
    for (let rz = z1; rz < z2; rz += regionSize) {
      const rx2 = Math.min(x2, rx + regionSize), rz2 = Math.min(z2, rz + regionSize);
      // geometry with a margin so edge tiles see neighbour geometry
      const M = tcs + NAV_CONFIG.cs * (rcConfig.borderSize + 2);
      const geo = await buildRegionGeometry(rx - M, rz - M, rx2 + M, rz2 + M);
      const va = new VerticesArray(); va.copy(geo.positions);
      const ta = new TrianglesArray(); ta.copy(geo.indices);
      const chunky = new RecastChunkyTriMesh();
      chunky.init(va, ta, geo.indices.length / 3, 256);

      const tx0 = Math.floor((rx - ox) / tcs), tx1 = Math.floor((rx2 - ox - 1e-3) / tcs);
      const tz0 = Math.floor((rz - oz) / tcs), tz1 = Math.floor((rz2 - oz - 1e-3) / tcs);
      for (let tx = tx0; tx <= tx1; tx++) {
        for (let tz = tz0; tz <= tz1; tz++) {
          const bmin = [ox + tx * tcs, bounds[0][1], oz + tz * tcs];
          const bmax = [ox + (tx + 1) * tcs, bounds[1][1], oz + (tz + 1) * tcs];
          tilesTried++;
          const res = generateTileNavMeshData(va, ta, rcConfig, chunky,
            { x: tx, y: tz, bmin, bmax }, { buildBvTree: true });
          if (res.success && res.data) {
            master.removeTile(master.getTileRefAt(tx, tz, 0));
            master.addTile(res.data, FREE, 0);
            added++;
          }
        }
      }
      va.destroy(); ta.destroy();
    }
  }
  console.log(`tiles added ${added}/${tilesTried}`);
  return master;
}

async function main() {
  const { NavMeshQuery } = require("recast-navigation");
  const master = await buildMaster(-2100, -2300, -1700, -1900, 200);
  const q = new NavMeshQuery(master);
  // connectivity across region seams: sample random points, measure reachability
  const targets = [];
  for (let i = 0; i < 100; i++) { const r = q.findRandomPoint(); if (r.success) targets.push(r.randomPoint); }
  let sum = 0, n = 0;
  for (let s = 0; s < 10; s++) {
    const r = q.findRandomPoint(); if (!r.success) continue;
    let reach = 0;
    for (const t of targets) {
      const p = q.computePath(r.randomPoint, t, { halfExtents: { x: 3, y: 10, z: 3 } });
      if (p.success && p.path && p.path.length) { const l = p.path[p.path.length - 1]; if (Math.hypot(l.x - t.x, l.z - t.z) < 2) reach++; }
    }
    sum += reach / targets.length; n++;
  }
  console.log(`MASTER baseline reachability: ${((sum / n) * 100).toFixed(0)}% (${targets.length} targets) -> seams ${sum / n > 0.5 ? "CONNECT ✓" : "broken ✗"}`);
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
module.exports = { buildMaster };
