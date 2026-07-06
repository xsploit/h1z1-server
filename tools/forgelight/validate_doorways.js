// Validate that building interiors are CONNECTED to the street network on the
// generated navmesh (doorways passable). For each interior point (kitchen/bath
// props), snap to the navmesh and measure reachability to random navmesh points.
const { generateRegion } = require("./gen_navmesh");
const { NavMeshQuery } = require("recast-navigation");

const INTERIORS = [
  [-1924.4, 62.6, -2133.9],
  [-1938.2, 62.6, -2133.5],
  [-1941.9, 62.6, -2146.9],
  [-1942.2, 62.6, -2160.9],
  [-1911.2, 62.6, -2134.2],
  [-1924.4, 62.6, -2148.8]
];
const HE = { halfExtents: { x: 3, y: 10, z: 3 } };

(async () => {
  const { result } = await generateRegion(-1980, -2200, -1880, -2100);
  if (!result.success) process.exit(1);
  const query = new NavMeshQuery(result.navMesh);

  const targets = [];
  for (let i = 0; i < 120; i++) {
    const rp = query.findRandomPoint();
    if (rp.success) targets.push(rp.randomPoint);
  }
  console.log(`\n${targets.length} random navmesh target points`);

  // BASELINE: how connected is the navmesh overall? (random point -> targets)
  // high => navmesh mostly one component (interiors specially sealed)
  // low  => navmesh globally fragmented (a config problem, not doorways)
  let baseSum = 0,
    baseN = 0;
  for (let s = 0; s < 8; s++) {
    const rp = query.findRandomPoint();
    if (!rp.success) continue;
    let r = 0;
    for (const t of targets) {
      const p = query.computePath(rp.randomPoint, t, HE);
      if (p.success && p.path && p.path.length) {
        const last = p.path[p.path.length - 1];
        if (Math.hypot(last.x - t.x, last.z - t.z) < 2) r++;
      }
    }
    baseSum += r / targets.length;
    baseN++;
  }
  console.log(
    `BASELINE random->random reachability: ${((baseSum / baseN) * 100).toFixed(0)}% ` +
      `(high = connected navmesh; low = globally fragmented)\n`
  );

  for (const [x, y, z] of INTERIORS) {
    const snap = query.findNearestPoly({ x, y, z }, HE);
    if (!snap.nearestRef) {
      console.log(`interior (${x},${z}): NOT on navmesh (interior has no walkable floor)`);
      continue;
    }
    const np = snap.nearestPoint;
    let reach = 0;
    for (const t of targets) {
      const p = query.computePath(np, t, HE);
      if (p.success && p.path && p.path.length > 0) {
        const last = p.path[p.path.length - 1];
        if (Math.hypot(last.x - t.x, last.z - t.z) < 2) reach++;
      }
    }
    const pct = ((reach / targets.length) * 100).toFixed(0);
    console.log(
      `interior (${x},${z}) snapY=${np.y.toFixed(1)}: on navmesh, reaches ${reach}/${targets.length} (${pct}%) ` +
        (reach / targets.length > 0.4 ? "=> CONNECTED ✓" : "=> isolated/sealed ✗")
    );
  }
  process.exit(0);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
