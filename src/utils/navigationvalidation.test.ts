// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  compareNavigationValidationReports,
  evaluateNavigationValidation,
  navigationValidationConfigSha256,
  NavigationProbeAdapter,
  NavigationValidationConfig,
  parseNavigationValidationConfig
} from "./navigationvalidation";

const config: NavigationValidationConfig = {
  schemaVersion: 1,
  coordinateSpace: "h1z1-world-y-up-meters",
  regions: [
    {
      name: "stairs",
      description: "synthetic stair contract",
      anchors: [
        { name: "bottom", position: [0, 0, 0], expectedAreas: [5] },
        { name: "top", position: [2, 1, 0], expectedAreas: [5] }
      ],
      segments: [
        {
          name: "bottom-to-top",
          from: "bottom",
          to: "top",
          maxDetourRatio: 1.5,
          maxCornerVerticalStep: 0.6,
          monotonicVertical: "ascending"
        }
      ]
    }
  ]
};

function cardinalSeamConfig(): NavigationValidationConfig {
  return {
    schemaVersion: 1,
    coordinateSpace: "h1z1-world-y-up-meters",
    cardinalSeamGate: {
      tileOrigin: [0, 0],
      tileSize: 10,
      replacementTiles: {
        minX: 1,
        minZ: 2,
        maxXExclusive: 3,
        maxZExclusive: 4
      }
    },
    regions: [
      {
        name: "west-seam",
        description: "west seam",
        anchors: [
          { name: "outside", position: [9, 0, 25] },
          { name: "inside", position: [11, 0, 25] }
        ],
        segments: [
          {
            name: "cross-west",
            from: "outside",
            to: "inside",
            seamDirection: "west"
          }
        ]
      },
      {
        name: "east-seam",
        description: "east seam",
        anchors: [
          { name: "inside", position: [29, 0, 25] },
          { name: "outside", position: [31, 0, 25] }
        ],
        segments: [
          {
            name: "cross-east",
            from: "inside",
            to: "outside",
            seamDirection: "east"
          }
        ]
      },
      {
        name: "south-seam",
        description: "south seam",
        anchors: [
          { name: "outside", position: [15, 0, 19] },
          { name: "inside", position: [15, 0, 21] }
        ],
        segments: [
          {
            name: "cross-south",
            from: "outside",
            to: "inside",
            seamDirection: "south"
          }
        ]
      },
      {
        name: "north-seam",
        description: "north seam",
        anchors: [
          { name: "inside", position: [15, 0, 39] },
          { name: "outside", position: [15, 0, 41] }
        ],
        segments: [
          {
            name: "cross-north",
            from: "inside",
            to: "outside",
            seamDirection: "north"
          }
        ]
      }
    ]
  };
}

