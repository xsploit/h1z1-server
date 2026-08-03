import { resolve } from "node:path";
import type { NavMeshQuery } from "recast-navigation";

type Point = { x: number; y: number; z: number };

const cachePath = process.argv[2];
if (!cachePath) {
  console.error(
    "Usage: npx tsx scripts/validateHouse34BDoors.ts <cache-dir> [representative|127141]"
  );
  process.exit(1);
}

const representative = {
  front: {
    name: "front",
    start: { x: -2740.8447265625, y: 48.3000030518, z: 50.1675453186 },
    end: { x: -2739.8447265625, y: 48.3000030518, z: 50.1675453186 },
    obstacle: {
      position: {
        x: -2740.244873046875,
        y: 48.2294921875,
        z: 49.65797805786133
      },
      halfExtents: { x: 0.7, y: 1.4, z: 0.12 },
      angle: Math.PI / 2
    }
  },

  southwest: {
    name: "southwest",
    start: { x: -2741.939697265625, y: 48.3000030518, z: 46.4005470276 },
    end: { x: -2739.9267578125, y: 48.3000030518, z: 45.5005455017 },
    obstacle: {
      position: {
        x: -2740.326904296875,
        y: 48.20414733886719,
        z: 45.17213821411133
      },
      halfExtents: { x: 0.7, y: 1.4, z: 0.12 },
      angle: Math.PI / 2
    }
  },
  wallRays: [
    {
      name: "front-wall-north",
      start: { x: -2740.95, y: 48.3, z: 51.55 },
      end: { x: -2739.55, y: 48.3, z: 51.55 }
    },
    {
      name: "front-wall-south",
      start: { x: -2740.95, y: 48.3, z: 48.55 },
      end: { x: -2739.55, y: 48.3, z: 48.55 }
    }
  ]
};

const scenarios = {
  representative,
  "127141": {
    front: {
      name: "front-127141",
      start: { x: -264.331279, y: 41.573986, z: -813.773826 },
      end: { x: -263.331317, y: 41.573986, z: -813.7651 },
      obstacle: {
        position: {
          x: -263.72700084,
          y: 41.50347518,
          z: -814.27813957
        },
        halfExtents: { x: 0.7, y: 1.4, z: 0.12 },
        angle: Math.PI / 2 - Math.PI / 360
      }
    },
    southwest: {
      name: "southwest-127141",
      start: { x: -265.393335, y: 41.573986, z: -817.550237 },
      end: { x: -263.372618, y: 41.573986, z: -818.432638 },
      obstacle: {
        position: {
          x: -263.76988385,
          y: 41.47813029,
          z: -818.7645241
        },
        halfExtents: { x: 0.7, y: 1.4, z: 0.12 },
        angle: Math.PI / 2 - Math.PI / 360
      }
    },
    wallRays: [
      {
        name: "front-wall-north-127141",
        start: { x: -264.44861247, y: 41.573986, z: -812.39234263 },
        end: { x: -263.04866578, y: 41.573986, z: -812.38012548 }
      },
      {
        name: "front-wall-south-127141",
        start: { x: -264.42243286, y: 41.573986, z: -815.3922284 },
        end: { x: -263.02248617, y: 41.573986, z: -815.38001125 }
      }
    ]
  }
} as const;

const scenarioName = process.argv[3] ?? "representative";
if (!(scenarioName in scenarios)) {
  throw new Error(`unknown House34B scenario: ${scenarioName}`);
}
const scenario = scenarios[scenarioName as keyof typeof scenarios];
const { front, southwest } = scenario;

function routeGap(query: NavMeshQuery, start: Point, end: Point) {
  const nearestOptions = { halfExtents: { x: 0.8, y: 1.5, z: 0.8 } };
  const startSnap = query.findNearestPoly(start, nearestOptions);
  const endSnap = query.findNearestPoly(end, nearestOptions);
  if (!startSnap.nearestRef || !endSnap.nearestRef) {
    return {
      gap: Number.POSITIVE_INFINITY,
      points: 0,
      startRef: startSnap.nearestRef,
      endRef: endSnap.nearestRef
    };
  }
  const path = query.computePath(
    startSnap.nearestPoint,
    endSnap.nearestPoint,
    nearestOptions
  );
  const last = path.path?.at(-1);
  return {
    gap: last
      ? Math.hypot(
          last.x - endSnap.nearestPoint.x,
          last.z - endSnap.nearestPoint.z
        )
      : Number.POSITIVE_INFINITY,
    points: path.path?.length ?? 0,
    startRef: startSnap.nearestRef,
    endRef: endSnap.nearestRef
  };
}

