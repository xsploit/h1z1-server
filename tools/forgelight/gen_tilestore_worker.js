// Worker: generate all fine navmesh tiles overlapping one block and write them
// to a part file. Invoked by gen_tilestore.js (one child process per block).
// args: bx1 bz1 bx2 bz2 outPartFile
const fs = require("node:fs");
const recast = require("recast-navigation");
const gen = require("recast-navigation/generators");
const {
  NAV_CONFIG,
  buildRegionGeometry,
  ORIGIN,
  Y_MAX,
  TCS,
  tileX,
  tileZ,
  tileBounds
} = require("./tilestore");

async function main() {
  const bx1 = Number(process.argv[2]),
    bz1 = Number(process.argv[3]),
    bx2 = Number(process.argv[4]),
    bz2 = Number(process.argv[5]),
    out = process.argv[6];
  await recast.init();
  const { config: rcConfig } = gen.buildTiledNavMeshRcConfig({
    recastConfig: NAV_CONFIG,
    navMeshBounds: [ORIGIN, [-ORIGIN[0], Y_MAX, -ORIGIN[2]]]
  });

  // geometry for the block + a margin so edge tiles see neighbour geometry
  const margin = TCS + NAV_CONFIG.cs * (rcConfig.borderSize + 2);
  const geo = await buildRegionGeometry(bx1 - margin, bz1 - margin, bx2 + margin, bz2 + margin);
  if (geo.indices.length === 0) {
    fs.writeFileSync(out, Buffer.alloc(4)); // 0 tiles
    return;
  }
  const va = new recast.VerticesArray();
  va.copy(geo.positions);
  const ta = new recast.TrianglesArray();
  ta.copy(geo.indices);
  const chunky = new recast.RecastChunkyTriMesh();
  chunky.init(va, ta, geo.indices.length / 3, 256);

  const tx0 = tileX(bx1), tx1 = tileX(bx2 - 1e-3);
  const tz0 = tileZ(bz1), tz1 = tileZ(bz2 - 1e-3);
  const blobs = [];
  let nTiles = 0;
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let tz = tz0; tz <= tz1; tz++) {
      const { bmin, bmax } = tileBounds(tx, tz);
      const res = gen.generateTileNavMeshData(va, ta, rcConfig, chunky,
        { x: tx, y: tz, bmin, bmax }, { buildBvTree: true });
      if (res.success && res.data) {
        const bytes = Buffer.from(res.data.toTypedArray());
        const hdr = Buffer.alloc(12);
        hdr.writeInt32LE(tx, 0);
        hdr.writeInt32LE(tz, 4);
        hdr.writeUInt32LE(bytes.length, 8);
        blobs.push(hdr, bytes);
        nTiles++;
      }
    }
  }
  va.destroy();
  ta.destroy();
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32LE(nTiles, 0);
  fs.writeFileSync(out, Buffer.concat([cnt, ...blobs]));
  console.log(`block[${bx1},${bz1}..${bx2},${bz2}] ${nTiles} tiles -> ${out}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("WORKER FAIL:", e.message);
  process.exit(1);
});
