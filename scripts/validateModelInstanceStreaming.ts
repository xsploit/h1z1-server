import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Route = {
  instance?: number;
  instanceIndex?: number;
  label?: string;
  start: [number, number, number];
  end: [number, number, number];
};

type ForbiddenProbe = {
  instanceIndex: number;
  label: string;
  position: [number, number, number];
  halfExtents: [number, number, number];
};

const cacheDir = process.argv[2];
const routeFile = process.argv[3];
const instance = Number(process.argv[4]);
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
const transitionsIndex = process.argv.indexOf("--transitions");
const transitionsPath =
  transitionsIndex >= 0 ? process.argv[transitionsIndex + 1] : undefined;
const forbiddenIndex = process.argv.indexOf("--forbidden");
const forbiddenPath =
  forbiddenIndex >= 0 ? process.argv[forbiddenIndex + 1] : undefined;
if (!cacheDir || !routeFile || !Number.isInteger(instance)) {
  console.error(
    "Usage: npx tsx scripts/validateModelInstanceStreaming.ts <cache-dir> <routes.json> <instance-index> [--report <report.json>] [--transitions <transitions.json>] [--forbidden <forbidden.json>]"
  );
  process.exit(1);
}
if (transitionsIndex >= 0 && !transitionsPath) {
  throw new Error("--transitions requires a path");
}
if (forbiddenIndex >= 0 && !forbiddenPath) {
  throw new Error("--forbidden requires a path");
}

function routeInstance(route: Route) {
  return route.instance ?? route.instanceIndex;
}

async function main() {
  const routes = (
    JSON.parse(readFileSync(resolve(routeFile), "utf8")) as Route[]
  ).filter((route) => routeInstance(route) === instance);
  if (!routes.length)
    throw new Error(`no routes found for instance ${instance}`);
  const forbiddenProbes = forbiddenPath
    ? (
        JSON.parse(
          readFileSync(resolve(forbiddenPath), "utf8")
        ) as ForbiddenProbe[]
      ).filter((probe) => probe.instanceIndex === instance)
    : [];

  process.env.NAV_STREAMING = "1";
  process.env.NAV_CACHE_DIR = resolve(cacheDir);
  process.env.NAV_TRANSITIONS_PATH = resolve(
    transitionsPath ?? "data/2016/navigationTransitions.json"
  );
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  // Regional candidate caches intentionally have no deployable manifest yet.
  // Exercise the same disk index, runtime capacity, mesh process, and
  // materialization path as production without misrepresenting the candidate
  // as a verified deployment artifact.
  await (
    nav as unknown as { loadNavStreaming(): Promise<void> }
  ).loadNavStreaming();
  const streamed = nav.streamAround(
    routes.flatMap((route) => [
      new Float32Array([...route.start, 1]),
      new Float32Array([...route.end, 1])
    ])
  );
  const query = nav.navMeshQuery;

  const options = { halfExtents: { x: 0.8, y: 1.5, z: 0.8 } };
  const failures = [];
  let routeAnchorHits = 0;
  for (const route of routes) {
    const start = { x: route.start[0], y: route.start[1], z: route.start[2] };
    const end = { x: route.end[0], y: route.end[1], z: route.end[2] };
    const startSnap = query.findNearestPoly(start, options);
    const endSnap = query.findNearestPoly(end, options);
    if (startSnap.nearestRef) routeAnchorHits++;
    if (endSnap.nearestRef) routeAnchorHits++;
    let gap = Number.POSITIVE_INFINITY;
    if (startSnap.nearestRef && endSnap.nearestRef) {
      const path = query.computePath(
        startSnap.nearestPoint,
        endSnap.nearestPoint,
        options
      );
      const last = path.path?.at(-1);
      if (last) {
        gap = Math.hypot(
          last.x - endSnap.nearestPoint.x,
          last.z - endSnap.nearestPoint.z
        );
      }
    }
    if (gap > 0.25) {
      failures.push({
        instance,
        label: route.label ?? "authored route",
        gap,
        start,
        end,
        startSnap,
        endSnap
      });
    }
  }
  const meshPresent = routeAnchorHits === routes.length * 2;
  const forbiddenFailures = [];
  const forbiddenUnverified = meshPresent
    ? []
    : forbiddenProbes.map((probe) => ({
        ...probe,
        reason: "model navmesh presence was not proven"
      }));
  for (const probe of meshPresent ? forbiddenProbes : []) {
    const nearest = query.findNearestPoly(
      {
        x: probe.position[0],
        y: probe.position[1],
        z: probe.position[2]
      },
      {
        halfExtents: {
          x: probe.halfExtents[0],
          y: probe.halfExtents[1],
          z: probe.halfExtents[2]
        }
      }
    );
    if (nearest.nearestRef) forbiddenFailures.push({ ...probe, nearest });
  }

  const summary = {
    cacheDirectory: resolve(cacheDir),
    transitionsPath: process.env.NAV_TRANSITIONS_PATH,
    instance,
    streamed,
    meshPresent,
    routeAnchorHits,
    routes: routes.length,
    passed: routes.length - failures.length,
    failures,
    forbiddenProbes: forbiddenProbes.length,
    forbiddenEvaluated: meshPresent ? forbiddenProbes.length : 0,
    forbiddenPassed: meshPresent
      ? forbiddenProbes.length - forbiddenFailures.length
      : 0,
    forbiddenFailures,
    forbiddenUnverified
  };
  const encoded = `${JSON.stringify(summary, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), encoded);
  console.log(encoded);
  if (failures.length || forbiddenFailures.length || forbiddenUnverified.length)
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
