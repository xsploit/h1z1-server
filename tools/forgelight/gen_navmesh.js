// Generate a recast navmesh for a region from the EXTRACTED world geometry:
// terrain (heightmap grid) + structures (z1_collision.bin instances, baked to
// world triangles). recast decides walkability by slope, so walls become
// non-walkable (NPCs route around) and doorways stay connected (NPCs enter).
//
// Run directly: node gen_navmesh.js [x1 z1 x2 z2]  -> generates + renders preview
// Or require:   const { generateRegion } = require('./gen_navmesh')
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { loadImage, createCanvas } = require("@napi-rs/canvas");
const { Matrix4, Vector3, Quaternion } = require("three");

const ROOT = join(__dirname, "..", "..");
const HEIGHTMAP = join(ROOT, "data", "2016", "zoneData", "heightmap.png");
const BIN = join(ROOT, "data", "2016", "collision", "z1_collision.bin");
const TERRAIN_STEP = process.env.NAV_TSTEP
  ? Number(process.env.NAV_TSTEP)
  : 1.0;

async function loadHeightmap(path = HEIGHTMAP) {
  const img = await loadImage(path);
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const hm = ctx.getImageData(0, 0, img.width, img.height).data;
  const W = img.width,
    H = img.height;
  return (x, z) => {
    const cx = Math.min(W - 1, Math.max(0, Math.floor(z + 4096)));
    const cy = Math.min(H - 1, Math.max(0, Math.floor(4096 - x)));
    const i = (cy * W + cx) * 4;
    return (hm[i] - 16) * 8 + hm[i + 1] / 32;
  };
}

function readBin(path = BIN) {
  const buf = readFileSync(path);
  if (
    buf.length < 20 ||
    !buf.subarray(0, 8).equals(Buffer.from("H1COL2\0\0", "latin1"))
  )
    throw new Error("bad bin magic");
  let off = 8;
  const version = buf.readUInt32LE(off);
  off += 4;
  if (version !== 2) throw new Error(`unsupported H1COL2 version ${version}`);
  const meshCount = buf.readUInt32LE(off);
  off += 4;
  const instCount = buf.readUInt32LE(off);
  off += 4;
  const meshes = [];
  const requireBytes = (count, label) => {
    if (!Number.isSafeInteger(count) || count < 0 || off + count > buf.length)
      throw new Error(`truncated H1COL2 ${label}`);
  };
  for (let m = 0; m < meshCount; m++) {
    requireBytes(9, `mesh ${m} header`);
    const kind = buf.readUInt8(off);
    off += 1;
    const vc = buf.readUInt32LE(off);
    off += 4;
    const ic = buf.readUInt32LE(off);
    off += 4;
    requireBytes(vc * 12 + ic * 4, `mesh ${m} geometry`);
    const pos = new Float32Array(
      buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + vc * 12)
    );
    off += vc * 12;
    const idx = new Uint32Array(
      buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + ic * 4)
    );
    off += ic * 4;
    meshes.push({ pos, idx, kind });
  }
  requireBytes(instCount * 4 + instCount * 16 * 4, "instance tables");
  const instMesh = new Uint32Array(
    buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + instCount * 4)
  );
  off += instCount * 4;
  const instData = new Float32Array(
    buf.buffer.slice(
      buf.byteOffset + off,
      buf.byteOffset + off + instCount * 16 * 4
    )
  );
  off += instCount * 16 * 4;
  if (off !== buf.length)
    throw new Error(`unexpected ${buf.length - off} trailing H1COL2 bytes`);
  return { version, meshes, instMesh, instData, instCount };
}

