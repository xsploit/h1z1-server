import { resolve } from "node:path";

const cacheDirectory = process.argv[2];
if (!cacheDirectory) {
  console.error(
    "Usage: npx tsx scripts/analyzePvPoliceFloorGap.ts <cache-dir>"
  );
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);

type Point = { x: number; y: number; z: number };

const lowerSeed = { x: -235.1, y: 25.45, z: -1153.1 };
const upperSeed = { x: -235.84, y: 28.68, z: -1153.33 };

function reached(path: Point[] | undefined, target: Point): boolean {
  const last = path?.[path.length - 1];
  return Boolean(
    last &&
    Math.hypot(last.x - target.x, last.y - target.y, last.z - target.z) < 0.75
  );
}

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([
    new Float32Array([lowerSeed.x, lowerSeed.y, lowerSeed.z, 1])
  ]);

  const query = nav.navMeshQuery;
  const sampleFloor = (y: number) => {
    const points = new Map<number, Point>();
    for (let x = -243.5; x <= -223.5; x += 0.5) {
      for (let z = -1167; z <= -1133.5; z += 0.5) {
        const result = query.findNearestPoly(
          { x, y, z },
          { halfExtents: { x: 0.24, y: 0.7, z: 0.24 } }
        );
        if (result.nearestRef)
          points.set(result.nearestRef, result.nearestPoint);
      }
    }
    return [...points.values()];
  };

  const component = (seed: Point, points: Point[]) =>
    points.filter((point) =>
      reached(
        query.computePath(seed, point, {
          halfExtents: { x: 0.5, y: 0.75, z: 0.5 }
        }).path,
        point
      )
    );

  const sampledLower = sampleFloor(25.45);
  const sampledUpper = sampleFloor(28.75);
  const lower = component(lowerSeed, sampledLower);
  const upper = component(upperSeed, sampledUpper);
  const pairs = lower
    .flatMap((from) =>
      upper.map((to) => ({
        from,
        to,
        horizontalDistance: Math.hypot(from.x - to.x, from.z - to.z),
        verticalDistance: to.y - from.y,
        distance: Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z)
      }))
    )
    .filter((pair) => pair.verticalDistance > 0.75)
    .sort((a, b) => a.horizontalDistance - b.horizontalDistance)
    .slice(0, 30);

  console.log(
    JSON.stringify(
      {
        sampled: { lower: sampledLower.length, upper: sampledUpper.length },
        components: { lower: lower.length, upper: upper.length },
        closestCrossFloorPairs: pairs
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
