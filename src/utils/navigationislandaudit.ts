// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2026 H1emu community
//
// ======================================================================

import { createHash } from "node:crypto";
import type { NavMesh, NavMeshQuery, Vector3 } from "recast-navigation";

const DETOUR_NULL_LINK = 0xffffffff;

export const NAVIGATION_ISLAND_AUDIT_ALGORITHM =
  "detour-link-flood-bounded-centroid-v1";

export type NavigationAuditPoint = [number, number, number];

export type NavigationAuditBounds = {
  min: NavigationAuditPoint;
  max: NavigationAuditPoint;
};

export type NavigationAuditAnchor = {
  name: string;
  position: NavigationAuditPoint;
  halfExtents?: NavigationAuditPoint;
  maxHorizontalSnap?: number;
  maxVerticalSnap?: number;
  required?: boolean;
};

export type NavigationIslandAuditConfig = {
  name: string;
  bounds: NavigationAuditBounds;
  anchors: NavigationAuditAnchor[];
  includeFlags?: number;
  excludeFlags?: number;
  underFloorBelowY?: number;
  limits?: {
    maxUnreachableComponents?: number;
    maxUnreachablePolygons?: number;
    maxUnreachableSurfaceArea?: number;
    maxUnderFloorComponents?: number;
  };
};

export type NavigationTopologyPolygon = {
  id: string;
  ref: number;
  tile: [number, number, number];
  polygonIndex: number;
  offMesh: boolean;
  flags: number;
  area: number;
  centroid: NavigationAuditPoint;
  bounds: NavigationAuditBounds;
  surfaceArea: number;
  outgoing: string[];
};

export type NavigationTopologySnapshot = {
  polygons: NavigationTopologyPolygon[];
  unresolvedLinkCount: number;
};

export type ResolvedNavigationAuditAnchor = {
  name: string;
  required: boolean;
  valid: boolean;
  polygonId: string | null;
  snappedPoint: NavigationAuditPoint | null;
  horizontalSnap: number | null;
  verticalSnap: number | null;
  reasons: string[];
};

export type NavigationIslandComponentReport = {
  id: string;
  classification: "isolated" | "under-floor";
  polygonCount: number;
  surfaceArea: number;
  minY: number;
  maxY: number;
  meanY: number;
  polygonIds: string[];
};

export type NavigationIslandAuditReport = {
  schemaVersion: 1;
  algorithm: string;
  name: string;
  passed: boolean;
  reasons: string[];
  bounds: NavigationAuditBounds;
  filter: { includeFlags: number; excludeFlags: number };
  underFloorBelowY: number | null;
  anchors: ResolvedNavigationAuditAnchor[];
  stats: {
    contextPolygons: number;
    contextTraversablePolygons: number;
    auditedPolygons: number;
    reachableAuditedPolygons: number;
    unreachableAuditedPolygons: number;
    unreachableSurfaceArea: number;
    unreachableComponents: number;
    underFloorComponents: number;
    unresolvedLinks: number;
  };
  islands: NavigationIslandComponentReport[];
  provenance?: Record<string, unknown>;
};

type TopologyBuildPolygon = Omit<NavigationTopologyPolygon, "outgoing"> & {
  outgoingRefs: number[];
};

function finitePoint(point: NavigationAuditPoint): boolean {
  return point.length === 3 && point.every(Number.isFinite);
}

function normalizedRef(ref: number): number {
  return ref >>> 0;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function polygonArea3d(vertices: NavigationAuditPoint[]): number {
  if (vertices.length < 3) return 0;
  const origin = vertices[0];
  let area = 0;
  for (let index = 1; index < vertices.length - 1; index++) {
    const a = vertices[index];
    const b = vertices[index + 1];
    const ab = [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]];
    const ac = [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]];
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    ];
    area += Math.hypot(cross[0], cross[1], cross[2]) / 2;
  }
  return area;
}

function polygonId(
  tileX: number,
  tileY: number,
  tileLayer: number,
  polygonIndex: number
): string {
  return `${tileX},${tileY},${tileLayer}:${polygonIndex}`;
}

