import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validateStreamingNav.ts <cache-dir> [x y z]"
  );
  process.exit(1);
}

const center = new Float32Array([
  Number(process.argv[3] ?? 696.53),
  Number(process.argv[4] ?? 48.08),
  Number(process.argv[5] ?? -2470.62),
  1
]);
process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");
  nav.streamAround([center]);

  const halfExtents = { halfExtents: { x: 3, y: 10, z: 3 } };
  const query = nav.navMeshQuery;
  const centerPoint = { x: center[0], y: center[1], z: center[2] };
  const centerSnap = query.findNearestPoly(centerPoint, halfExtents);
  if (!centerSnap.nearestRef) throw new Error("center is not on the navmesh");

  const anchors = [
    centerPoint,
    { x: center[0] + 100, y: center[1], z: center[2] },
    { x: center[0] - 100, y: center[1], z: center[2] },
    { x: center[0], y: center[1], z: center[2] + 100 },
    { x: center[0], y: center[1], z: center[2] - 100 }
  ];
  let anchorPaths = 0;
  for (const anchor of anchors) {
    const snap = query.findNearestPoly(anchor, halfExtents);
    if (!snap.nearestRef) continue;
    const path = query.computePath(
      centerSnap.nearestPoint,
      snap.nearestPoint,
      halfExtents
    );
    if (!path.success || !path.path?.length) continue;
    const last = path.path[path.path.length - 1];
    if (
      Math.hypot(last.x - snap.nearestPoint.x, last.z - snap.nearestPoint.z) < 2
    ) {
      anchorPaths++;
    }
  }

  const samples = [];
  for (let i = 0; i < 80; i++) {
    const point = query.findRandomPoint();
    if (point.success) samples.push(point.randomPoint);
  }

  let centerReach = 0;
  for (const target of samples) {
    const path = query.computePath(
      centerSnap.nearestPoint,
      target,
      halfExtents
    );
    if (!path.success || !path.path?.length) continue;
    const last = path.path[path.path.length - 1];
    if (Math.hypot(last.x - target.x, last.z - target.z) < 2) centerReach++;
  }

  let largestReach = 0;
  for (const start of samples.slice(0, 20)) {
    let reached = 0;
    for (const target of samples) {
      const path = query.computePath(start, target, halfExtents);
      if (!path.success || !path.path?.length) continue;
      const last = path.path[path.path.length - 1];
      if (Math.hypot(last.x - target.x, last.z - target.z) < 2) reached++;
    }
    largestReach = Math.max(largestReach, reached);
  }

  console.log(
    JSON.stringify(
      {
        center: Array.from(center.slice(0, 3)),
        centerSnap: centerSnap.nearestPoint,
        anchorPaths: `${anchorPaths}/${anchors.length}`,
        centerReach: `${centerReach}/${samples.length}`,
        randomSamples: samples.length,
        largestConnectedSample: `${largestReach}/${samples.length}`
      },
      null,
      2
    )
  );

  if (
    centerReach < samples.length * 0.5 ||
    largestReach < samples.length * 0.8
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
