import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateNavigationValidation,
  loadNavigationValidationConfig,
  NavigationProbeAdapter
} from "../src/utils/navigationvalidation";

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
    config.regions.map(
      (region) => new Float32Array([...region.anchors[0].position, 1])
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
      const result = nav.navMeshQuery.computePath(from, to, { halfExtents });
      return result.success ? (result.path ?? []) : [];
    }
  };
  const report = evaluateNavigationValidation(config, adapter);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), serialized);
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