/**
 * Extracts the native Detour link graph without mutating polygon flags or the
 * streamed runtime. Polygon ids are based on authored tile coordinates rather
 * than transient Detour references, which makes reports stable across loads.
 */
export function extractNavigationTopology(
  navMesh: NavMesh
): NavigationTopologySnapshot {
  const byRef = new Map<number, TopologyBuildPolygon>();
  const maxTiles = navMesh.getMaxTiles();

  for (let tileIndex = 0; tileIndex < maxTiles; tileIndex++) {
    const tile = navMesh.getTile(tileIndex);
    const header = tile.header();
    if (!header) continue;
    for (
      let polygonIndex = 0;
      polygonIndex < header.polyCount();
      polygonIndex++
    ) {
      const poly = tile.polys(polygonIndex);
      const vertices: NavigationAuditPoint[] = [];
      for (let vertexIndex = 0; vertexIndex < poly.vertCount(); vertexIndex++) {
        const base = poly.verts(vertexIndex) * 3;
        vertices.push([
          tile.verts(base),
          tile.verts(base + 1),
          tile.verts(base + 2)
        ]);
      }
      if (!vertices.length) continue;

      const min: NavigationAuditPoint = [
        Math.min(...vertices.map((vertex) => vertex[0])),
        Math.min(...vertices.map((vertex) => vertex[1])),
        Math.min(...vertices.map((vertex) => vertex[2]))
      ];
      const max: NavigationAuditPoint = [
        Math.max(...vertices.map((vertex) => vertex[0])),
        Math.max(...vertices.map((vertex) => vertex[1])),
        Math.max(...vertices.map((vertex) => vertex[2]))
      ];
      const centroid: NavigationAuditPoint = [
        vertices.reduce((sum, vertex) => sum + vertex[0], 0) / vertices.length,
        vertices.reduce((sum, vertex) => sum + vertex[1], 0) / vertices.length,
        vertices.reduce((sum, vertex) => sum + vertex[2], 0) / vertices.length
      ];
      const ref = normalizedRef(
        navMesh.encodePolyId(tile.salt(), tileIndex, polygonIndex)
      );
      const outgoingRefs: number[] = [];
      const seenLinks = new Set<number>();
      let linkIndex = poly.firstLink() >>> 0;
      while (linkIndex !== DETOUR_NULL_LINK) {
        if (seenLinks.has(linkIndex)) {
          throw new Error(
            `[NAV] cyclic Detour link list at ${polygonId(header.x(), header.y(), header.layer(), polygonIndex)}`
          );
        }
        if (linkIndex >= header.maxLinkCount()) {
          throw new Error(
            `[NAV] invalid Detour link ${linkIndex} at ${polygonId(header.x(), header.y(), header.layer(), polygonIndex)}`
          );
        }
        seenLinks.add(linkIndex);
        const link = tile.links(linkIndex);
        const neighbour = normalizedRef(link.ref());
        if (neighbour) outgoingRefs.push(neighbour);
        linkIndex = link.next() >>> 0;
      }

      byRef.set(ref, {
        id: polygonId(header.x(), header.y(), header.layer(), polygonIndex),
        ref,
        tile: [header.x(), header.y(), header.layer()],
        polygonIndex,
        offMesh: poly.getType() === 1,
        flags: poly.flags(),
        area: navMesh.getPolyArea(ref).area,
        centroid,
        bounds: { min, max },
        surfaceArea: polygonArea3d(vertices),
        outgoingRefs
      });
    }
  }

  let unresolvedLinkCount = 0;
  const polygons = [...byRef.values()]
    .map(({ outgoingRefs, ...polygon }) => {
      const outgoing = [...new Set(outgoingRefs)]
        .map((ref) => byRef.get(ref)?.id)
        .filter((id): id is string => {
          if (!id) unresolvedLinkCount++;
          return Boolean(id);
        })
        .sort();
      return { ...polygon, outgoing };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return { polygons, unresolvedLinkCount };
}

export function assertNavigationIslandAuditConfig(
  config: NavigationIslandAuditConfig
): void {
  if (!config.name?.trim()) throw new Error("audit name is required");
  if (!finitePoint(config.bounds?.min) || !finitePoint(config.bounds?.max)) {
    throw new Error("audit bounds must contain finite min/max points");
  }
  if (
    config.bounds.min.some((value, index) => value >= config.bounds.max[index])
  ) {
    throw new Error("audit bounds min must be strictly less than max");
  }
  if (!Array.isArray(config.anchors) || !config.anchors.length) {
    throw new Error("audit requires at least one walkable anchor");
  }
  const names = new Set<string>();
  for (const anchor of config.anchors) {
    if (!anchor.name?.trim() || names.has(anchor.name)) {
      throw new Error(`invalid or duplicate anchor name: ${anchor.name}`);
    }
    names.add(anchor.name);
    if (!finitePoint(anchor.position)) {
      throw new Error(`anchor ${anchor.name} has an invalid position`);
    }
    const extents = anchor.halfExtents ?? [2, 2, 2];
    if (!finitePoint(extents) || extents.some((value) => value <= 0)) {
      throw new Error(`anchor ${anchor.name} has invalid half extents`);
    }
    for (const value of [anchor.maxHorizontalSnap, anchor.maxVerticalSnap]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`anchor ${anchor.name} has an invalid snap limit`);
      }
    }
  }
  if (
    config.underFloorBelowY !== undefined &&
    !Number.isFinite(config.underFloorBelowY)
  ) {
    throw new Error("underFloorBelowY must be finite");
  }
  for (const [name, value] of Object.entries(config.limits ?? {})) {
    if (!Number.isFinite(value) || value! < 0) {
      throw new Error(`audit limit ${name} must be finite and non-negative`);
    }
  }
}

