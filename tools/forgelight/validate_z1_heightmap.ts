import { createCanvas, loadImage } from "@napi-rs/canvas";
import { join } from "node:path";
import { CollisionManager } from "../../src/servers/ZoneServer2016/managers/collisionmanager";
import { NavManager } from "../../src/utils/recast";

function percentile(sorted: number[], fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

async function main() {
  const heightmapPath = join(
    process.cwd(),
    "data",
    "2016",
    "zoneData",
    "heightmap.png"
  );
  const image = await loadImage(heightmapPath);
  if (image.width !== 8192 || image.height !== 8192) {
    throw new Error(
      `Expected an 8192x8192 heightmap, got ${image.width}x${image.height}`
    );
  }
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;

  const navManager = new NavManager();
  await navManager.loadNav();
  const collisionManager = new CollisionManager();
  collisionManager.load();

  const differences: number[] = [];
  const outliers: { x: number; z: number; terrain: number; nav: number }[] = [];
  let structureSamples = 0;
  let missingNavSamples = 0;

  for (let x = -4064; x <= 4064; x += 32) {
    for (let z = -4064; z <= 4064; z += 32) {
      if (collisionManager.groundRaycast(x, z, 1000) !== null) {
        structureSamples++;
        continue;
      }
      const pixelX = Math.floor(z + 4096);
      const pixelY = Math.floor(4096 - x);
      const index = (pixelY * image.width + pixelX) * 4;
      const terrain = (pixels[index] - 16) * 8 + pixels[index + 1] / 32;
      const position = new Float32Array([x, terrain, z, 1]);
      const nav = navManager.getFloorY(position);
      if (nav === null) {
        missingNavSamples++;
        continue;
      }
      const difference = Math.abs(terrain - nav);
      differences.push(difference);
      if (difference > 2 && outliers.length < 30) {
        outliers.push({ x, z, terrain, nav });
      }
    }
  }

  differences.sort((a, b) => a - b);
  console.log(
    `[heightmap-check] compared=${differences.length} ` +
      `structures_skipped=${structureSamples} missing_nav=${missingNavSamples}`
  );
  console.log(
    `[heightmap-check] absolute error ` +
      `median=${percentile(differences, 0.5).toFixed(3)}m ` +
      `p95=${percentile(differences, 0.95).toFixed(3)}m ` +
      `p99=${percentile(differences, 0.99).toFixed(3)}m ` +
      `max=${differences[differences.length - 1].toFixed(3)}m`
  );
  for (const outlier of outliers) {
    console.log(
      `[heightmap-check] outlier x=${outlier.x} z=${outlier.z} ` +
        `terrain=${outlier.terrain.toFixed(3)} nav=${outlier.nav.toFixed(3)}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
