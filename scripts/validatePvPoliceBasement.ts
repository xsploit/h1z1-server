import { resolve } from "node:path";

const cacheDir = process.argv[2];
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validatePvPoliceBasement.ts <cache-dir>"
  );
  process.exit(1);
}

// Authored NPC/door positions from Z1_npcs.json and Z1_doors.json.
const samples = [
  { name: "basement-west", position: [-238.44, 22.22, -1159.9] },
  { name: "basement-center", position: [-235.28, 22.22, -1152.39] },
  { name: "basement-east", position: [-232.37, 22.22, -1144.76] },
  { name: "basement-door", position: [-234.25, 22.25, -1162.28] },
  { name: "ground-floor", position: [-236.22, 25.47, -1149.2] },
  { name: "second-floor", position: [-235.84, 28.68, -1153.33] }
] as const;

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");

  nav.streamAround([
    new Float32Array([
      samples[1].position[0],
      samples[1].position[1],
      samples[1].position[2],
      1
    ])
  ]);

  const query = nav.navMeshQuery;
  const results = samples.map(({ name, position: [x, y, z] }) => {
    const tight = query.findNearestPoly(
      { x, y, z },
      { halfExtents: { x: 2, y: 1.25, z: 2 } }
    );
    const floorWide = query.findNearestPoly(
      { x, y, z },
      { halfExtents: { x: 10, y: 1.25, z: 10 } }
    );
    const wide = query.findNearestPoly(
      { x, y, z },
      { halfExtents: { x: 10, y: 10, z: 10 } }
    );
    return {
      name,
      authored: { x, y, z },
      tight: {
        ref: tight.nearestRef,
        point: tight.nearestPoint,
        deltaY: tight.nearestRef ? tight.nearestPoint.y - y : null
      },
      floorWide: {
        ref: floorWide.nearestRef,
        point: floorWide.nearestPoint,
        deltaY: floorWide.nearestRef ? floorWide.nearestPoint.y - y : null
      },
      wide: {
        ref: wide.nearestRef,
        point: wide.nearestPoint,
        deltaY: wide.nearestRef ? wide.nearestPoint.y - y : null
      }
    };
  });

  console.log(JSON.stringify(results, null, 2));

  const missingFloorWide = results.filter((result) => !result.floorWide.ref);
  const crossFloorWideSnap = results.filter(
    (result) =>
      result.wide.ref &&
      result.wide.deltaY !== null &&
      Math.abs(result.wide.deltaY) > 1.5
  );
  console.log(
    JSON.stringify(
      {
        missingFloorWide: missingFloorWide.map((result) => result.name),
        crossFloorWideSnap: crossFloorWideSnap.map((result) => result.name)
      },
      null,
      2
    )
  );

  const productionResults = samples.map(
    ({ name, position: [x, y, z] }) => {
      const gamePosition = new Float32Array([x, y, z, 1]);
      const target = nav.getClosestNavPointVec3(gamePosition);
      const agent = nav.createAgent(gamePosition);
      const result = {
        name,
        targetDeltaY: target.y - y,
        agentCreated: Boolean(agent)
      };
      if (agent) nav.removeAgent(agent);
      return result;
    }
  );
  console.log(JSON.stringify({ productionResults }, null, 2));

  const basementToGround = query.computePath(
    results[1].floorWide.point,
    results[4].floorWide.point,
    { halfExtents: { x: 2, y: 0.75, z: 2 } }
  );
  const basementToGroundLast =
    basementToGround.path?.[basementToGround.path.length - 1];
  const basementToGroundReached = Boolean(
    basementToGroundLast &&
      Math.hypot(
        basementToGroundLast.x - results[4].floorWide.point.x,
        basementToGroundLast.y - results[4].floorWide.point.y,
        basementToGroundLast.z - results[4].floorWide.point.z
      ) < 2
  );
  console.log(
    JSON.stringify(
      {
        basementToGround: {
          success: basementToGround.success,
          reached: basementToGroundReached,
          corners: basementToGround.path?.length ?? 0,
          path: basementToGround.path
        }
      },
      null,
      2
    )
  );

  const sampleFloor = (y: number) => {
    const points = new Map<number, { x: number; y: number; z: number }>();
    for (let x = -245; x <= -220; x += 1) {
      for (let z = -1167; z <= -1137; z += 1) {
        const snap = query.findNearestPoly(
          { x, y, z },
          { halfExtents: { x: 0.45, y: 0.75, z: 0.45 } }
        );
        if (snap.nearestRef) points.set(snap.nearestRef, snap.nearestPoint);
      }
    }
    return [...points.values()];
  };
  const basementPoints = sampleFloor(22.25);
  const groundPoints = sampleFloor(25.46);
  let reachableGroundPoints = 0;
  for (const target of groundPoints) {
    const path = query.computePath(
      results[1].floorWide.point,
      target,
      { halfExtents: { x: 1, y: 0.75, z: 1 } }
    );
    const last = path.path?.[path.path.length - 1];
    if (
      last &&
      Math.hypot(
        last.x - target.x,
        last.y - target.y,
        last.z - target.z
      ) < 1
    ) {
      reachableGroundPoints++;
    }
  }
  let closestFloorPair:
    | {
        distance: number;
        basement: { x: number; y: number; z: number };
        ground: { x: number; y: number; z: number };
      }
    | undefined;
  for (const basement of basementPoints) {
    for (const ground of groundPoints) {
      const distance = Math.hypot(
        basement.x - ground.x,
        basement.z - ground.z
      );
      if (!closestFloorPair || distance < closestFloorPair.distance) {
        closestFloorPair = { distance, basement, ground };
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        floorConnectivity: {
          basementPolys: basementPoints.length,
          groundPolys: groundPoints.length,
          reachableGroundPoints,
          closestFloorPair
        }
      },
      null,
      2
    )
  );

  const pathReaches = (
    start: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number }
  ) => {
    const result = query.computePath(start, target, {
      halfExtents: { x: 1, y: 0.75, z: 1 }
    });
    const last = result.path?.[result.path.length - 1];
    return {
      success: result.success,
      reached: Boolean(
        last &&
          Math.hypot(
            last.x - target.x,
            last.y - target.y,
            last.z - target.z
          ) < 1
      ),
      corners: result.path?.length ?? 0,
      last
    };
  };
  const stairBottom = query.findNearestPoly(
    { x: -222, y: 22.93, z: -1157 },
    { halfExtents: { x: 1, y: 0.75, z: 1 } }
  ).nearestPoint;
  const stairTop = query.findNearestPoly(
    { x: -222, y: 25.22, z: -1165 },
    { halfExtents: { x: 1, y: 0.75, z: 1 } }
  ).nearestPoint;
  const stairSegments = {
    basementToStair: pathReaches(results[1].floorWide.point, stairBottom),
    stairConnection: pathReaches(stairBottom, stairTop),
    stairToGround: pathReaches(stairTop, results[4].floorWide.point)
  };
  console.log(JSON.stringify({ stairBottom, stairTop, stairSegments }, null, 2));

  const reachablePoints = (
    start: { x: number; y: number; z: number },
    candidates: { x: number; y: number; z: number }[]
  ) => candidates.filter((candidate) => pathReaches(start, candidate).reached);
  const pointBounds = (points: { x: number; y: number; z: number }[]) =>
    points.length
      ? {
          minX: Math.min(...points.map((point) => point.x)),
          maxX: Math.max(...points.map((point) => point.x)),
          minY: Math.min(...points.map((point) => point.y)),
          maxY: Math.max(...points.map((point) => point.y)),
          minZ: Math.min(...points.map((point) => point.z)),
          maxZ: Math.max(...points.map((point) => point.z))
        }
      : null;
  const centerComponent = reachablePoints(
    results[1].floorWide.point,
    basementPoints
  );
  const stairComponent = reachablePoints(stairBottom, basementPoints);
  console.log(
    JSON.stringify(
      {
        basementComponents: {
          center: {
            polygons: centerComponent.length,
            bounds: pointBounds(centerComponent)
          },
          stair: {
            polygons: stairComponent.length,
            bounds: pointBounds(stairComponent)
          }
        }
      },
      null,
      2
    )
  );

  const invalidProductionResult = productionResults.some(
    (result) =>
      !result.agentCreated ||
      !Number.isFinite(result.targetDeltaY) ||
      Math.abs(result.targetDeltaY) > 1.5
  );
  if (
    missingFloorWide.length ||
    invalidProductionResult ||
    !basementToGround.success ||
    !stairSegments.stairConnection.reached
  ) {
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        topologyReady:
          basementToGroundReached &&
          stairSegments.basementToStair.reached &&
          stairSegments.stairToGround.reached,
        note: basementToGroundReached
          ? "PV PD basement route is connected"
          : "PV PD contains disconnected authored interior islands"
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