describe("navigation regional validation", () => {
  it("uses the same reported config identity for LF and CRLF JSON", () => {
    const serialized = `${JSON.stringify(cardinalSeamConfig(), null, 2)}\n`;
    const lf = parseNavigationValidationConfig(JSON.parse(serialized));
    const crlf = parseNavigationValidationConfig(
      JSON.parse(serialized.replace(/\n/g, "\r\n"))
    );

    assert.equal(
      navigationValidationConfigSha256(lf),
      navigationValidationConfigSha256(crlf)
    );
  });

  it("requires exactly one route across every cardinal replacement seam", () => {
    const complete = cardinalSeamConfig();
    assert.deepEqual(parseNavigationValidationConfig(complete), complete);

    const missingNorth = cardinalSeamConfig();
    missingNorth.regions = missingNorth.regions.filter(
      (region) => region.name !== "north-seam"
    );
    assert.throws(
      () => parseNavigationValidationConfig(missingNorth),
      /requires exactly one north segment; found 0/
    );

    const duplicateWest = cardinalSeamConfig();
    const extra = structuredClone(duplicateWest.regions[0]);
    extra.name = "west-seam-duplicate";
    duplicateWest.regions.push(extra);
    assert.throws(
      () => parseNavigationValidationConfig(duplicateWest),
      /requires exactly one west segment; found 2/
    );
  });

  it("rejects a cardinal seam route whose declared anchors do not straddle", () => {
    const invalid = cardinalSeamConfig();
    invalid.regions[0].anchors[1].position = [9.5, 0, 25];
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /does not straddle the west replacement seam/
    );
  });

  it("fails when Detour snaps a declared seam route onto one side", () => {
    const seamConfig = cardinalSeamConfig();
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        if (position.x === 11 && position.z === 25) {
          return { ref: 1, point: { ...position, x: 9.5 }, area: 1 };
        }
        return { ref: 1, point: position, area: 1 };
      },
      path(from, to) {
        return [from, to];
      }
    };

    const report = evaluateNavigationValidation(seamConfig, adapter);
    assert.equal(report.passed, false);
    assert.deepEqual(report.regions[0].segments[0].failures, [
      "seam-not-straddled:west"
    ]);
  });

  it("accepts a connected monotonic stair path", () => {
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, { x: 1, y: 0.5, z: 0 }, to];
      }
    };
    const report = evaluateNavigationValidation(config, adapter);
    assert.equal(report.passed, true);
    assert.equal(report.regions[0].segments[0].maxCornerVerticalStep, 0.5);
  });

  it("passes the exact resolved anchor polygon refs into path queries", () => {
    let observedRefs: [number, number] | null = null;
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return {
          ref: position.x === 0 ? 101 : 202,
          point: position,
          area: 5
        };
      },
      path(from, to, _halfExtents, fromRef, toRef) {
        observedRefs = [fromRef, toRef];
        return [from, { x: 1, y: 0.5, z: 0 }, to];
      }
    };

    const report = evaluateNavigationValidation(config, adapter);
    assert.equal(report.passed, true);
    assert.deepEqual(observedRefs, [101, 202]);
  });

  it("requires a corridor to traverse declared semantic areas", () => {
    const areaConfig = structuredClone(config);
    areaConfig.regions[0].segments[0].requiredAreas = [5];
    const adapter = (areas: number[]): NavigationProbeAdapter => ({
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return {
          points: [from, { x: 1, y: 0.5, z: 0 }, to],
          areas
        };
      }
    });

    const accepted = evaluateNavigationValidation(areaConfig, adapter([4, 5]));
    assert.equal(accepted.passed, true);
    assert.deepEqual(accepted.regions[0].segments[0].traversedAreas, [4, 5]);

    const rejected = evaluateNavigationValidation(areaConfig, adapter([4]));
    assert.equal(rejected.passed, false);
    assert.deepEqual(rejected.regions[0].segments[0].failures, [
      "missing-required-area:5"
    ]);

    const invalid = structuredClone(areaConfig);
    invalid.regions[0].segments[0].requiredAreas = [];
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /segment 0 is invalid/
    );
  });

  it("fails an elevator-like stair path", () => {
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, to];
      }
    };
    const report = evaluateNavigationValidation(config, adapter);
    assert.equal(report.passed, false);
    assert.deepEqual(report.regions[0].segments[0].failures, [
      "vertical-step:1.000"
    ]);
  });

  it("accepts a long authored slope but rejects a vertical topology edge", () => {
    const slopedConfig = structuredClone(config);
    const segment = slopedConfig.regions[0].segments[0];
    delete segment.maxCornerVerticalStep;
    segment.maxSegmentSlopeDegrees = 30;
    const sloped: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, to];
      }
    };
    const accepted = evaluateNavigationValidation(slopedConfig, sloped);
    assert.equal(accepted.passed, true);
    assert.ok(accepted.regions[0].segments[0].maxSegmentSlopeDegrees < 30);

    const vertical: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, { x: from.x, y: to.y, z: from.z }, to];
      }
    };
    const rejected = evaluateNavigationValidation(slopedConfig, vertical);
    assert.equal(rejected.passed, false);
    assert.deepEqual(rejected.regions[0].segments[0].failures, [
      "slope-degrees:90.000"
    ]);
  });

  it("rejects segments that reference missing anchors", () => {
    const invalid = structuredClone(config);
    invalid.regions[0].segments[0].to = "missing";
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /segment 0 is invalid/
    );
  });

  it("rejects an invalid segment slope limit", () => {
    const invalid = structuredClone(config);
    invalid.regions[0].segments[0].maxSegmentSlopeDegrees = 91;
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /segment 0 is invalid/
    );
  });

  it("allows an explicit voxel-scale monotonic tolerance", () => {
    const tolerant = structuredClone(config);
    const segment = tolerant.regions[0].segments[0];
    delete segment.maxCornerVerticalStep;
    segment.monotonicVerticalTolerance = 0.11;
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, { x: 1, y: 1.08, z: 0 }, to];
      }
    };
    assert.equal(evaluateNavigationValidation(config, adapter).passed, false);
    assert.equal(evaluateNavigationValidation(tolerant, adapter).passed, true);

    const invalid = structuredClone(tolerant);
    invalid.regions[0].segments[0].monotonicVerticalTolerance = 1.01;
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /segment 0 is invalid/
    );
  });

  it("requires static-obstacle probes to remain off the navmesh", () => {
    const obstacleConfig: NavigationValidationConfig = {
      schemaVersion: 1,
      coordinateSpace: "h1z1-world-y-up-meters",
      regions: [
        {
          name: "obstacle",
          description: "synthetic static obstacle contract",
          anchors: [
            {
              name: "center",
              position: [4, 0, 4],
              mustBeOffNavmesh: true
            }
          ],
          segments: []
        }
      ]
    };
    const blocked: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 0, point: position, area: null };
      },
      path() {
        return [];
      }
    };
    assert.equal(
      evaluateNavigationValidation(obstacleConfig, blocked).passed,
      true
    );

    const incorrectlyWalkable: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 7, point: position, area: 3 };
      },
      path() {
        return [];
      }
    };
    const report = evaluateNavigationValidation(
      obstacleConfig,
      incorrectlyWalkable
    );
    assert.equal(report.passed, false);
    assert.deepEqual(report.regions[0].anchors[0].failures, [
      "unexpectedly-on-navmesh"
    ]);

    const invalid = structuredClone(obstacleConfig);
    invalid.regions[0].anchors[0].expectedAreas = [3];
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /anchor 0 is invalid/
    );
  });

  it("requires an improvement without regressions for an A/B candidate", () => {
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, to];
      }
    };
    const baseline = evaluateNavigationValidation(config, adapter);
    const improvedConfig = structuredClone(config);
    improvedConfig.regions[0].segments[0].maxCornerVerticalStep = 1;
    const candidate = evaluateNavigationValidation(improvedConfig, adapter);
    const comparison = compareNavigationValidationReports(baseline, candidate);
    assert.equal(comparison.passed, true);
    assert.deepEqual(comparison.regressions, []);
    assert.deepEqual(comparison.improvements, [
      "region:stairs",
      "segment:stairs/bottom-to-top"
    ]);
  });

  it("rejects reports with a different gate set", () => {
    const empty = {
      schemaVersion: 1 as const,
      passed: true,
      regions: []
    };
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, to];
      }
    };
    const baseline = evaluateNavigationValidation(config, adapter);
    assert.throws(
      () => compareNavigationValidationReports(baseline, empty),
      /do not contain the same gates/
    );
  });

  it("rejects reports generated by different validation adapters", () => {
    const adapter: NavigationProbeAdapter = {
      snap(position) {
        return { ref: 1, point: position, area: 5 };
      },
      path(from, to) {
        return [from, to];
      }
    };
    const baseline = evaluateNavigationValidation(config, adapter);
    baseline.provenance = {
      configSha256: "a".repeat(64),
      adapterVersion: "detour-all-crossings-v1",
      straightPathOptions: 2,
      maxPathPolys: 2048,
      maxStraightPathPoints: 2048,
      topologyOnly: true
    };
    const candidate = structuredClone(baseline);
    candidate.provenance!.adapterVersion = "different-adapter";
    assert.throws(
      () => compareNavigationValidationReports(baseline, candidate),
      /do not share the same validation provenance/
    );
  });
});
