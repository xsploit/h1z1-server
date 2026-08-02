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

describe("navigation regional validation", () => {
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

  it("rejects segments that reference missing anchors", () => {
    const invalid = structuredClone(config);
    invalid.regions[0].segments[0].to = "missing";
    assert.throws(
      () => parseNavigationValidationConfig(invalid),
      /segment 0 is invalid/
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
});