export function resolveNavigationAuditAnchors(
  config: NavigationIslandAuditConfig,
  query: NavMeshQuery,
  topology: NavigationTopologySnapshot
): ResolvedNavigationAuditAnchor[] {
  assertNavigationIslandAuditConfig(config);
  const byRef = new Map(
    topology.polygons.map((polygon) => [normalizedRef(polygon.ref), polygon])
  );
  const includeFlags = config.includeFlags ?? 0xffff;
  const excludeFlags = config.excludeFlags ?? 0;

  return [...config.anchors]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((anchor) => {
      const position: Vector3 = {
        x: anchor.position[0],
        y: anchor.position[1],
        z: anchor.position[2]
      };
      const halfExtents = anchor.halfExtents ?? [2, 2, 2];
      const nearest = query.findNearestPoly(position, {
        halfExtents: {
          x: halfExtents[0],
          y: halfExtents[1],
          z: halfExtents[2]
        }
      });
      const polygon = byRef.get(normalizedRef(nearest.nearestRef));
      const reasons: string[] = [];
      if (!nearest.success || !nearest.nearestRef || !polygon) {
        reasons.push("no-navmesh-polygon");
      }
      if (polygon?.offMesh) reasons.push("nearest-polygon-is-off-mesh");
      if (
        polygon &&
        ((polygon.flags & includeFlags) === 0 ||
          (polygon.flags & excludeFlags) !== 0)
      ) {
        reasons.push("nearest-polygon-filtered");
      }

      let horizontalSnap: number | null = null;
      let verticalSnap: number | null = null;
      let snappedPoint: NavigationAuditPoint | null = null;
      if (nearest.nearestRef) {
        snappedPoint = [
          nearest.nearestPoint.x,
          nearest.nearestPoint.y,
          nearest.nearestPoint.z
        ];
        horizontalSnap = Math.hypot(
          nearest.nearestPoint.x - position.x,
          nearest.nearestPoint.z - position.z
        );
        verticalSnap = Math.abs(nearest.nearestPoint.y - position.y);
        if (horizontalSnap > (anchor.maxHorizontalSnap ?? halfExtents[0])) {
          reasons.push("horizontal-snap-limit");
        }
        if (verticalSnap > (anchor.maxVerticalSnap ?? halfExtents[1])) {
          reasons.push("vertical-snap-limit");
        }
      }

      return {
        name: anchor.name,
        required: anchor.required !== false,
        valid: reasons.length === 0,
        polygonId: polygon?.id ?? null,
        snappedPoint: snappedPoint?.map(round) as NavigationAuditPoint | null,
        horizontalSnap: horizontalSnap === null ? null : round(horizontalSnap),
        verticalSnap: verticalSnap === null ? null : round(verticalSnap),
        reasons
      };
    });
}