// Build terrain+structure triangle soup for the region.
async function buildRegionGeometry(x1, z1, x2, z2) {
  const getHeight = await loadHeightmap();
  const positions = [];
  const indices = [];

  const nx = Math.ceil((x2 - x1) / TERRAIN_STEP) + 1;
  const nz = Math.ceil((z2 - z1) / TERRAIN_STEP) + 1;
  for (let ix = 0; ix < nx; ix++)
    for (let iz = 0; iz < nz; iz++) {
      const x = x1 + ix * TERRAIN_STEP,
        z = z1 + iz * TERRAIN_STEP;
      positions.push(x, getHeight(x, z), z);
    }
  for (let ix = 0; ix < nx - 1; ix++)
    for (let iz = 0; iz < nz - 1; iz++) {
      const a = ix * nz + iz,
        b = (ix + 1) * nz + iz,
        c = (ix + 1) * nz + iz + 1,
        d = ix * nz + iz + 1;
      // wind CCW-from-above so the surface normal points UP (else recast treats
      // the terrain as a ceiling -> non-walkable -> empty/fragmented navmesh)
      indices.push(a, c, b, a, d, c);
    }

  const { meshes, instMesh, instData, instCount } = readBin();
  if (process.env.NAV_NOSTRUCT === "1") {
    return {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      instData,
      instCount,
      getHeight,
      bakedInst: 0
    };
  }
  const inRegion = (mnx, mnz, mxx, mxz) =>
    !(mxx < x1 || mnx > x2 || mxz < z1 || mnz > z2);
  const mat = new Matrix4(),
    t = new Vector3(),
    q = new Quaternion(),
    s = new Vector3(),
    v = new Vector3();
  // small free props / furniture (cabinets, chairs...) are kind-0 and would
  // bake as little bumps that fragment indoor floors and block the path to the
  // doorway; skip them so interiors stay one clean walkable surface
  const MIN_STRUCT = num(process.env.NAV_MIN_STRUCT, 2.5);
  let bakedInst = 0;
  for (let i = 0; i < instCount; i++) {
    const b = i * 16;
    if (
      !inRegion(
        instData[b + 10],
        instData[b + 12],
        instData[b + 13],
        instData[b + 15]
      )
    )
      continue;
    const mesh = meshes[instMesh[i]];
    if (mesh.kind === 3) continue; // doors: leave the opening passable
    if (mesh.kind === 0) {
      const wsx = instData[b + 13] - instData[b + 10],
        wsz = instData[b + 15] - instData[b + 12];
      if (Math.max(wsx, wsz) < MIN_STRUCT) continue; // furniture/clutter
    }
    bakedInst++;
    t.set(instData[b], instData[b + 1], instData[b + 2]);
    q.set(instData[b + 3], instData[b + 4], instData[b + 5], instData[b + 6]);
    s.set(instData[b + 7], instData[b + 8], instData[b + 9]);
    mat.compose(t, q, s);
    const vbase = positions.length / 3;
    for (let p = 0; p < mesh.pos.length; p += 3) {
      v.set(mesh.pos[p], mesh.pos[p + 1], mesh.pos[p + 2]).applyMatrix4(mat);
      positions.push(v.x, v.y, v.z);
    }
    for (let k = 0; k < mesh.idx.length; k++) indices.push(vbase + mesh.idx[k]);
  }
  // drop degenerate triangles (non-finite or near-zero area / coincident verts)
  // — a single bad tri can abort the whole tile build in recast
  const cleanIdx = [];
  const ax = new Vector3(),
    bx = new Vector3(),
    cx = new Vector3(),
    e1 = new Vector3(),
    e2 = new Vector3();
  let dropped = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const i0 = indices[k] * 3,
      i1 = indices[k + 1] * 3,
      i2 = indices[k + 2] * 3;
    ax.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    bx.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    cx.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    if (
      !isFinite(ax.x + ax.y + ax.z + bx.x + bx.y + bx.z + cx.x + cx.y + cx.z)
    ) {
      dropped++;
      continue;
    }
    e1.subVectors(bx, ax);
    e2.subVectors(cx, ax);
    if (e1.cross(e2).length() < 1e-6) {
      dropped++;
      continue;
    }
    cleanIdx.push(indices[k], indices[k + 1], indices[k + 2]);
  }
  if (dropped) console.log(`dropped ${dropped} degenerate triangles`);

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(cleanIdx),
    instData,
    instCount,
    getHeight,
    bakedInst
  };
}

