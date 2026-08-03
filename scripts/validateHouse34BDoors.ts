import { resolve } from "node:path";
import type { NavMeshQuery } from "recast-navigation";

type Point = { x: number; y: number; z: number };

const cachePath = process.argv[2];
if (!cachePath) {
  console.error("Usage: npx tsx scripts/validateHouse34BDoors.ts <cache-dir>");
  process.exit(1);
}

const front = {
  name: "front",
  start: { x: -2740.8447265625, y: 48.3000030518, z: 50.1675453186 },
  end: { x: -2739.8447265625, y: 48.3000030518, z: 50.1675453186 },
  obstacle: {
    position: { x: -2740.244873046875, y: 48.2294921875, z: 49.65797805786133 },
    halfExtents: { x: 0.7, y: 1.4, z: 0.12 },
    angle: Math.PI / 2
  }
};

const southwest = {
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
};

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

function rayFraction(query: NavMeshQuery, start: Point, end: Point) {
  const nearestOptions = { halfExtents: { x: 0.45, y: 1.5, z: 0.45 } };
  const startSnap = query.findNearestPoly(start, nearestOptions);
  const endSnap = query.findNearestPoly(end, nearestOptions);
  if (!startSnap.nearestRef || !endSnap.nearestRef) return null;
  const ray = query.raycast(
    startSnap.nearestRef,
    startSnap.nearestPoint,
    endSnap.nearestPoint
  );
  return ray.success ? ray.t : null;
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
  const wallRays = [
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
  ].map((probe) => ({
    ...probe,
    t: rayFraction(query, probe.start, probe.end)
  }));

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
    for (let i = 0; i < 8 && nav.obstaclesRequestsPending; i++) nav.updt();
    const closed = routeGap(query, doorway.start, doorway.end);
    nav.removeObstacle(added);
    for (let i = 0; i < 8 && nav.obstaclesRequestsPending; i++) nav.updt();
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
    for (let i = 0; i < 8 && nav.obstaclesRequestsPending; i++) nav.updt();
    const reclosed = routeGap(query, doorway.start, doorway.end);
    nav.removeObstacle(readded);
    for (let i = 0; i < 8 && nav.obstaclesRequestsPending; i++) nav.updt();
    results.push({ name: doorway.name, open, closed, reopened, reclosed });
  }

  console.log(JSON.stringify({ doors: results, wallRays }, null, 2));
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
    if (wall.t === null || wall.t >= 1) {
      throw new Error(`${wall.name}: adjacent wall probe was not blocked`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
