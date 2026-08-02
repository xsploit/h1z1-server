import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateNavigationValidation,
  loadNavigationValidationConfig,
  NavigationProbeAdapter,
  NavigationProbePoint
} from "../src/utils/navigationvalidation";

const DT_STRAIGHTPATH_ALL_CROSSINGS = 2;
const ADAPTER_VERSION = "detour-all-crossings-v1";
const MAX_PATH_POLYS = 2048;
const MAX_STRAIGHT_PATH_POINTS = 2048;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cacheDirectory = option("--cache-dir");
const configPath = resolve(
  option("--config") ?? "data/2016/navigationValidationRegions.json"
);
const reportPath = option("--report");
const topologyOnly = process.argv.includes("--topology-only");
if (!cacheDirectory) {
  console.error(
    "Usage: npx tsx scripts/validateNavigationRegions.ts --cache-dir <dir> [--config <file>] [--report <file>] [--topology-only]"
  );
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);
if (topologyOnly) process.env.NAV_TRANSITIONS = "0";

async function main() {
  const { hasDetourSuccess, NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");
  const config = loadNavigationValidationConfig(configPath);
  nav.streamAround(
    config.regions.flatMap((region) =>
      region.anchors.map((anchor) => new Float32Array([...anchor.position, 1]))
    )
  );

  const adapter: NavigationProbeAdapter = {
    snap(position, halfExtents) {
      const nearest = nav.navMeshQuery.findNearestPoly(position, {
        halfExtents
      });
      if (!nearest.nearestRef) {
        return { ref: 0, point: position, area: null };
      }
      let area: number | null = null;
      const result = nav.navmesh.getPolyArea(nearest.nearestRef);
      if (hasDetourSuccess(result.status)) area = result.area;
      return {
        ref: nearest.nearestRef,
        point: nearest.nearestPoint,
        area
      };
    },
    path(from, to, halfExtents) {
      const start = nav.navMeshQuery.findNearestPoly(from, { halfExtents });
      const end = nav.navMeshQuery.findNearestPoly(to, { halfExtents });
      if (!start.nearestRef || !end.nearestRef) return [];

      const corridor = nav.navMeshQuery.findPath(
        start.nearestRef,
        end.nearestRef,
        start.nearestPoint,
        end.nearestPoint,
        { maxPathPolys: MAX_PATH_POLYS }
      );
      try {
        if (!corridor.success || corridor.polys.size === 0) return [];
        const lastRef = corridor.polys.get(corridor.polys.size - 1);
        let closestEnd: NavigationProbePoint = end.nearestPoint;
        if (lastRef !== end.nearestRef) {
          const closest = nav.navMeshQuery.closestPointOnPoly(
            lastRef,
            end.nearestPoint
          );
          if (!closest.success) return [];
          closestEnd = closest.closestPoint;
        }

        // The default Detour straight path only reports turning corners. On a
        // straight stair that compresses the whole rise into one apparent
        // vertical jump, while a bogus elevator edge can look identical. Emit
        // every polygon crossing so the topology gate measures the actual
        // baked corridor rather than its string-pulled presentation.
        const straight = nav.navMeshQuery.findStraightPath(
          start.nearestPoint,
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
          return points;
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
    configSha256: createHash("sha256")
      .update(readFileSync(configPath))
      .digest("hex"),
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