const num = (v, d) => (v !== undefined ? Number(v) : d);
const NAV_CONFIG = {
  borderSize: num(process.env.NAV_BORDER, 4),
  tileSize: num(process.env.NAV_TILESIZE, 64),
  cs: num(process.env.NAV_CS, 0.2),
  ch: num(process.env.NAV_CH, 0.2),
  walkableSlopeAngle: num(process.env.NAV_SLOPE, 50),
  walkableHeight: 2,
  walkableClimb: num(process.env.NAV_CLIMB, 0.9),
  walkableRadius: num(process.env.NAV_RADIUS, 0.3),
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 4,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  expectedLayersPerTile: 4,
  maxObstacles: 128
};

async function generateRegion(x1, z1, x2, z2) {
  const geo = await buildRegionGeometry(x1, z1, x2, z2);
  console.log(
    `region x[${x1},${x2}] z[${z1},${z2}]: ${geo.bakedInst} structures, ${geo.positions.length / 3} verts, ${geo.indices.length / 3} tris`
  );
  const { init } = require("recast-navigation");
  const {
    generateTileCache,
    generateSoloNavMesh,
    generateTiledNavMesh
  } = require("recast-navigation/generators");
  await init();
  const tStart = Date.now();
  const mode =
    process.env.NAV_SOLO === "1"
      ? "solo"
      : process.env.NAV_TILED === "1"
        ? "tiled"
        : "tilecache";
  const result =
    mode === "solo"
      ? generateSoloNavMesh(geo.positions, geo.indices, NAV_CONFIG)
      : mode === "tiled"
        ? generateTiledNavMesh(geo.positions, geo.indices, NAV_CONFIG)
        : generateTileCache(geo.positions, geo.indices, NAV_CONFIG);
  console.log(`(${mode} generator)`);
  console.log(
    `generate ${((Date.now() - tStart) / 1000).toFixed(1)}s success=${result.success}` +
      (result.success ? "" : ` error=${result.error}`)
  );
  return { result, geo, region: [x1, z1, x2, z2] };
}

async function main() {
  const [x1 = -1980, z1 = -2200, x2 = -1880, z2 = -2100] = process.argv
    .slice(2)
    .map(Number);
  const { result, geo } = await generateRegion(x1, z1, x2, z2);
  if (!result.success) process.exit(1);

  const { getNavMeshPositionsAndIndices } = require("recast-navigation");
  const [npos, nidx] = getNavMeshPositionsAndIndices(result.navMesh);
  console.log(
    `navmesh walkable: ${npos.length / 3} verts, ${nidx.length / 3} polys`
  );

  const S = 1000;
  const out = createCanvas(S, S);
  const o = out.getContext("2d");
  o.fillStyle = "#101418";
  o.fillRect(0, 0, S, S);
  const px = (x, z) => [((z - z1) / (z2 - z1)) * S, ((x - x1) / (x2 - x1)) * S];
  o.fillStyle = "rgba(80,200,120,0.85)";
  for (let k = 0; k < nidx.length; k += 3) {
    o.beginPath();
    for (let j = 0; j < 3; j++) {
      const vi = nidx[k + j] * 3;
      const [ix, iy] = px(npos[vi], npos[vi + 2]);
      j === 0 ? o.moveTo(ix, iy) : o.lineTo(ix, iy);
    }
    o.closePath();
    o.fill();
  }
  o.strokeStyle = "rgba(230,80,80,0.9)";
  for (let i = 0; i < geo.instCount; i++) {
    const b = i * 16;
    const mnx = geo.instData[b + 10],
      mnz = geo.instData[b + 12],
      mxx = geo.instData[b + 13],
      mxz = geo.instData[b + 15];
    if (mxx < x1 || mnx > x2 || mxz < z1 || mnz > z2) continue;
    if (geo.instData[b + 14] - geo.instData[b + 11] < 1.2) continue;
    const [ax, ay] = px(mnx, mnz),
      [bx, by] = px(mxx, mxz);
    o.strokeRect(
      Math.min(ax, bx),
      Math.min(ay, by),
      Math.abs(bx - ax),
      Math.abs(by - ay)
    );
  }
  const pngPath = join(ROOT, "navmesh_preview.png");
  writeFileSync(pngPath, out.toBuffer("image/png"));
  console.log(`wrote ${pngPath}`);
}

module.exports = {
  generateRegion,
  buildRegionGeometry,
  loadHeightmap,
  readBin,
  NAV_CONFIG
};

if (require.main === module)
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("FAIL:", e);
      process.exit(1);
    });
