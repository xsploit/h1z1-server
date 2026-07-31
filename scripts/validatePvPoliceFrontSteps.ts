import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validatePvPoliceFrontSteps.ts <cache-dir>"
  );
  process.exit(1);
}

// Exterior PV police-station approach: road/sidewalk at the foot of the
// front steps, then the entrance landing. These are deliberately kept on
// their respective elevations so a wide query cannot hide a broken stair
// connection by snapping to another floor.
const road = new Float32Array([-222, 22.93, -1157, 1]);
const entrance = new Float32Array([-222, 25.22, -1165, 1]);
process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([road]);

  const query = nav.navMeshQuery;
  const extents = { halfExtents: { x: 2, y: 0.75, z: 2 } };
  const start = query.findNearestPoly(
    { x: road[0], y: road[1], z: road[2] },
    extents
  );
  const end = query.findNearestPoly(
    { x: entrance[0], y: entrance[1], z: entrance[2] },
    extents
  );
  if (!start.nearestRef || !end.nearestRef) {
    console.log(
      JSON.stringify(
        {
          road: { ref: start.nearestRef, point: start.nearestPoint },
          entrance: { ref: end.nearestRef, point: end.nearestPoint }
        },
        null,
        2
      )
    );
    throw new Error("road or entrance sample is missing from navmesh");
  }
  const path = query.computePath(start.nearestPoint, end.nearestPoint, extents);
  const last = path.path?.[path.path.length - 1];
  const reached = Boolean(
    last &&
    Math.hypot(
      last.x - end.nearestPoint.x,
      last.y - end.nearestPoint.y,
      last.z - end.nearestPoint.z
    ) < 1
  );
  console.log(
    JSON.stringify(
      {
        road: start.nearestPoint,
        entrance: end.nearestPoint,
        success: path.success,
        reached,
        corners: path.path?.length ?? 0,
        path: path.path
      },
      null,
      2
    )
  );
  if (!reached) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
