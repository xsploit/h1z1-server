import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { CollisionManager } from "../src/servers/ZoneServer2016/managers/collisionmanager";
import {
  sampleTerrainHeight,
  selectGroundSurface
} from "../src/servers/ZoneServer2016/managers/grounding";

const cacheDirectory = process.argv[2];
const x = Number(process.argv[3]);
const y = Number(process.argv[4]);
const z = Number(process.argv[5]);
const radius = Number(process.argv[6] ?? 0);
const step = Number(process.argv[7] ?? 1);

if (
  !cacheDirectory ||
  ![x, y, z, radius, step].every(Number.isFinite) ||
  radius < 0 ||
  step <= 0
) {
  console.error(
    "Usage: npx tsx scripts/probeGroundingAt.ts <cache-dir> <x> <y> <z> [radius] [step]"
  );
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);

async function main() {
  const [{ NavManager }, image] = await Promise.all([
    import("../src/utils/recast"),
    loadImage(readFileSync(resolve("data/2016/zoneData/heightmap.png")))
  ]);
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([new Float32Array([x, y, z, 1])]);

  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const heightmap = context.getImageData(0, 0, image.width, image.height).data;
  const collision = new CollisionManager();
  collision.load(resolve("data/2016/collision/z1_collision.bin"));

  const samples = [];
  for (let sx = x - radius; sx <= x + radius + 1e-6; sx += step) {
    for (let sz = z - radius; sz <= z + radius + 1e-6; sz += step) {
      const position = new Float32Array([sx, y, sz, 1]);
      const navY = nav.getFloorY(position);
      const terrain = sampleTerrainHeight(
        heightmap,
        image.width,
        image.height,
        sx,
        sz,
        y
      );
      const structureY = collision.groundRaycast(sx, sz, navY ?? y);
      const selection = selectGroundSurface({
        terrainY: terrain?.height ?? null,
        structureY,
        navY,
        currentY: y
      });
      samples.push({
        x: Number(sx.toFixed(2)),
        z: Number(sz.toFixed(2)),
        currentY: y,
        navY,
        terrainY: terrain?.height ?? null,
        structureY,
        selectedY: selection.height,
        source: selection.source,
        navMinusTerrain:
          navY !== null && terrain ? navY - terrain.height : null,
        navMinusStructure:
          navY !== null && structureY !== null ? navY - structureY : null
      });
    }
  }

  const suspicious = samples.filter(
    (sample) =>
      sample.navY !== null &&
      sample.terrainY !== null &&
      sample.navY - sample.terrainY > 0.45 &&
      (sample.structureY === null ||
        Math.abs(sample.navY - sample.structureY) > 0.45)
  );
  console.log(
    JSON.stringify(
      {
        origin: { x, y, z },
        radius,
        step,
        sampleCount: samples.length,
        suspiciousCount: suspicious.length,
        suspicious,
        samples: radius === 0 ? samples : undefined
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
