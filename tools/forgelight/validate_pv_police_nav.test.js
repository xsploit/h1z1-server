"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  POINTS,
  validatePoliceStationRoutes
} = require("./validate_pv_police_nav");

function fakeQuery({ partialRoute = null, roofPresent = false } = {}) {
  return {
    findNearestPoly(point) {
      if (point === POINTS.roofLanding && !roofPresent) {
        return { nearestRef: 0, nearestPoint: point };
      }
      return { nearestRef: 1, nearestPoint: point };
    },
    computePath(start, target) {
      const route = `${Object.keys(POINTS).find((key) => POINTS[key] === start)}->${Object.keys(
        POINTS
      ).find((key) => POINTS[key] === target)}`;
      if (route === partialRoute) {
        return {
          success: true,
          path: [start, { x: target.x + 1, y: target.y, z: target.z }]
        };
      }
      return { success: true, path: [start, target] };
    }
  };
}

test("accepts four complete routes while the roof remains excluded", () => {
  const report = validatePoliceStationRoutes(fakeQuery());
  assert.equal(report.ok, true);
  assert.equal(report.roofIsolated, true);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every((result) => result.endpointGap === 0));
});

test("rejects a Detour partial path even when computePath reports success", () => {
  const report = validatePoliceStationRoutes(
    fakeQuery({ partialRoute: "stairBottom->upperInterior" })
  );
  assert.equal(report.ok, false);
  assert.match(report.failures.join("\n"), /partial or missing path/);
  assert.match(report.failures.join("\n"), /endpointGap=1\.000m/);
});

test("rejects a nav polygon on the intentionally excluded roof landing", () => {
  const report = validatePoliceStationRoutes(fakeQuery({ roofPresent: true }));
  assert.equal(report.ok, false);
  assert.equal(report.roofIsolated, false);
  assert.match(report.failures.join("\n"), /roof landing unexpectedly/);
});
