// Parallel generator for the streaming navmesh tile store. Splits the map into
// 1km blocks, runs one worker process per core, then combines the per-block part
// files into a single indexed store: data/2016/collision/z1_navtiles.bin
//
//   header : magic "H1NAV1\0\0" (8), tileCount u32
//   index  : tileCount x [tx i32, tz i32, offset u32, len u32]
//   blobs  : concatenated tile bytes
const fs = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { ORIGIN } = require("./tilestore");

const ROOT = join(__dirname, "..", "..");
const OUT = join(ROOT, "data", "2016", "collision", "z1_navtiles.bin");
const PARTS_DIR = join(os.tmpdir(), "z1navparts");
const BLOCK = 1024; // 1km blocks
const HALF = 4096; // map extent
const CONC = Number(process.env.NAV_JOBS || Math.max(1, Math.min(48, os.cpus().length)));

function runWorker(bx1, bz1, bx2, bz2, out) {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ["--max-old-space-size=6000", join(__dirname, "gen_tilestore_worker.js"),
        bx1, bz1, bx2, bz2, out],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    p.on("exit", (code) => resolve(code));
  });
}

async function main() {
  fs.mkdirSync(PARTS_DIR, { recursive: true });
  const blocks = [];
  for (let bx = -HALF; bx < HALF; bx += BLOCK)
    for (let bz = -HALF; bz < HALF; bz += BLOCK)
      blocks.push([bx, bz, Math.min(HALF, bx + BLOCK), Math.min(HALF, bz + BLOCK)]);
  console.log(`${blocks.length} blocks, ${CONC} concurrent workers`);

  const t0 = Date.now();
  let parts = [];
  if (process.env.NAV_COMBINE_ONLY) {
    parts = fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith(".bin")).map((f) => join(PARTS_DIR, f));
    console.log(`combine-only: reusing ${parts.length} existing parts`);
  } else {
    let done = 0, idx = 0;
    async function worker() {
      while (idx < blocks.length) {
        const i = idx++;
        const [bx1, bz1, bx2, bz2] = blocks[i];
        const part = join(PARTS_DIR, `p_${bx1}_${bz1}.bin`);
        const code = await runWorker(bx1, bz1, bx2, bz2, part);
        if (code === 0 && fs.existsSync(part)) parts.push(part);
        done++;
        if (done % 8 === 0 || done === blocks.length)
          console.log(`  ${done}/${blocks.length} blocks (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, () => worker()));
  }

  // combine parts -> single indexed store
  console.log("combining parts...");
  const index = [];
  const blobs = [];
  let offset = 0;
  for (const part of parts) {
    const buf = fs.readFileSync(part);
    let off = 4;
    const n = buf.readUInt32LE(0);
    for (let i = 0; i < n; i++) {
      const tx = buf.readInt32LE(off), tz = buf.readInt32LE(off + 4),
        len = buf.readUInt32LE(off + 8);
      off += 12;
      const bytes = buf.subarray(off, off + len);
      off += len;
      index.push([tx, tz, offset, len]);
      blobs.push(bytes);
      offset += len;
    }
  }
  const header = Buffer.alloc(12);
  header.write("H1NAV1\0\0", 0, "latin1");
  header.writeUInt32LE(index.length, 8);
  const indexBuf = Buffer.alloc(index.length * 16);
  index.forEach(([tx, tz, o, l], i) => {
    indexBuf.writeInt32LE(tx, i * 16);
    indexBuf.writeInt32LE(tz, i * 16 + 4);
    indexBuf.writeUInt32LE(o, i * 16 + 8);
    indexBuf.writeUInt32LE(l, i * 16 + 12);
  });
  // stream the writes: the combined store can exceed writeFileSync's 2GB limit
  const ws = fs.createWriteStream(OUT);
  const write = (b) =>
    ws.write(b) ? Promise.resolve() : new Promise((res) => ws.once("drain", res));
  await write(header);
  await write(indexBuf);
  for (const b of blobs) await write(b);
  await new Promise((res) => ws.end(res));
  console.log(`wrote ${OUT}  (${index.length} tiles, ${(fs.statSync(OUT).size / 1e6).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  void ORIGIN;
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAIL:", e); process.exit(1); });
