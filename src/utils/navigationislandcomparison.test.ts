import assert from "node:assert/strict";
import test from "node:test";
import {
  compareNavigationIslandAuditReports,
  createNavigationIslandAuditScope,
  NAVIGATION_ISLAND_SCOPE_SCHEMA
} from "./navigationislandcomparison";
import {
  NAVIGATION_ISLAND_AUDIT_ALGORITHM,
  NavigationIslandAuditConfig,
  NavigationIslandAuditReport
} from "./navigationislandaudit";

const baselineReportSha256 = "a".repeat(64);
const candidateReportSha256 = "b".repeat(64);

function report(): NavigationIslandAuditReport {
  return {
    schemaVersion: 2,
    algorithm: NAVIGATION_ISLAND_AUDIT_ALGORITHM,
    name: "pv-police",
    passed: false,
    reasons: [],
    bounds: { min: [-255, 15, -1180], max: [-210, 40, -1125] },
    filter: { includeFlags: 0xffff, excludeFlags: 0 },
    underFloorBelowY: 23,
    anchors: [
      {
        name: "interior",
        required: true,
        valid: false,
        polygonId: null,
        snappedPoint: null,
        horizontalSnap: null,
        verticalSnap: null,
        reasons: ["no-navmesh-polygon"]
      },
      {
        name: "road",
        required: true,
        valid: true,
        polygonId: "149,115,0:0",
        snappedPoint: [-260, 23.3, -1140],
        horizontalSnap: 0,
        verticalSnap: 0.25,
        reasons: []
      }
    ],
    stats: {
      contextPolygons: 18954,
      contextTraversablePolygons: 18954,
      auditedPolygons: 227,
      reachableAuditedPolygons: 92,
      unreachableAuditedPolygons: 135,
      unreachableSurfaceArea: 383.126008,
      unreachableComponents: 34,
      underFloorComponents: 12,
      unresolvedLinks: 0
    },
    islands: [],
    provenance: {
      configSha256: "c".repeat(64),
      configSource: "command-line-v1",
      cache: {
        parts: [{ path: "z1_cache_0.bin", bytes: 10, sha256: "d".repeat(64) }],
        totalBytes: 10,
        canonicalSha256: "e".repeat(64)
      },
      topologyOnly: true,
      streamSpacing: 250,
      streamSamples: 4,
      polygonSelection: "centroid-inside-3d-bounds"
    }
  };
}

function compare(
  baseline: NavigationIslandAuditReport,
  candidate: NavigationIslandAuditReport
) {
  return compareNavigationIslandAuditReports(baseline, candidate, {
    baseline: { reportSha256: baselineReportSha256 },
    candidate: { reportSha256: candidateReportSha256 }
  });
}

test("matched global candidate passes with factual PV island improvements", () => {
  const baseline = report();
  const candidate = structuredClone(baseline);
  candidate.anchors[0].valid = true;
  candidate.anchors[0].polygonId = "150,115,0:52";
  candidate.anchors[0].reasons = [];
  candidate.stats.unreachableAuditedPolygons = 27;
  candidate.stats.unreachableSurfaceArea = 39.100215;
  candidate.stats.unreachableComponents = 15;
  candidate.stats.underFloorComponents = 0;
  candidate.provenance!.configSha256 = "f".repeat(64);
  (candidate.provenance!.cache as { canonicalSha256: string }).canonicalSha256 =
    "1".repeat(64);

  const comparison = compare(baseline, candidate);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.scope.binding, "derived-report-fields");
  assert.equal(comparison.sources.baseline.reportSha256, baselineReportSha256);
  assert.equal(
    comparison.sources.candidate.reportSha256,
    candidateReportSha256
  );
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.improvements, [
    "required-anchor:interior",
    "underFloorComponents:12->0",
    "unreachableComponents:34->15",
    "unreachablePolygons:135->27",
    "unreachableSurfaceArea:383.126008->39.100215"
  ]);
});

