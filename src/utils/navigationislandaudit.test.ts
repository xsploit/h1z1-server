import assert from "node:assert/strict";
import test from "node:test";
import type { NavMesh, NavMeshQuery } from "recast-navigation";
import {
  assertNavigationIslandAuditConfig,
  createRegionalStreamSamples,
  evaluateNavigationIslandAudit,
  extractNavigationTopology,
  NavigationAuditAnchor,
  NavigationIslandAuditConfig,
  NavigationTopologyPolygon,
  NavigationTopologySnapshot,
  resolveNavigationAuditAnchors
} from "./navigationislandaudit";

function polygon(
  id: string,
  centroid: [number, number, number],
  outgoing: string[] = [],
  surfaceArea: number = 1
): NavigationTopologyPolygon {
  return {
    id,
    ref: Number(id.replace(/\D/g, "")) + 1,
    tile: [0, 0, 0],
    polygonIndex: 0,
    offMesh: false,
    flags: 1,
    area: 1,
    centroid,
    bounds: {
      min: [centroid[0] - 0.5, centroid[1], centroid[2] - 0.5],
      max: [centroid[0] + 0.5, centroid[1], centroid[2] + 0.5]
    },
    surfaceArea,
    outgoing
  };
}

function validAnchor(
  name: string,
  polygonId: string
): ReturnType<typeof resolveNavigationAuditAnchors>[number] {
  return {
    name,
    required: true,
    valid: true,
    polygonId,
    snappedPoint: [1, 0, 1],
    horizontalSnap: 0,
    verticalSnap: 0,
    reasons: []
  };
}

const baseConfig: NavigationIslandAuditConfig = {
  name: "synthetic-building",
  bounds: { min: [0, -10, 0], max: [10, 5, 10] },
  anchors: [{ name: "street", position: [1, 0, 1] }],
  underFloorBelowY: -1
};

test("native topology flood distinguishes reachable surfaces and under-floor islands", () => {
  const topology: NavigationTopologySnapshot = {
    polygons: [
      polygon("a", [1, 0, 1], ["outside"]),
      // The legal route leaves the bounded scoring volume and comes back.
      polygon("outside", [20, 0, 1], ["b"]),
      polygon("b", [9, 0, 1]),
      polygon("c", [3, -3, 3], ["d"], 2),
      polygon("d", [4, -3, 3], ["c"], 2),
      polygon("e", [7, 0, 7], [], 3)
    ],
    unresolvedLinkCount: 0
  };

  const report = evaluateNavigationIslandAudit(baseConfig, topology, [
    validAnchor("street", "a")
  ]);

  assert.equal(report.passed, false);
  assert.deepEqual(report.stats, {
    contextPolygons: 6,
    contextTraversablePolygons: 6,
    auditedPolygons: 5,
    reachableAuditedPolygons: 2,
    unreachableAuditedPolygons: 3,
    unreachableSurfaceArea: 7,
    unreachableComponents: 2,
    underFloorComponents: 1,
    unresolvedLinks: 0
  });
  assert.equal(report.islands[0].classification, "under-floor");
  assert.deepEqual(report.islands[0].polygonIds, ["c", "d"]);
  assert.deepEqual(report.islands[0].bounds, {
    min: [2.5, -3, 2.5],
    max: [4.5, -3, 3.5]
  });
  assert.deepEqual(report.islands[0].centroid, [3.5, -3, 3]);
  assert.equal(report.islands[1].classification, "isolated");
  assert.deepEqual(report.islands[1].polygonIds, ["e"]);
  assert.deepEqual(report.islands[1].bounds, {
    min: [6.5, 0, 6.5],
    max: [7.5, 0, 7.5]
  });
  assert.deepEqual(report.islands[1].centroid, [7, 0, 7]);
  assert.deepEqual(report.reasons, [
    "unreachable-components:2>0",
    "unreachable-polygons:3>0",
    "unreachable-surface-area:7>0",
    "under-floor-components:1>0"
  ]);
});

test("report and island ids are deterministic across polygon and edge order", () => {
  const polygons = [
    polygon("a", [1, 0, 1], ["b", "outside"]),
    polygon("outside", [20, 0, 1], ["b"]),
    polygon("b", [9, 0, 1]),
    polygon("c", [3, -3, 3], ["d"]),
    polygon("d", [4, -3, 3], ["c"])
  ];
  const first = evaluateNavigationIslandAudit(
    baseConfig,
    { polygons, unresolvedLinkCount: 0 },
    [validAnchor("street", "a")]
  );
  const shuffled = polygons
    .map((entry) => ({ ...entry, outgoing: [...entry.outgoing].reverse() }))
    .reverse();
  const second = evaluateNavigationIslandAudit(
    baseConfig,
    { polygons: shuffled, unresolvedLinkCount: 0 },
    [validAnchor("street", "a")]
  );
  assert.deepEqual(second, first);
});

test("component centroid uses consistent area weights and remains finite for degenerate polygons", () => {
  const weighted = evaluateNavigationIslandAudit(
    baseConfig,
    {
      polygons: [
        polygon("a", [1, 0, 1]),
        polygon("c", [2, -3, 3], ["d"], 1),
        polygon("d", [4, -3, 3], ["c"], 3)
      ],
      unresolvedLinkCount: 0
    },
    [validAnchor("street", "a")]
  );
  assert.deepEqual(weighted.islands[0].centroid, [3.5, -3, 3]);
  assert.equal(weighted.islands[0].meanY, -3);

  const degenerate = evaluateNavigationIslandAudit(
    baseConfig,
    {
      polygons: [
        polygon("a", [1, 0, 1]),
        polygon("c", [2, -3, 3], ["d"], 0),
        polygon("d", [4, -3, 3], ["c"], 0)
      ],
      unresolvedLinkCount: 0
    },
    [validAnchor("street", "a")]
  );
  assert.deepEqual(degenerate.islands[0].centroid, [3, -3, 3]);
  assert.ok(degenerate.islands[0].centroid.every(Number.isFinite));
});