function rayProbe(query: NavMeshQuery, start: Point, end: Point) {
  const nearestOptions = { halfExtents: { x: 0.45, y: 1.5, z: 0.45 } };
  const startSnap = query.findNearestPoly(start, nearestOptions);
  const endSnap = query.findNearestPoly(end, nearestOptions);
  if (!startSnap.nearestRef || !endSnap.nearestRef) {
    return {
      t: null,
      startGap: Number.POSITIVE_INFINITY,
      endGap: Number.POSITIVE_INFINITY
    };
  }
  const ray = query.raycast(
    startSnap.nearestRef,
    startSnap.nearestPoint,
    endSnap.nearestPoint
  );
  return {
    t: ray.success ? ray.t : null,
    startGap: Math.hypot(
      startSnap.nearestPoint.x - start.x,
      startSnap.nearestPoint.z - start.z
    ),
    endGap: Math.hypot(
      endSnap.nearestPoint.x - end.x,
      endSnap.nearestPoint.z - end.z
    )
  };
}

async function main() {
  process.env.NAV_STREAMING = "1";
  process.env.NAV_CACHE_DIR = resolve(cachePath);
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([
    new Float32Array([front.start.x, front.start.y, front.start.z, 1])
  ]);
  const query = nav.navMeshQuery;
  const results = [];
  let offMeshConnections = 0;
  for (let index = 0; index < nav.navmesh.getMaxTiles(); index++) {
    offMeshConnections +=
      nav.navmesh.getTile(index).header()?.offMeshConCount() ?? 0;
  }
  const wallRays = scenario.wallRays.map((probe) => ({
    ...probe,
    ...rayProbe(query, probe.start, probe.end)
  }));
  const settleObstacleRequests = (operation: string) => {
    for (let i = 0; i < 8 && nav.obstaclesRequestsPending; i++) nav.updt();
    if (nav.obstaclesRequestsPending) {
      throw new Error(`${operation}: tile-cache rebuild did not settle`);
    }
  };

  for (const doorway of [front, southwest]) {
    const open = routeGap(query, doorway.start, doorway.end);
    const added = nav.addObstacle(
      new Float32Array([
        doorway.obstacle.position.x,
        doorway.obstacle.position.y,
        doorway.obstacle.position.z,
        1
      ]),
      doorway.obstacle.halfExtents,
      doorway.obstacle.angle
    );
    if (!added) throw new Error(`${doorway.name}: obstacle add failed`);
    settleObstacleRequests(`${doorway.name}: close`);
    const closed = routeGap(query, doorway.start, doorway.end);
    nav.removeObstacle(added);
    settleObstacleRequests(`${doorway.name}: reopen`);
    const reopened = routeGap(query, doorway.start, doorway.end);
    const readded = nav.addObstacle(
      new Float32Array([
        doorway.obstacle.position.x,
        doorway.obstacle.position.y,
        doorway.obstacle.position.z,
        1
      ]),
      doorway.obstacle.halfExtents,
      doorway.obstacle.angle
    );
    if (!readded) throw new Error(`${doorway.name}: obstacle re-add failed`);
    settleObstacleRequests(`${doorway.name}: reclose`);
    const reclosed = routeGap(query, doorway.start, doorway.end);
    nav.removeObstacle(readded);
    settleObstacleRequests(`${doorway.name}: final cleanup`);
    results.push({ name: doorway.name, open, closed, reopened, reclosed });
  }

  console.log(
    JSON.stringify({ offMeshConnections, doors: results, wallRays }, null, 2)
  );
  if (offMeshConnections !== 0) {
    throw new Error(
      `House34B fixture contains ${offMeshConnections} unsafe off-mesh connection(s)`
    );
  }
  for (const result of results) {
    if (result.open.gap > 0.25 || result.reopened.gap > 0.25) {
      throw new Error(`${result.name}: doorway is not traversable while open`);
    }
    if (result.closed.gap <= 0.25 || result.reclosed.gap <= 0.25) {
      throw new Error(
        `${result.name}: closed door obstacle did not block traversal`
      );
    }
  }
  for (const wall of wallRays) {
    if (wall.startGap > 0.25 || wall.endGap > 0.25) {
      throw new Error(
        `${wall.name}: wall probe snapped away from its endpoints`
      );
    }
    if (wall.t === null || wall.t >= 1) {
      throw new Error(`${wall.name}: adjacent wall probe was not blocked`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
