import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validateStreamingDoorways.ts <cache-dir>"
  );
  process.exit(1);
}

const interiors = [
  [-1924.4, 62.6, -2133.9],
  [-1938.2, 62.6, -2133.5],
  [-1941.9, 62.6, -2146.9],
  [-1942.2, 62.6, -2160.9],
  [-1911.2, 62.6, -2134.2],
  [-1924.4, 62.6, -2148.8]
];
process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");
  nav.streamAround([
    new Float32Array([interiors[0][0], interiors[0][1], interiors[0][2], 1])
  ]);

  const query = nav.navMeshQuery;
  const halfExtents = { halfExtents: { x: 2, y: 4, z: 2 } };
  const samples = [];
  for (let i = 0; i < 80; i++) {
    const point = query.findRandomPoint();
    if (point.success) samples.push(point.randomPoint);
  }

  const results = [];
  let connectedInteriors = 0;
  for (const [x, y, z] of interiors) {
    const snap = query.findNearestPoly({ x, y, z }, halfExtents);
    if (!snap.nearestRef) {
      results.push({ x, z, onNavmesh: false, reach: `0/${samples.length}` });
      continue;
    }
    let reached = 0;
    for (const target of samples) {
      const path = query.computePath(snap.nearestPoint, target, halfExtents);
      if (!path.success || !path.path?.length) continue;
      const last = path.path[path.path.length - 1];
      if (Math.hypot(last.x - target.x, last.z - target.z) < 2) reached++;
    }
    const connected = reached >= samples.length * 0.5;
    if (connected) connectedInteriors++;
    results.push({
      x,
      z,
      onNavmesh: true,
      snapY: snap.nearestPoint.y,
      reach: `${reached}/${samples.length}`,
      connected
    });
  }

  console.log(
    JSON.stringify(
      {
        randomSamples: samples.length,
        connectedInteriors: `${connectedInteriors}/${interiors.length}`,
        interiors: results
      },
      null,
      2
    )
  );

  if (samples.length < 40 || connectedInteriors < 4) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
