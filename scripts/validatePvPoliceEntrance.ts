import { resolve } from "node:path";

const cacheDir = process.argv[2];
const includePaths = process.argv.includes("--paths");
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validatePvPoliceEntrance.ts <cache-dir>"
  );
  process.exit(1);
}

const samples = {
  road: [-222, 22.93, -1157],
  landing: [-222, 25.22, -1165],
  doorRoadSide: [-225.99, 25.48, -1159.13],
  doorInteriorSide: [-225.99, 25.48, -1165.13],
  interior: [-236.22, 25.47, -1149.2]
} as const;

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([new Float32Array([...samples.road, 1])]);

  const query = nav.navMeshQuery;
  const extents = { halfExtents: { x: 2, y: 0.75, z: 2 } };
  const snapped = Object.fromEntries(
    Object.entries(samples).map(([name, [x, y, z]]) => {
      const nearest = query.findNearestPoly({ x, y, z }, extents);
      return [name, { ref: nearest.nearestRef, point: nearest.nearestPoint }];
    })
  ) as Record<
    string,
    { ref: number; point: { x: number; y: number; z: number } }
  >;

  const segment = (from: string, to: string) => {
    if (!snapped[from].ref || !snapped[to].ref) {
      return {
        success: false,
        reached: false,
        corners: 0,
        last: null,
        path: []
      };
    }
    const result = query.computePath(
      snapped[from].point,
      snapped[to].point,
      extents
    );
    const last = result.path?.[result.path.length - 1];
    const pathLength = (result.path ?? [])
      .slice(1)
      .reduce((total, point, index) => {
        const previous = result.path![index];
        return (
          total +
          Math.hypot(
            point.x - previous.x,
            point.y - previous.y,
            point.z - previous.z
          )
        );
      }, 0);
    const directLength = Math.hypot(
      snapped[to].point.x - snapped[from].point.x,
      snapped[to].point.y - snapped[from].point.y,
      snapped[to].point.z - snapped[from].point.z
    );
    return {
      success: result.success,
      reached: Boolean(
        last &&
        Math.hypot(
          last.x - snapped[to].point.x,
          last.y - snapped[to].point.y,
          last.z - snapped[to].point.z
        ) < 1
      ),
      corners: result.path?.length ?? 0,
      pathLength,
      directLength,
      detourRatio: directLength ? pathLength / directLength : 0,
      last: last ?? null,
      path: result.path ?? []
    };
  };

  const segments = {
    roadToLanding: segment("road", "landing"),
    roadToDoorRoadSide: segment("road", "doorRoadSide"),
    doorThreshold: segment("doorRoadSide", "doorInteriorSide"),
    doorInteriorToInterior: segment("doorInteriorSide", "interior"),
    landingToInterior: segment("landing", "interior"),
    roadToInterior: segment("road", "interior")
  };
  const reportedSegments = Object.fromEntries(
    Object.entries(segments).map(([name, value]) => [
      name,
      includePaths ? value : { ...value, path: undefined }
    ])
  );
  console.log(
    JSON.stringify(
      { cacheDir: resolve(cacheDir), snapped, segments: reportedSegments },
      null,
      2
    )
  );

  if (
    Object.values(snapped).some(({ ref }) => !ref) ||
    Object.values(segments).some(({ reached }) => !reached) ||
    !segments.doorThreshold.detourRatio ||
    segments.doorThreshold.detourRatio > 2.5
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
