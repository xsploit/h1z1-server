// Does the EXISTING (pre-baked) navmesh already connect building interiors to
// the outside? Compares against the regenerated one to decide whether a full
// re-bake is even needed.
const { NavManager } = require("../../out/utils/recast.js");

const INTERIORS = [
  [-1924.4, 62.6, -2133.9],
  [-1938.2, 62.6, -2133.5],
  [-1941.9, 62.6, -2146.9],
  [-1942.2, 62.6, -2160.9],
  [-1911.2, 62.6, -2134.2]
];
const HE = { halfExtents: { x: 3, y: 10, z: 3 } };

(async () => {
  const nav = new NavManager();
  await nav.loadNav();
  const q = nav.navMeshQuery;

  for (const [x, y, z] of INTERIORS) {
    const snap = q.findNearestPoly({ x, y, z }, HE);
    if (!snap.nearestRef) {
      console.log(`interior (${x},${z}): NOT on existing navmesh`);
      continue;
    }
    // reachability to a ring of nearby points (15..40m) => is the interior
    // connected to the surrounding area on the EXISTING navmesh?
    let reach = 0, total = 0;
    for (let a = 0; a < 16; a++) {
      for (const r of [15, 25, 40]) {
        const tx = x + Math.cos((a / 16) * 2 * Math.PI) * r;
        const tz = z + Math.sin((a / 16) * 2 * Math.PI) * r;
        const ts = q.findNearestPoly({ x: tx, y, z: tz }, HE);
        if (!ts.nearestRef) continue;
        total++;
        const p = q.computePath(snap.nearestPoint, ts.nearestPoint, HE);
        if (p.success && p.path && p.path.length) {
          const last = p.path[p.path.length - 1];
          if (Math.hypot(last.x - ts.nearestPoint.x, last.z - ts.nearestPoint.z) < 2) reach++;
        }
      }
    }
    const pct = total ? ((reach / total) * 100).toFixed(0) : "0";
    console.log(
      `interior (${x},${z}): on existing navmesh, reaches ${reach}/${total} nearby (${pct}%) ` +
        (total && reach / total > 0.4 ? "=> CONNECTED on existing nav ✓" : "=> isolated on existing nav too ✗")
    );
  }
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