test("gate fails every required monotonic regression", () => {
  const baseline = report();
  baseline.anchors[0].valid = true;
  baseline.anchors[0].polygonId = "150,115,0:52";
  baseline.anchors[0].reasons = [];
  const candidate = structuredClone(baseline);
  candidate.anchors[0].valid = false;
  candidate.anchors[0].polygonId = null;
  candidate.anchors[0].reasons = ["no-navmesh-polygon"];
  candidate.stats.unreachableAuditedPolygons++;
  candidate.stats.unreachableSurfaceArea += 0.01;
  candidate.stats.unreachableComponents++;
  candidate.stats.underFloorComponents++;
  candidate.stats.unresolvedLinks++;

  const comparison = compare(baseline, candidate);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressions, [
    "required-anchor:interior",
    "underFloorComponents:12->13",
    "unreachableComponents:34->35",
    "unreachablePolygons:135->136",
    "unreachableSurfaceArea:383.126008->383.136008",
    "unresolvedLinks:0->1"
  ]);
});

test("surface-area tolerance is evaluated before report rounding", () => {
  const baseline = report();
  const withinTolerance = structuredClone(baseline);
  withinTolerance.stats.unreachableSurfaceArea += 0.0000009;
  assert.equal(compare(baseline, withinTolerance).passed, true);

  const regression = structuredClone(baseline);
  regression.stats.unreachableSurfaceArea += 0.0000014;
  assert.equal(compare(baseline, regression).passed, false);
});

test("reports must share bounded scope and anchor gate definitions", () => {
  const baseline = report();
  const differentBounds = structuredClone(baseline);
  differentBounds.bounds.max[0]++;
  assert.throws(
    () => compare(baseline, differentBounds),
    /same bounded audit scope/
  );

  const differentAnchors = structuredClone(baseline);
  differentAnchors.anchors[0].name = "different";
  assert.throws(
    () => compare(baseline, differentAnchors),
    /same bounded audit scope/
  );
});

test("comparison requires exact report and cache provenance bindings", () => {
  const baseline = report();
  assert.throws(
    () =>
      compareNavigationIslandAuditReports(baseline, structuredClone(baseline), {
        baseline: { reportSha256: "not-a-hash" },
        candidate: { reportSha256: candidateReportSha256 }
      }),
    /reportSha256/
  );

  const missingCache = structuredClone(baseline);
  delete (missingCache.provenance as { cache?: unknown }).cache;
  assert.throws(() => compare(baseline, missingCache), /has no cache parts/);

  const transitionsEnabled = structuredClone(baseline);
  transitionsEnabled.provenance!.topologyOnly = false;
  assert.throws(
    () => compare(baseline, transitionsEnabled),
    /must be topology-only/
  );
});

test("explicit scope hashes bind future reports and exclude absolute limits", () => {
  const config: NavigationIslandAuditConfig = {
    name: "pv-police",
    bounds: { min: [-255, 15, -1180], max: [-210, 40, -1125] },
    anchors: [{ name: "road", position: [-260, 23.05, -1140] }],
    underFloorBelowY: 23,
    limits: { maxUnreachablePolygons: 100 }
  };
  const runtime = {
    topologyOnly: true,
    streamSpacing: 250,
    streamSamples: 4,
    polygonSelection: "centroid-inside-3d-bounds"
  };
  const first = createNavigationIslandAuditScope(config, runtime);
  const second = createNavigationIslandAuditScope(
    {
      ...config,
      limits: { maxUnreachablePolygons: 10 }
    },
    runtime
  );
  assert.equal(first.sha256, second.sha256);

  const baseline = report();
  const candidate = structuredClone(baseline);
  Object.assign(baseline.provenance!, {
    scopeSchema: NAVIGATION_ISLAND_SCOPE_SCHEMA,
    scopeSha256: first.sha256
  });
  Object.assign(candidate.provenance!, {
    scopeSchema: NAVIGATION_ISLAND_SCOPE_SCHEMA,
    scopeSha256: first.sha256
  });
  assert.equal(
    compare(baseline, candidate).scope.binding,
    "explicit-scope-sha256"
  );

  candidate.provenance!.scopeSha256 = "2".repeat(64);
  assert.throws(() => compare(baseline, candidate), /same explicit scope hash/);
});