test("explicit limits can permit a known bounded island budget", () => {
  const topology: NavigationTopologySnapshot = {
    polygons: [polygon("a", [1, 0, 1]), polygon("c", [3, -3, 3], [], 2)],
    unresolvedLinkCount: 0
  };
  const report = evaluateNavigationIslandAudit(
    {
      ...baseConfig,
      limits: {
        maxUnreachableComponents: 1,
        maxUnreachablePolygons: 1,
        maxUnreachableSurfaceArea: 2,
        maxUnderFloorComponents: 1
      }
    },
    topology,
    [validAnchor("street", "a")]
  );
  assert.equal(report.passed, true);
  assert.deepEqual(report.reasons, []);
});

test("missing optional anchors are reported but do not fail an otherwise connected audit", () => {
  const optional = {
    name: "optional-roof",
    required: false,
    valid: false,
    polygonId: null,
    snappedPoint: null,
    horizontalSnap: null,
    verticalSnap: null,
    reasons: ["no-navmesh-polygon"]
  };
  const report = evaluateNavigationIslandAudit(
    baseConfig,
    { polygons: [polygon("a", [1, 0, 1])], unresolvedLinkCount: 0 },
    [validAnchor("street", "a"), optional]
  );
  assert.equal(report.passed, true);
  assert.equal(report.anchors[0].name, "optional-roof");
  assert.equal(report.anchors[0].valid, false);
});

test("stream samples deterministically cover both ends of a bounded region", () => {
  assert.deepEqual(
    createRegionalStreamSamples({ min: [0, -5, 0], max: [500, 5, 250] }, 250),
    [
      [0, 0, 0],
      [0, 0, 250],
      [250, 0, 0],
      [250, 0, 250],
      [500, 0, 0],
      [500, 0, 250]
    ]
  );
});

test("invalid audit geometry and anchor definitions fail before native queries", () => {
  assert.throws(
    () =>
      assertNavigationIslandAuditConfig({
        ...baseConfig,
        bounds: { min: [0, 0, 0], max: [0, 1, 1] }
      }),
    /strictly less/
  );
  assert.throws(
    () =>
      assertNavigationIslandAuditConfig({
        ...baseConfig,
        anchors: [
          { name: "duplicate", position: [0, 0, 0] },
          { name: "duplicate", position: [1, 0, 0] }
        ]
      }),
    /duplicate anchor/
  );
});

test("Detour extraction uses stable tile ids and anchor resolution enforces snap limits", () => {
  const vertices = [0, 0, 0, 1, 0, 0, 1, 0, 1, 2, -2, 0, 3, -2, 0, 3, -2, 1];
  const links = [
    { ref: () => 101, next: () => 0xffffffff },
    { ref: () => 100, next: () => 0xffffffff }
  ];
  const polys = [
    {
      firstLink: () => 0,
      verts: (index: number) => index,
      vertCount: () => 3,
      getType: () => 0,
      flags: () => 1
    },
    {
      firstLink: () => 1,
      verts: (index: number) => index + 3,
      vertCount: () => 3,
      getType: () => 0,
      flags: () => 1
    }
  ];
  const header = {
    x: () => 2,
    y: () => 3,
    layer: () => 1,
    polyCount: () => 2,
    maxLinkCount: () => 2
  };
  const tile = {
    header: () => header,
    salt: () => 7,
    polys: (index: number) => polys[index],
    verts: (index: number) => vertices[index],
    links: (index: number) => links[index]
  };
  const navMesh = {
    getMaxTiles: () => 1,
    getTile: () => tile,
    encodePolyId: (_salt: number, _tile: number, polygonIndex: number) =>
      100 + polygonIndex,
    getPolyArea: () => ({ status: 0x40000000, area: 4 })
  } as unknown as NavMesh;
  const topology = extractNavigationTopology(navMesh);
  assert.deepEqual(
    topology.polygons.map(({ id, outgoing }) => ({ id, outgoing })),
    [
      { id: "2,3,1:0", outgoing: ["2,3,1:1"] },
      { id: "2,3,1:1", outgoing: ["2,3,1:0"] }
    ]
  );

  const anchor: NavigationAuditAnchor = {
    name: "ground",
    position: [0.1, 0, 0.1],
    halfExtents: [1, 1, 1],
    maxHorizontalSnap: 0.25,
    maxVerticalSnap: 0.25
  };
  const query = {
    findNearestPoly: () => ({
      success: true,
      status: 0x40000000,
      nearestRef: 100,
      nearestPoint: { x: 0.2, y: 0, z: 0.2 },
      isOverPoly: true
    })
  } as unknown as NavMeshQuery;
  const resolved = resolveNavigationAuditAnchors(
    { ...baseConfig, anchors: [anchor] },
    query,
    topology
  );
  assert.equal(resolved[0].valid, true);
  assert.equal(resolved[0].polygonId, "2,3,1:0");
  assert.equal(resolved[0].horizontalSnap, 0.141421);
});
