// Validate the streaming navmesh: load the tile store, stream a window around a
// moving player, and check tiles load/unload (bounded) + buildings queryable.
const fs = require("node:fs");
const { join } = require("node:path");
const r = require("recast-navigation");
const {
  ORIGIN, TCS, RUNTIME_MAX_TILES, RUNTIME_MAX_POLYS, tileX, tileZ
} = require("./tilestore");

const STORE = join(__dirname, "..", "..", "data", "2016", "collision", "z1_navtiles.bin");
const RADIUS = 300; // stream radius (m)

class Streamer {
  constructor() {
    this.index = new Map(); // "tx,tz" -> {offset,len}
    this.loaded = new Map(); // "tx,tz" -> tileRef
  }
  load() {
    // read only the header + index; tile bytes are read on demand by offset
    this.fd = fs.openSync(STORE, "r");
    const head = Buffer.alloc(12);
    fs.readSync(this.fd, head, 0, 12, 0);
    if (head.subarray(0, 6).toString("latin1") !== "H1NAV1") throw new Error("bad store magic");
    const n = head.readUInt32LE(8);
    const indexBuf = Buffer.alloc(n * 16);
    fs.readSync(this.fd, indexBuf, 0, n * 16, 12);
    this.dataStart = 12 + n * 16;
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      this.index.set(`${indexBuf.readInt32LE(o)},${indexBuf.readInt32LE(o + 4)}`,
        { offset: indexBuf.readUInt32LE(o + 8), len: indexBuf.readUInt32LE(o + 12) });
    }
    this.navMesh = new r.NavMesh();
    this.navMesh.initTiled(r.NavMeshParams.create({
      orig: { x: ORIGIN[0], y: ORIGIN[1], z: ORIGIN[2] },
      tileWidth: TCS, tileHeight: TCS, maxTiles: RUNTIME_MAX_TILES, maxPolys: RUNTIME_MAX_POLYS
    }));
    console.log(`store: ${n} tiles indexed`);
  }
  stream(positions) {
    const rad = Math.ceil(RADIUS / TCS);
    const want = new Set();
    for (const [px, pz] of positions) {
      const cx = tileX(px), cz = tileZ(pz);
      for (let dx = -rad; dx <= rad; dx++)
        for (let dz = -rad; dz <= rad; dz++) {
          const k = `${cx + dx},${cz + dz}`;
          if (this.index.has(k)) want.add(k);
        }
    }
    let added = 0, removed = 0;
    for (const [k, ref] of this.loaded)
      if (!want.has(k)) { this.navMesh.removeTile(ref); this.loaded.delete(k); removed++; }
    for (const k of want) {
      if (this.loaded.has(k)) continue;
      const { offset, len } = this.index.get(k);
      const bytes = Buffer.alloc(len);
      fs.readSync(this.fd, bytes, 0, len, this.dataStart + offset);
      const arr = new r.UnsignedCharArray(); arr.copy(bytes);
      const add = this.navMesh.addTile(arr, r.Raw.Detour.TILE_FREE_DATA, 0);
      if (add.status & 0x40000000) { this.loaded.set(k, add.tileRef); added++; }
    }
    return { added, removed, loaded: this.loaded.size };
  }
}

(async () => {
  await r.init();
  const s = new Streamer();
  s.load();
  const q = new r.NavMeshQuery(s.navMesh);
  const HE = { halfExtents: { x: 5, y: 30, z: 5 } };

  // player in the residential town
  console.log("\nplayer @ (-1924,-2149):", s.stream([[-1924, -2149]]));
  const interior = q.findNearestPoly({ x: -1924, y: 62.6, z: -2149 }, HE);
  console.log("  building interior on navmesh:", !!interior.nearestRef, interior.nearestRef ? `y=${interior.nearestPoint.y.toFixed(1)}` : "");

  // move the player 800m away -> window should shift (unload old, load new)
  console.log("player moves to (-1100,-1900):", s.stream([[-1100, -1900]]));
  console.log("player moves to (1500,2000):", s.stream([[1500, 2000]]));
  console.log("back to town (-1924,-2149):", s.stream([[-1924, -2149]]));
  const interior2 = q.findNearestPoly({ x: -1924, y: 62.6, z: -2149 }, HE);
  console.log("  building interior queryable again:", !!interior2.nearestRef);
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
