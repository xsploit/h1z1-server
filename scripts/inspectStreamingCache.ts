import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error("Usage: npx tsx scripts/inspectStreamingCache.ts <cache-dir>");
  process.exit(1);
}

const dir = resolve(cacheDir);
const parts = readdirSync(dir)
  .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
  .sort((a, b) => {
    const aPart = Number(a.match(/(\d+)\.bin$/)?.[1]);
    const bPart = Number(b.match(/(\d+)\.bin$/)?.[1]);
    return aPart - bPart;
  });
if (!parts.length) throw new Error("no z1_cache_*.bin parts found");

const buffer = Buffer.concat(
  parts.map((name) => readFileSync(`${dir}/${name}`))
);
const TSET =
  ("T".charCodeAt(0) << 24) |
  ("S".charCodeAt(0) << 16) |
  ("E".charCodeAt(0) << 8) |
  "T".charCodeAt(0);
if (buffer.readInt32LE(0) !== TSET) throw new Error("bad TSET magic");

const version = buffer.readInt32LE(4);
const numTiles = buffer.readInt32LE(8);
if (version !== 1 || numTiles <= 0) {
  throw new Error(`invalid TSET header: version=${version} layers=${numTiles}`);
}

const columns = new Map<string, Set<number>>();
let offset = 92;
for (let index = 0; index < numTiles; index++) {
  if (offset + 8 > buffer.length) {
    throw new Error(`truncated before layer ${index}`);
  }
  offset += 4;
  const dataSize = buffer.readInt32LE(offset);
  offset += 4;
  if (dataSize < 20 || offset + dataSize > buffer.length) {
    throw new Error(`invalid layer ${index} size ${dataSize}`);
  }
  const tx = buffer.readInt32LE(offset + 8);
  const ty = buffer.readInt32LE(offset + 12);
  const layer = buffer.readInt32LE(offset + 16);
  const key = `${tx},${ty}`;
  const layers = columns.get(key) ?? new Set<number>();
  if (layers.has(layer)) {
    throw new Error(`duplicate layer ${layer} in column ${key}`);
  }
  layers.add(layer);
  columns.set(key, layers);
  offset += dataSize;
}
if (offset !== buffer.length) {
  throw new Error(`${buffer.length - offset} trailing bytes`);
}

const layerCounts = [...columns.values()].map((layers) => layers.size);
console.log(
  JSON.stringify(
    {
      parts: parts.length,
      bytes: buffer.length,
      version,
      layers: numTiles,
      columns: columns.size,
      maxLayersPerColumn: Math.max(...layerCounts),
      cellSize: buffer.readFloatLE(52),
      cellHeight: buffer.readFloatLE(56),
      tileVoxels: [buffer.readInt32LE(60), buffer.readInt32LE(64)],
      walkableHeight: buffer.readFloatLE(68),
      walkableRadius: buffer.readFloatLE(72),
      walkableClimb: buffer.readFloatLE(76)
    },
    null,
    2
  )
);
