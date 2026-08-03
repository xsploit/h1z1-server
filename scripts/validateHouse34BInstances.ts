import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  importNavMesh,
  init as initRecast,
  NavMeshQuery
} from "recast-navigation";

type Route = {
  instance?: number;
  instanceIndex?: number;
  label?: string;
  start: [number, number, number];
  end: [number, number, number];
};

const bakeRoot = process.argv[2];
const routeFiles = process.argv.slice(3);
if (!bakeRoot || routeFiles.length === 0) {
  console.error(
    "Usage: npx tsx scripts/validateHouse34BInstances.ts <bake-root> <routes.json> [...]"
  );
  process.exit(1);
}

function routeInstance(route: Route) {
  const instance = route.instance ?? route.instanceIndex;
  if (!Number.isInteger(instance))
    throw new Error("route has no instance index");
  return instance!;
}

async function main() {
  await initRecast();
  const routes = routeFiles.flatMap(
    (path) => JSON.parse(readFileSync(resolve(path), "utf8")) as Route[]
  );
  const byInstance = new Map<number, Route[]>();
  for (const route of routes) {
    const instance = routeInstance(route);
    const entries = byInstance.get(instance) ?? [];
    entries.push(route);
    byInstance.set(instance, entries);
  }

  const failures = [];
  let checkedRoutes = 0;
  for (const [instance, instanceRoutes] of [...byInstance].sort(
    ([left], [right]) => left - right
  )) {
    const navPath = join(resolve(bakeRoot), String(instance), "z1_0.bin");
    const { navMesh } = importNavMesh(new Uint8Array(readFileSync(navPath)));
    const query = new NavMeshQuery(navMesh);
    for (const route of instanceRoutes) {
      const start = { x: route.start[0], y: route.start[1], z: route.start[2] };
      const end = { x: route.end[0], y: route.end[1], z: route.end[2] };
      const options = { halfExtents: { x: 0.8, y: 1.5, z: 0.8 } };
      const startSnap = query.findNearestPoly(start, options);
      const endSnap = query.findNearestPoly(end, options);
      let gap = Number.POSITIVE_INFINITY;
      let pathPoints: unknown[] = [];
      if (startSnap.nearestRef && endSnap.nearestRef) {
        const path = query.computePath(
          startSnap.nearestPoint,
          endSnap.nearestPoint,
          options
        );
        pathPoints = path.path ?? [];
        const last = path.path?.at(-1);
        if (last) {
          gap = Math.hypot(
            last.x - endSnap.nearestPoint.x,
            last.z - endSnap.nearestPoint.z
          );
        }
      }
      checkedRoutes++;
      if (gap > 0.25) {
        failures.push({
          instance,
          label: route.label ?? "authored route",
          gap,
          start,
          end,
          startSnap,
          endSnap,
          pathPoints
        });
      }
    }
    query.destroy();
    navMesh.destroy();
  }

  const summary = {
    instances: byInstance.size,
    routes: checkedRoutes,
    passed: checkedRoutes - failures.length,
    failures
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
