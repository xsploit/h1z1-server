"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const HALF_EXTENTS = Object.freeze({ x: 0.8, y: 0.8, z: 0.8 });
const MAX_ENDPOINT_GAP_METERS = 0.25;

const POINTS = Object.freeze({
  road: Object.freeze({ x: -233.65, y: 23.6, z: -1129.0 }),
  frontSteps: Object.freeze({ x: -233.65, y: 23.7, z: -1133.8 }),
  doorway: Object.freeze({ x: -233.65, y: 25.3, z: -1136.5 }),
  groundInterior: Object.freeze({ x: -230.0, y: 25.45, z: -1162.0 }),
  basementInterior: Object.freeze({ x: -233.1, y: 22.22, z: -1165.6 }),
  stairBottom: Object.freeze({ x: -226.7, y: 25.48, z: -1162.25 }),
  upperInterior: Object.freeze({ x: -232.4, y: 28.75, z: -1161.5 }),
  roofLanding: Object.freeze({ x: -227.8, y: 31.9, z: -1165.5 })
});

const ROUTES = Object.freeze([
  Object.freeze({
    name: "road -> front steps",
    from: "road",
    to: "frontSteps"
  }),
  Object.freeze({
    name: "front steps -> doorway",
    from: "frontSteps",
    to: "doorway"
  }),
  Object.freeze({
    name: "doorway -> ground-floor interior",
    from: "doorway",
    to: "groundInterior"
  }),
  Object.freeze({
    name: "basement -> ground floor via stairs",
    from: "basementInterior",
    to: "stairBottom"
  }),
  Object.freeze({
    name: "ground floor -> upper floor via stairs",
    from: "stairBottom",
    to: "upperInterior"
  })
]);

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function validatePoliceStationRoutes(query) {
  const nearestOptions = { halfExtents: HALF_EXTENTS };
  const snaps = {};
  const failures = [];

  for (const [name, point] of Object.entries(POINTS)) {
    snaps[name] = query.findNearestPoly(point, nearestOptions);
  }

  const results = ROUTES.map((route) => {
    const start = snaps[route.from];
    const target = snaps[route.to];
    if (!start?.nearestRef || !target?.nearestRef) {
      const missing = [
        !start?.nearestRef ? route.from : null,
        !target?.nearestRef ? route.to : null
      ].filter(Boolean);
      const result = {
        ...route,
        ok: false,
        reason: `missing nav snap: ${missing.join(", ")}`
      };
      failures.push(`${route.name}: ${result.reason}`);
      return result;
    }

    const path = query.computePath(
      start.nearestPoint,
      target.nearestPoint,
      nearestOptions
    );
    const last = path.path?.at(-1);
    const endpointGap = last ? distance3(last, target.nearestPoint) : Infinity;
    const ok = Boolean(
      path.success && last && endpointGap <= MAX_ENDPOINT_GAP_METERS
    );
    const result = {
      ...route,
      ok,
      pathNodes: path.path?.length ?? 0,
      endpointGap
    };
    if (!ok) {
      failures.push(
        `${route.name}: partial or missing path (success=${Boolean(path.success)}, ` +
          `nodes=${result.pathNodes}, endpointGap=${endpointGap.toFixed(3)}m)`
      );
    }
    return result;
  });

  const roofIsolated = !snaps.roofLanding?.nearestRef;
  if (!roofIsolated)
    failures.push("roof landing unexpectedly has a nav polygon");

  return { ok: failures.length === 0, results, roofIsolated, failures };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error(
      "usage: node tools/forgelight/validate_pv_police_nav.js <z1_0.bin>"
    );
  }

  const { init, importNavMesh, NavMeshQuery } = require("recast-navigation");
  await init();
  const navPath = resolve(argv[0]);
  const { navMesh } = importNavMesh(new Uint8Array(readFileSync(navPath)));
  try {
    const report = validatePoliceStationRoutes(new NavMeshQuery(navMesh));
    for (const result of report.results) {
      const detail = result.ok
        ? `${result.pathNodes} nodes, ${result.endpointGap.toFixed(3)}m endpoint gap`
        : (result.reason ?? `${result.endpointGap.toFixed(3)}m endpoint gap`);
      console.log(
        `[PV-PD] ${result.ok ? "PASS" : "FAIL"} ${result.name}: ${detail}`
      );
    }
    console.log(
      `[PV-PD] ${report.roofIsolated ? "PASS" : "FAIL"} roof remains excluded`
    );
    if (!report.ok) throw new Error(report.failures.join("; "));
  } finally {
    navMesh.destroy();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[PV-PD] validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  HALF_EXTENTS,
  MAX_ENDPOINT_GAP_METERS,
  POINTS,
  ROUTES,
  distance3,
  main,
  validatePoliceStationRoutes
};
