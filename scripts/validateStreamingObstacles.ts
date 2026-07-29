import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validateStreamingObstacles.ts <cache-dir> [x y z]"
  );
  process.exit(1);
}

const center = {
  x: Number(process.argv[3] ?? 696.53),
  y: Number(process.argv[4] ?? 48.08),
  z: Number(process.argv[5] ?? -2470.62)
};
process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([new Float32Array([center.x, center.y, center.z, 1])]);

  const query = nav.navMeshQuery;
  const halfExtents = { halfExtents: { x: 2, y: 6, z: 2 } };
  const candidateOffsets = [
    [-12, 0, 12, 0],
    [0, -12, 0, 12],
    [-10, -10, 10, 10],
    [-10, 10, 10, -10]
  ];

  let clear:
    | {
        start: { x: number; y: number; z: number };
        end: { x: number; y: number; z: number };
      }
    | undefined;
  for (const [sx, sz, ex, ez] of candidateOffsets) {
    const start = query.findNearestPoly(
      { x: center.x + sx, y: center.y, z: center.z + sz },
      halfExtents
    );
    const end = query.findNearestPoly(
      { x: center.x + ex, y: center.y, z: center.z + ez },
      halfExtents
    );
    if (!start.nearestRef || !end.nearestRef) continue;
    const ray = query.raycast(
      start.nearestRef,
      start.nearestPoint,
      end.nearestPoint
    );
    if (ray.success && ray.t >= 1) {
      clear = { start: start.nearestPoint, end: end.nearestPoint };
      break;
    }
  }
  if (!clear) throw new Error("no clear validation ray found");

  const dx = clear.end.x - clear.start.x;
  const dz = clear.end.z - clear.start.z;
  const obstaclePosition = new Float32Array([
    (clear.start.x + clear.end.x) / 2,
    (clear.start.y + clear.end.y) / 2,
    (clear.start.z + clear.end.z) / 2,
    1
  ]);
  const obstacle = nav.addObstacle(
    obstaclePosition,
    Math.abs(dx) >= Math.abs(dz)
      ? { x: 1.5, y: 2, z: 6 }
      : { x: 6, y: 2, z: 1.5 }
  );
  if (!obstacle) throw new Error("failed to add validation obstacle");
  nav.updt();

  const blockedStart = query.findNearestPoly(clear.start, halfExtents);
  const blocked = query.raycast(
    blockedStart.nearestRef,
    blockedStart.nearestPoint,
    clear.end
  );
  nav.removeObstacle(obstacle);
  nav.updt();

  const restoredStart = query.findNearestPoly(clear.start, halfExtents);
  const restored = query.raycast(
    restoredStart.nearestRef,
    restoredStart.nearestPoint,
    clear.end
  );
  console.log(
    JSON.stringify(
      {
        blockedT: blocked.t,
        restoredT: restored.t,
        obstacleCountAfterRemoval: nav.obstacleCount
      },
      null,
      2
    )
  );
  if (!blocked.success || blocked.t >= 1) {
    throw new Error("streaming obstacle did not block the navmesh ray");
  }
  if (!restored.success || restored.t < 1 || nav.obstacleCount !== 0) {
    throw new Error("streaming obstacle removal did not restore the navmesh");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
