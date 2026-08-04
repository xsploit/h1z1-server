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

type ForbiddenProbe = {
  instanceIndex: number;
  label: string;
  position: [number, number, number];
  halfExtents: [number, number, number];
};

const bakeRoot = process.argv[2];
const routeFiles: string[] = [];
let forbiddenPath: string | undefined;
for (let index = 3; index < process.argv.length; index++) {
  if (process.argv[index] === "--forbidden") {
    forbiddenPath = process.argv[++index];
    if (!forbiddenPath) throw new Error("--forbidden requires a path");
  } else {
    routeFiles.push(process.argv[index]);
  }
}
if (!bakeRoot || routeFiles.length === 0) {
  console.error(
    "Usage: npx tsx scripts/validateHouse34BInstances.ts <bake-root> <routes.json> [...] [--forbidden <forbidden.json>]"
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
  const forbiddenProbes = forbiddenPath
    ? (JSON.parse(
        readFileSync(resolve(forbiddenPath), "utf8")
      ) as ForbiddenProbe[])
    : [];

  const failures = [];
  const forbiddenFailures = [];
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
    for (const probe of forbiddenProbes.filter(
      (candidate) => candidate.instanceIndex === instance
    )) {
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
    query.destroy();
    navMesh.destroy();
  }

  const summary = {
    instances: byInstance.size,
    routes: checkedRoutes,
    passed: checkedRoutes - failures.length,
    failures,
    forbiddenProbes: forbiddenProbes.length,
    forbiddenPassed: forbiddenProbes.length - forbiddenFailures.length,
    forbiddenFailures
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length || forbiddenFailures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