function centroidInBounds(
  centroid: NavigationAuditPoint,
  bounds: NavigationAuditBounds
): boolean {
  return centroid.every(
    (value, index) => value >= bounds.min[index] && value <= bounds.max[index]
  );
}

function canonicalComponentId(polygonIds: string[]): string {
  return createHash("sha256")
    .update(polygonIds.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function evaluateNavigationIslandAudit(
  config: NavigationIslandAuditConfig,
  topology: NavigationTopologySnapshot,
  anchors: ResolvedNavigationAuditAnchor[]
): NavigationIslandAuditReport {
  assertNavigationIslandAuditConfig(config);
  const includeFlags = config.includeFlags ?? 0xffff;
  const excludeFlags = config.excludeFlags ?? 0;
  const isTraversable = (polygon: NavigationTopologyPolygon) =>
    (polygon.flags & includeFlags) !== 0 &&
    (polygon.flags & excludeFlags) === 0;
  const byId = new Map(
    topology.polygons.map((polygon) => [polygon.id, polygon])
  );
  const traversable = new Set(
    topology.polygons.filter(isTraversable).map((polygon) => polygon.id)
  );

  const reachable = new Set<string>();
  const open = anchors
    .filter((anchor) => anchor.valid && anchor.polygonId)
    .map((anchor) => anchor.polygonId!)
    .sort()
    .reverse();
  while (open.length) {
    const id = open.pop()!;
    if (reachable.has(id) || !traversable.has(id)) continue;
    reachable.add(id);
    for (const neighbour of byId.get(id)?.outgoing ?? []) {
      if (!reachable.has(neighbour) && traversable.has(neighbour)) {
        open.push(neighbour);
      }
    }
    open.sort().reverse();
  }

  const audited = topology.polygons.filter(
    (polygon) =>
      !polygon.offMesh &&
      isTraversable(polygon) &&
      centroidInBounds(polygon.centroid, config.bounds)
  );
  const auditedIds = new Set(audited.map((polygon) => polygon.id));
  const unreachableAudited = audited.filter(
    (polygon) => !reachable.has(polygon.id)
  );

  // Weak adjacency groups a one-way topology defect into one diagnostic
  // component, while reachability above still respects Detour's direction.
  const weak = new Map<string, Set<string>>();
  for (const polygon of topology.polygons.filter(isTraversable)) {
    const neighbours = weak.get(polygon.id) ?? new Set<string>();
    weak.set(polygon.id, neighbours);
    for (const neighbour of polygon.outgoing) {
      if (!traversable.has(neighbour)) continue;
      neighbours.add(neighbour);
      const reverse = weak.get(neighbour) ?? new Set<string>();
      reverse.add(polygon.id);
      weak.set(neighbour, reverse);
    }
  }

  const assigned = new Set<string>();
  const islands: NavigationIslandComponentReport[] = [];
  for (const seed of unreachableAudited.map((polygon) => polygon.id).sort()) {
    if (assigned.has(seed)) continue;
    const componentContext = new Set<string>();
    const componentOpen = [seed];
    while (componentOpen.length) {
      const id = componentOpen.pop()!;
      if (componentContext.has(id) || reachable.has(id)) continue;
      componentContext.add(id);
      for (const neighbour of weak.get(id) ?? []) {
        if (!componentContext.has(neighbour) && !reachable.has(neighbour)) {
          componentOpen.push(neighbour);
        }
      }
    }
    const polygons = [...componentContext]
      .filter((id) => auditedIds.has(id))
      .map((id) => byId.get(id)!)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const polygon of polygons) assigned.add(polygon.id);
    if (!polygons.length) continue;
    const polygonIds = polygons.map((polygon) => polygon.id);
    const surfaceArea = polygons.reduce(
      (sum, polygon) => sum + polygon.surfaceArea,
      0
    );
    const weightedY = polygons.reduce(
      (sum, polygon) =>
        sum + polygon.centroid[1] * Math.max(polygon.surfaceArea, 1e-9),
      0
    );
    const minY = Math.min(...polygons.map((polygon) => polygon.bounds.min[1]));
    const maxY = Math.max(...polygons.map((polygon) => polygon.bounds.max[1]));
    islands.push({
      id: canonicalComponentId(polygonIds),
      classification:
        config.underFloorBelowY !== undefined && maxY < config.underFloorBelowY
          ? "under-floor"
          : "isolated",
      polygonCount: polygons.length,
      surfaceArea: round(surfaceArea),
      minY: round(minY),
      maxY: round(maxY),
      meanY: round(weightedY / Math.max(surfaceArea, 1e-9)),
      polygonIds
    });
  }
  islands.sort(
    (left, right) =>
      left.minY - right.minY ||
      left.maxY - right.maxY ||
      left.id.localeCompare(right.id)
  );

  const invalidRequiredAnchors = anchors.filter(
    (anchor) => anchor.required && !anchor.valid
  );
  const unreachableSurfaceArea = unreachableAudited.reduce(
    (sum, polygon) => sum + polygon.surfaceArea,
    0
  );
  const underFloorComponents = islands.filter(
    (island) => island.classification === "under-floor"
  ).length;
  const limits = {
    maxUnreachableComponents: config.limits?.maxUnreachableComponents ?? 0,
    maxUnreachablePolygons: config.limits?.maxUnreachablePolygons ?? 0,
    maxUnreachableSurfaceArea: config.limits?.maxUnreachableSurfaceArea ?? 0,
    maxUnderFloorComponents: config.limits?.maxUnderFloorComponents ?? 0
  };
  const reasons: string[] = invalidRequiredAnchors.map(
    (anchor) => `required-anchor-invalid:${anchor.name}`
  );
  if (islands.length > limits.maxUnreachableComponents) {
    reasons.push(
      `unreachable-components:${islands.length}>${limits.maxUnreachableComponents}`
    );
  }
  if (unreachableAudited.length > limits.maxUnreachablePolygons) {
    reasons.push(
      `unreachable-polygons:${unreachableAudited.length}>${limits.maxUnreachablePolygons}`
    );
  }
  if (unreachableSurfaceArea > limits.maxUnreachableSurfaceArea) {
    reasons.push(
      `unreachable-surface-area:${round(unreachableSurfaceArea)}>${limits.maxUnreachableSurfaceArea}`
    );
  }
  if (underFloorComponents > limits.maxUnderFloorComponents) {
    reasons.push(
      `under-floor-components:${underFloorComponents}>${limits.maxUnderFloorComponents}`
    );
  }

  return {
    schemaVersion: 1,
    algorithm: NAVIGATION_ISLAND_AUDIT_ALGORITHM,
    name: config.name,
    passed: reasons.length === 0,
    reasons,
    bounds: config.bounds,
    filter: { includeFlags, excludeFlags },
    underFloorBelowY: config.underFloorBelowY ?? null,
    anchors: [...anchors].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    stats: {
      contextPolygons: topology.polygons.length,
      contextTraversablePolygons: traversable.size,
      auditedPolygons: audited.length,
      reachableAuditedPolygons: audited.length - unreachableAudited.length,
      unreachableAuditedPolygons: unreachableAudited.length,
      unreachableSurfaceArea: round(unreachableSurfaceArea),
      unreachableComponents: islands.length,
      underFloorComponents,
      unresolvedLinks: topology.unresolvedLinkCount
    },
    islands
  };
}

export function createRegionalStreamSamples(
  bounds: NavigationAuditBounds,
  spacing: number = 250
): NavigationAuditPoint[] {
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new Error("stream sample spacing must be positive and finite");
  }
  const axis = (min: number, max: number) => {
    const values: number[] = [];
    const count = Math.max(1, Math.ceil((max - min) / spacing));
    for (let index = 0; index <= count; index++) {
      values.push(min + ((max - min) * index) / count);
    }
    return values;
  };
  const y = (bounds.min[1] + bounds.max[1]) / 2;
  return axis(bounds.min[0], bounds.max[0])
    .flatMap((x) =>
      axis(bounds.min[2], bounds.max[2]).map(
        (z) => [x, y, z] as NavigationAuditPoint
      )
    )
    .sort(
      (left, right) =>
        left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    );
}
