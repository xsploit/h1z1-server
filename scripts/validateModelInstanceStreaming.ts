import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Route = {
  instance?: number;
  instanceIndex?: number;
  label?: string;
  start: [number, number, number];
  end: [number, number, number];
};

const cacheDir = process.argv[2];
const routeFile = process.argv[3];
const instance = Number(process.argv[4]);
if (!cacheDir || !routeFile || !Number.isInteger(instance)) {
  console.error(
    "Usage: npx tsx scripts/validateModelInstanceStreaming.ts <cache-dir> <routes.json> <instance-index>"
  );
  process.exit(1);
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

  process.env.NAV_STREAMING = "1";
  process.env.NAV_CACHE_DIR = resolve(cacheDir);
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  // Regional candidate caches intentionally have no deployable manifest yet.
  // Exercise the same disk index, runtime capacity, mesh process, and
  // materialization path as production without misrepresenting the candidate
  // as a verified deployment artifact.
  await (
    nav as unknown as { loadNavStreaming(): Promise<void> }
  ).loadNavStreaming();
  nav.streamAround(
    routes.flatMap((route) => [
      new Float32Array([...route.start, 1]),
      new Float32Array([...route.end, 1])
    ])
  );
  const query = nav.navMeshQuery;

  const options = { halfExtents: { x: 0.8, y: 1.5, z: 0.8 } };
  const failures = [];
  for (const route of routes) {
    const start = { x: route.start[0], y: route.start[1], z: route.start[2] };
    const end = { x: route.end[0], y: route.end[1], z: route.end[2] };
    const startSnap = query.findNearestPoly(start, options);
    const endSnap = query.findNearestPoly(end, options);
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

  console.log(
    JSON.stringify(
      {
        instance,
        routes: routes.length,
        passed: routes.length - failures.length,
        failures
      },
      null,
      2
    )
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
