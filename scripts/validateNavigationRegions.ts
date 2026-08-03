import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateNavigationValidation,
  loadNavigationValidationConfig,
  navigationValidationConfigSha256,
  NavigationProbeAdapter,
  NavigationProbePoint
} from "../src/utils/navigationvalidation";

const DT_STRAIGHTPATH_ALL_CROSSINGS = 2;
const ADAPTER_VERSION = "detour-all-crossings-snap-refs-areas-v3";
const MAX_PATH_POLYS = 2048;
const MAX_STRAIGHT_PATH_POINTS = 2048;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cacheDirectory = option("--cache-dir");
const navmeshPath = option("--navmesh");
const configPath = resolve(
  option("--config") ?? "data/2016/navigationValidationRegions.pvEvidence.json"
);
const reportPath = option("--report");
const topologyOnly = process.argv.includes("--topology-only");
if (Boolean(cacheDirectory) === Boolean(navmeshPath)) {
  console.error(
    "Usage: npx tsx scripts/validateNavigationRegions.ts (--cache-dir <dir> | --navmesh <z1_0.bin>) [--config <file>] [--report <file>] [--topology-only]"
  );
  process.exit(1);
}

if (cacheDirectory) {
  process.env.NAV_STREAMING = "1";
  process.env.NAV_CACHE_DIR = resolve(cacheDirectory);
}
if (topologyOnly) process.env.NAV_TRANSITIONS = "0";

async function main() {
  const { hasDetourSuccess, NavManager } = await import("../src/utils/recast");
  let navmesh;
  let query;
  let nav: InstanceType<typeof NavManager> | undefined;
  if (navmeshPath) {
    const { importNavMesh, init, NavMeshQuery } = await import(
      "recast-navigation"
    );
    await init();
    navmesh = importNavMesh(
      new Uint8Array(readFileSync(resolve(navmeshPath)))
    ).navMesh;
    query = new NavMeshQuery(navmesh);
  } else {
    nav = new NavManager();
    await nav.loadNav();
    if (!nav.streaming) throw new Error("streaming cache did not load");
    navmesh = nav.navmesh;
    query = nav.navMeshQuery;
  }
  const config = loadNavigationValidationConfig(configPath);
  if (nav) {
    nav.streamAround(
      config.regions.flatMap((region) =>
        region.anchors.map(
          (anchor) => new Float32Array([...anchor.position, 1])
        )
      )
    );
  }

  const adapter: NavigationProbeAdapter = {
    snap(position, halfExtents) {
      const nearest = query.findNearestPoly(position, {
        halfExtents
      });
      if (!nearest.nearestRef) {
        return { ref: 0, point: position, area: null };
      }
      let area: number | null = null;
      const result = navmesh.getPolyArea(nearest.nearestRef);
      if (hasDetourSuccess(result.status)) area = result.area;
      return {
        ref: nearest.nearestRef,
        point: nearest.nearestPoint,
        area
      };
    },
    path(from, to, _halfExtents, fromRef, toRef) {
      if (!fromRef || !toRef) return [];

      const corridor = query.findPath(fromRef, toRef, from, to, {
        maxPathPolys: MAX_PATH_POLYS
      });
      try {
        if (!corridor.success || corridor.polys.size === 0) return [];
        const areas: number[] = [];
        for (let index = 0; index < corridor.polys.size; index++) {
          const area = navmesh.getPolyArea(corridor.polys.get(index));
          if (hasDetourSuccess(area.status)) areas.push(area.area);
        }
        const lastRef = corridor.polys.get(corridor.polys.size - 1);
        let closestEnd: NavigationProbePoint = to;
        if (lastRef !== toRef) {
          const closest = query.closestPointOnPoly(lastRef, to);
          if (!closest.success) return [];
          closestEnd = closest.closestPoint;
        }

        // The default Detour straight path only reports turning corners. On a
        // straight stair that compresses the whole rise into one apparent
        // vertical jump, while a bogus elevator edge can look identical. Emit
        // every polygon crossing so the topology gate measures the actual
        // baked corridor rather than its string-pulled presentation.
        const straight = query.findStraightPath(
          from,
          closestEnd,
          corridor.polys,
          {
            maxStraightPathPoints: MAX_STRAIGHT_PATH_POINTS,
            straightPathOptions: DT_STRAIGHTPATH_ALL_CROSSINGS
          }
        );
        try {
          if (!straight.success) return [];
          const points: NavigationProbePoint[] = [];
          for (let index = 0; index < straight.straightPathCount; index++) {
            points.push({
              x: straight.straightPath.get(index * 3),
              y: straight.straightPath.get(index * 3 + 1),
              z: straight.straightPath.get(index * 3 + 2)
            });
          }
          return { points, areas };
        } finally {
          straight.straightPath.destroy();
          straight.straightPathFlags.destroy();
          straight.straightPathRefs.destroy();
        }
      } finally {
        corridor.polys.destroy();
      }
    }
  };
  const report = evaluateNavigationValidation(config, adapter);
  report.provenance = {
    configSha256: navigationValidationConfigSha256(config),
    adapterVersion: ADAPTER_VERSION,
    straightPathOptions: DT_STRAIGHTPATH_ALL_CROSSINGS,
    maxPathPolys: MAX_PATH_POLYS,
    maxStraightPathPoints: MAX_STRAIGHT_PATH_POINTS,
    topologyOnly
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), serialized);
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
