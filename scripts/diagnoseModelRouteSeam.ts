import { join, resolve } from "node:path";
import { modelRouteEndpointGap } from "../src/utils/modelroutevalidation";
import { extractNavigationTopology } from "../src/utils/navigationislandaudit";
import { loadNavigationRuntime } from "../src/utils/navigationruntime";

type Point = { x: number; y: number; z: number };
type PolygonGeometry = { ref: number; vertices: Point[] };

function normalizedRuntimeRef(ref: number | bigint): number {
  const normalized = typeof ref === "bigint" ? Number(ref) : ref >>> 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0)
    throw new Error(`Detour polygon reference is not a safe integer: ${ref}`);
  return normalized;
}

function polygonRefFromBase(base: number | bigint, polygonIndex: number) {
  return normalizedRuntimeRef(
    typeof base === "bigint" ? base + BigInt(polygonIndex) : base + polygonIndex
  );
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePoint(raw: string | undefined, label: string): Point {
  const values = raw?.split(",").map(Number) ?? [];
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must be x,y,z`);
  }
  return { x: values[0], y: values[1], z: values[2] };
}

function subtract(left: Point, right: Point): Point {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z
  };
}

function addScaled(origin: Point, direction: Point, scale: number): Point {
  return {
    x: origin.x + direction.x * scale,
    y: origin.y + direction.y * scale,
    z: origin.z + direction.z * scale
  };
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

// Closest points on two finite 3D segments, adapted from the standard
// Real-Time Collision Detection segment/segment calculation.
function closestSegmentPoints(
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point
): { first: Point; second: Point; distance: number } {
  const epsilon = 1e-9;
  const firstDirection = subtract(firstEnd, firstStart);
  const secondDirection = subtract(secondEnd, secondStart);
  const offset = subtract(firstStart, secondStart);
  const firstLength = dot(firstDirection, firstDirection);
  const secondLength = dot(secondDirection, secondDirection);
  const directionDot = dot(firstDirection, secondDirection);
  const firstOffsetDot = dot(firstDirection, offset);
  const secondOffsetDot = dot(secondDirection, offset);
  let firstAmount = 0;
  let secondAmount = 0;

  if (firstLength <= epsilon && secondLength <= epsilon) {
    // Both segments collapse to points.
  } else if (firstLength <= epsilon) {
    secondAmount = Math.max(0, Math.min(1, secondOffsetDot / secondLength));
  } else {
    if (secondLength <= epsilon) {
      firstAmount = Math.max(0, Math.min(1, -firstOffsetDot / firstLength));
    } else {
      const denominator = firstLength * secondLength - directionDot ** 2;
      if (denominator !== 0) {
        firstAmount = Math.max(
          0,
          Math.min(
            1,
            (directionDot * secondOffsetDot - firstOffsetDot * secondLength) /
              denominator
          )
        );
      }
      secondAmount =
        (directionDot * firstAmount + secondOffsetDot) / secondLength;
      if (secondAmount < 0) {
        secondAmount = 0;
        firstAmount = Math.max(0, Math.min(1, -firstOffsetDot / firstLength));
      } else if (secondAmount > 1) {
        secondAmount = 1;
        firstAmount = Math.max(
          0,
          Math.min(1, (directionDot - firstOffsetDot) / firstLength)
        );
      }
    }
  }

  const first = addScaled(firstStart, firstDirection, firstAmount);
  const second = addScaled(secondStart, secondDirection, secondAmount);
  return { first, second, distance: modelRouteEndpointGap(first, second) };
}

function polygonEdges(vertices: Point[]): Array<[Point, Point]> {
  return vertices.map((vertex, index) => [
    vertex,
    vertices[(index + 1) % vertices.length]
  ]);
}

function extractPolygonGeometry(navMesh: {
  getMaxTiles(): number;
  getTile(index: number): any;
  getTileRefAt(x: number, y: number, layer: number): number | bigint;
}): Map<number, PolygonGeometry> {
  const result = new Map<number, PolygonGeometry>();
  for (let tileIndex = 0; tileIndex < navMesh.getMaxTiles(); tileIndex++) {
    const tile = navMesh.getTile(tileIndex);
    const header = tile.header();
    if (!header) continue;
    for (
      let polygonIndex = 0;
      polygonIndex < header.polyCount();
      polygonIndex++
    ) {
      const polygon = tile.polys(polygonIndex);
      if (polygon.getType() === 1) continue;
      const vertices: Point[] = [];
      for (let index = 0; index < polygon.vertCount(); index++) {
        const base = polygon.verts(index) * 3;
        vertices.push({
          x: tile.verts(base),
          y: tile.verts(base + 1),
          z: tile.verts(base + 2)
        });
      }
      const ref = polygonRefFromBase(
        navMesh.getTileRefAt(header.x(), header.y(), header.layer()),
        polygonIndex
      );
      result.set(ref, { ref, vertices });
    }
  }
  return result;
}

function reachable(
  start: string,
  outgoing: Map<string, string[]>
): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) pending.push(next);
  }
  return visited;
}

const cacheDirectory = process.argv[2];
const start = parsePoint(option("--start"), "--start");
const end = parsePoint(option("--end"), "--end");
const transitions = option("--transitions");
const verticalBand = Number(option("--vertical-band") ?? 0.75);
const snapHorizontal = Number(option("--snap-horizontal") ?? 0.8);
const runtime64Root = option("--runtime64-root");
const limit = Number(option("--limit") ?? 12);
if (
  !cacheDirectory ||
  !Number.isFinite(verticalBand) ||
  !Number.isFinite(snapHorizontal) ||
  snapHorizontal <= 0 ||
  !Number.isInteger(limit) ||
  limit <= 0
) {
  throw new Error(
    "Usage: npx tsx scripts/diagnoseModelRouteSeam.ts <cache-dir> --start x,y,z --end x,y,z [--transitions file] [--vertical-band 0.75] [--snap-horizontal 0.8] [--limit 12] [--runtime64-root directory]"
  );
}

async function main() {
  process.env.NAV_STREAMING = "1";
  process.env.NAV_CACHE_DIR = resolve(cacheDirectory);
  if (transitions) process.env.NAV_TRANSITIONS_PATH = resolve(transitions);
  const useRuntime64 = runtime64Root !== undefined;
  if (useRuntime64) {
    const root = resolve(runtime64Root);
    process.env.NAV_MONOLITHIC_64 = "1";
    await loadNavigationRuntime({
      mode: "monolithic64",
      coreModule: join(root, "core.mjs"),
      wasmModule: join(root, "wasm-compat.mjs")
    });
  } else {
    await loadNavigationRuntime({ mode: "stock" });
  }
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await (
    nav as unknown as { loadNavStreaming(): Promise<void> }
  ).loadNavStreaming(useRuntime64);
  nav.streamAround([
    new Float32Array([start.x, start.y, start.z, 1]),
    new Float32Array([end.x, end.y, end.z, 1])
  ]);

  const queryOptions = {
    halfExtents: { x: snapHorizontal, y: 1.5, z: snapHorizontal }
  };
  const startSnap = nav.navMeshQuery.findNearestPoly(start, queryOptions);
  const endSnap = nav.navMeshQuery.findNearestPoly(end, queryOptions);
  if (!startSnap.nearestRef || !endSnap.nearestRef) {
    throw new Error("route endpoints do not both snap to the streamed navmesh");
  }
  const path = nav.navMeshQuery.computePath(
    startSnap.nearestPoint,
    endSnap.nearestPoint,
    queryOptions
  );
  const lastPathPoint = path.path?.at(-1);
  const directGap = lastPathPoint
    ? modelRouteEndpointGap(lastPathPoint, endSnap.nearestPoint)
    : Number.POSITIVE_INFINITY;
  if (directGap <= 0.25) {
    console.log(
      JSON.stringify(
        {
          connected: true,
          snapHorizontal,
          startSnap,
          endSnap,
          path: path.path ?? [],
          endpointGap: directGap,
          candidateSeams: []
        },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2
      )
    );
    return;
  }
  const topology = extractNavigationTopology(nav.navmesh);
  const byRef = new Map(
    topology.polygons.map((polygon) => [
      normalizedRuntimeRef(polygon.ref),
      polygon
    ])
  );
  const startPolygon = byRef.get(
    normalizedRuntimeRef(startSnap.nearestRef as number | bigint)
  );
  const endPolygon = byRef.get(
    normalizedRuntimeRef(endSnap.nearestRef as number | bigint)
  );
  if (!startPolygon || !endPolygon)
    throw new Error(
      `snapped polygon missing from topology (start=${startSnap.nearestRef}, end=${endSnap.nearestRef}, sample=${[...byRef.keys()].slice(0, 8).join(",")})`
    );
  const outgoing = new Map(
    topology.polygons.map((polygon) => [polygon.id, polygon.outgoing])
  );
  const fromStart = reachable(startPolygon.id, outgoing);
  const fromEnd = reachable(endPolygon.id, outgoing);
  const geometry = extractPolygonGeometry(nav.navmesh as any);
  const levelY = (startSnap.nearestPoint.y + endSnap.nearestPoint.y) / 2;
  const eligible = (id: string, component: Set<string>) => {
    if (!component.has(id)) return false;
    const polygon = topology.polygons.find((entry) => entry.id === id);
    return (
      polygon &&
      !polygon.offMesh &&
      polygon.bounds.min[1] <= levelY + verticalBand &&
      polygon.bounds.max[1] >= levelY - verticalBand
    );
  };
  const firstPolygons = topology.polygons.filter((polygon) =>
    eligible(polygon.id, fromStart)
  );
  const secondPolygons = topology.polygons.filter((polygon) =>
    eligible(polygon.id, fromEnd)
  );
  const candidates: Array<Record<string, unknown>> = [];
  if (!fromStart.has(endPolygon.id)) {
    for (const firstPolygon of firstPolygons) {
      const firstGeometry = geometry.get(
        normalizedRuntimeRef(firstPolygon.ref)
      );
      if (!firstGeometry) continue;
      for (const secondPolygon of secondPolygons) {
        const secondGeometry = geometry.get(
          normalizedRuntimeRef(secondPolygon.ref)
        );
        if (!secondGeometry) continue;
        let closest: ReturnType<typeof closestSegmentPoints> | undefined;
        for (const [firstEdgeStart, firstEdgeEnd] of polygonEdges(
          firstGeometry.vertices
        )) {
          for (const [secondEdgeStart, secondEdgeEnd] of polygonEdges(
            secondGeometry.vertices
          )) {
            const pair = closestSegmentPoints(
              firstEdgeStart,
              firstEdgeEnd,
              secondEdgeStart,
              secondEdgeEnd
            );
            if (!closest || pair.distance < closest.distance) closest = pair;
          }
        }
        if (closest) {
          candidates.push({
            distance: Number(closest.distance.toFixed(6)),
            startPolygon: firstPolygon.id,
            endPolygon: secondPolygon.id,
            startCentroid: firstPolygon.centroid,
            endCentroid: secondPolygon.centroid,
            start: closest.first,
            end: closest.second
          });
        }
      }
    }
  }

  const last = path.path?.at(-1);
  console.log(
    JSON.stringify(
      {
        connected: fromStart.has(endPolygon.id),
        snapHorizontal,
        startSnap,
        endSnap,
        path: path.path ?? [],
        endpointGap: last
          ? modelRouteEndpointGap(last, endSnap.nearestPoint)
          : null,
        startComponentPolygons: fromStart.size,
        endComponentPolygons: fromEnd.size,
        sameLevelStartPolygons: firstPolygons.length,
        sameLevelEndPolygons: secondPolygons.length,
        candidateSeams: candidates
          .sort((left, right) => Number(left.distance) - Number(right.distance))
          .slice(0, limit)
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
