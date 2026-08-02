// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { readFileSync } from "node:fs";

export type NavigationProbePoint = { x: number; y: number; z: number };
export type NavigationProbeTuple = [number, number, number];

export interface NavigationValidationAnchor {
  name: string;
  position: NavigationProbeTuple;
  halfExtents?: NavigationProbeTuple;
  expectedAreas?: number[];
  mustBeOffNavmesh?: boolean;
  maxHorizontalSnap?: number;
  maxVerticalSnap?: number;
}

export interface NavigationValidationSegment {
  name: string;
  from: string;
  to: string;
  required?: boolean;
  reachTolerance?: number;
  maxDetourRatio?: number;
  maxCornerVerticalStep?: number;
  maxSegmentSlopeDegrees?: number;
  monotonicVertical?: "ascending" | "descending" | "either";
  monotonicVerticalTolerance?: number;
  requiredAreas?: number[];
}

export interface NavigationValidationRegion {
  name: string;
  description: string;
  anchors: NavigationValidationAnchor[];
  segments: NavigationValidationSegment[];
}

export interface NavigationValidationConfig {
  schemaVersion: 1;
  coordinateSpace: "h1z1-world-y-up-meters";
  regions: NavigationValidationRegion[];
}

export interface NavigationProbeSnap {
  ref: number;
  point: NavigationProbePoint;
  area: number | null;
}

export interface NavigationProbeAdapter {
  snap(
    position: NavigationProbePoint,
    halfExtents: NavigationProbePoint
  ): NavigationProbeSnap;
  path(
    from: NavigationProbePoint,
    to: NavigationProbePoint,
    halfExtents: NavigationProbePoint,
    fromRef: number,
    toRef: number
  ): NavigationProbePoint[] | NavigationProbePath;
}

export interface NavigationProbePath {
  points: NavigationProbePoint[];
  areas: number[];
}

export interface NavigationValidationReport {
  schemaVersion: 1;
  provenance?: {
    configSha256: string;
    adapterVersion: string;
    straightPathOptions: number;
    maxPathPolys: number;
    maxStraightPathPoints: number;
    topologyOnly: boolean;
  };
  passed: boolean;
  regions: Array<{
    name: string;
    passed: boolean;
    anchors: Array<
      NavigationProbeSnap & {
        name: string;
        passed: boolean;
        failures: string[];
        horizontalSnap: number;
        verticalSnap: number;
      }
    >;
    segments: Array<{
      name: string;
      passed: boolean;
      required: boolean;
      reached: boolean;
      corners: number;
      directLength: number;
      pathLength: number;
      detourRatio: number | null;
      maxCornerVerticalStep: number;
      maxSegmentSlopeDegrees: number;
      traversedAreas: number[];
      failures: string[];
    }>;
  }>;
}

export interface NavigationValidationComparison {
  passed: boolean;
  candidatePassedAllGates: boolean;
  improvements: string[];
  regressions: string[];
  unchangedFailures: string[];
}

function isFiniteTuple(value: unknown): value is NavigationProbeTuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => Number.isFinite(entry))
  );
}

export function parseNavigationValidationConfig(
  value: unknown
): NavigationValidationConfig {
  if (!value || typeof value !== "object") {
    throw new Error("navigation validation config must be an object");
  }
  const config = value as Record<string, unknown>;
  if (config.schemaVersion !== 1) {
    throw new Error(
      `unsupported navigation validation schema ${String(config.schemaVersion)}`
    );
  }
  if (config.coordinateSpace !== "h1z1-world-y-up-meters") {
    throw new Error("navigation validation coordinate space is invalid");
  }
  if (!Array.isArray(config.regions) || !config.regions.length) {
    throw new Error("navigation validation config has no regions");
  }

  const regionNames = new Set<string>();
  for (const [regionIndex, rawRegion] of config.regions.entries()) {
    if (!rawRegion || typeof rawRegion !== "object") {
      throw new Error(`navigation validation region ${regionIndex} is invalid`);
    }
    const region = rawRegion as Record<string, unknown>;
    if (
      typeof region.name !== "string" ||
      !region.name ||
      typeof region.description !== "string"
    ) {
      throw new Error(
        `navigation validation region ${regionIndex} has no name`
      );
    }
    if (regionNames.has(region.name)) {
      throw new Error(`duplicate navigation validation region ${region.name}`);
    }
    regionNames.add(region.name);
    if (!Array.isArray(region.anchors) || !region.anchors.length) {
      throw new Error(
        `navigation validation region ${region.name} has no anchors`
      );
    }
    const anchors = new Set<string>();
    for (const [anchorIndex, rawAnchor] of region.anchors.entries()) {
      if (!rawAnchor || typeof rawAnchor !== "object") {
        throw new Error(`${region.name} anchor ${anchorIndex} is invalid`);
      }
      const anchor = rawAnchor as Record<string, unknown>;
      if (
        typeof anchor.name !== "string" ||
        !anchor.name ||
        !isFiniteTuple(anchor.position) ||
        (anchor.halfExtents !== undefined &&
          !isFiniteTuple(anchor.halfExtents)) ||
        (anchor.expectedAreas !== undefined &&
          (!Array.isArray(anchor.expectedAreas) ||
            anchor.expectedAreas.some((area) => !Number.isInteger(area)))) ||
        (anchor.mustBeOffNavmesh !== undefined &&
          typeof anchor.mustBeOffNavmesh !== "boolean") ||
        (anchor.mustBeOffNavmesh === true &&
          Array.isArray(anchor.expectedAreas) &&
          anchor.expectedAreas.length > 0)
      ) {
        throw new Error(`${region.name} anchor ${anchorIndex} is invalid`);
      }
      if (anchors.has(anchor.name)) {
        throw new Error(`${region.name} has duplicate anchor ${anchor.name}`);
      }
      anchors.add(anchor.name);
    }
    if (!Array.isArray(region.segments)) {
      throw new Error(
        `navigation validation region ${region.name} has no segments`
      );
    }
    for (const [segmentIndex, rawSegment] of region.segments.entries()) {
      if (!rawSegment || typeof rawSegment !== "object") {
        throw new Error(`${region.name} segment ${segmentIndex} is invalid`);
      }
      const segment = rawSegment as Record<string, unknown>;
      if (
        typeof segment.name !== "string" ||
        !segment.name ||
        typeof segment.from !== "string" ||
        typeof segment.to !== "string" ||
        !anchors.has(segment.from) ||
        !anchors.has(segment.to) ||
        (segment.maxSegmentSlopeDegrees !== undefined &&
          (!Number.isFinite(segment.maxSegmentSlopeDegrees as number) ||
            (segment.maxSegmentSlopeDegrees as number) < 0 ||
            (segment.maxSegmentSlopeDegrees as number) > 90)) ||
        (segment.monotonicVerticalTolerance !== undefined &&
          (!Number.isFinite(segment.monotonicVerticalTolerance as number) ||
            (segment.monotonicVerticalTolerance as number) < 0 ||
            (segment.monotonicVerticalTolerance as number) > 1)) ||
        (segment.requiredAreas !== undefined &&
          (!Array.isArray(segment.requiredAreas) ||
            segment.requiredAreas.length === 0 ||
            segment.requiredAreas.some((area) => !Number.isInteger(area))))
      ) {
        throw new Error(`${region.name} segment ${segmentIndex} is invalid`);
      }
    }
  }
  return value as NavigationValidationConfig;
}

export function loadNavigationValidationConfig(
  path: string
): NavigationValidationConfig {
  return parseNavigationValidationConfig(
    JSON.parse(readFileSync(path, "utf8"))
  );
}

function point(tuple: NavigationProbeTuple): NavigationProbePoint {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function distance(
  left: NavigationProbePoint,
  right: NavigationProbePoint
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

export function evaluateNavigationValidation(
  config: NavigationValidationConfig,
  adapter: NavigationProbeAdapter
): NavigationValidationReport {
  const regions = config.regions.map((region) => {
    const snaps = new Map<string, NavigationProbeSnap>();
    const anchors = region.anchors.map((anchor) => {
      const requested = point(anchor.position);
      const extents = point(anchor.halfExtents ?? [1, 1, 1]);
      const snap = adapter.snap(requested, extents);
      snaps.set(anchor.name, snap);
      const horizontalSnap = Math.hypot(
        snap.point.x - requested.x,
        snap.point.z - requested.z
      );
      const verticalSnap = Math.abs(snap.point.y - requested.y);
      const failures: string[] = [];
      if (anchor.mustBeOffNavmesh) {
        if (snap.ref) failures.push("unexpectedly-on-navmesh");
      } else if (!snap.ref) {
        failures.push("not-on-navmesh");
      }
      if (
        !anchor.mustBeOffNavmesh &&
        anchor.expectedAreas?.length &&
        (snap.area === null || !anchor.expectedAreas.includes(snap.area))
      ) {
        failures.push(`unexpected-area:${String(snap.area)}`);
      }
      if (
        anchor.maxHorizontalSnap !== undefined &&
        horizontalSnap > anchor.maxHorizontalSnap
      ) {
        failures.push(`horizontal-snap:${horizontalSnap.toFixed(3)}`);
      }
      if (
        anchor.maxVerticalSnap !== undefined &&
        verticalSnap > anchor.maxVerticalSnap
      ) {
        failures.push(`vertical-snap:${verticalSnap.toFixed(3)}`);
      }
      return {
        name: anchor.name,
        ...snap,
        passed: failures.length === 0,
        failures,
        horizontalSnap,
        verticalSnap
      };
    });

    const anchorConfig = new Map(
      region.anchors.map((anchor) => [anchor.name, anchor])
    );
    const segments = region.segments.map((segment) => {
      const required = segment.required ?? true;
      const from = snaps.get(segment.from)!;
      const to = snaps.get(segment.to)!;
      const fromConfig = anchorConfig.get(segment.from)!;
      const extents = point(fromConfig.halfExtents ?? [1, 1, 1]);
      const pathResult =
        from.ref && to.ref
          ? adapter.path(from.point, to.point, extents, from.ref, to.ref)
          : [];
      const path = Array.isArray(pathResult) ? pathResult : pathResult.points;
      const traversedAreas = Array.isArray(pathResult)
        ? []
        : [...new Set(pathResult.areas)].sort((left, right) => left - right);
      const last = path[path.length - 1];
      const reachTolerance = segment.reachTolerance ?? 0.75;
      const reached = Boolean(
        last && distance(last, to.point) <= reachTolerance
      );
      const directLength = distance(from.point, to.point);
      const pathLength = path
        .slice(1)
        .reduce(
          (sum, current, index) => sum + distance(path[index], current),
          0
        );
      const detourRatio = directLength > 0 ? pathLength / directLength : null;
      const verticalSteps = path
        .slice(1)
        .map((current, index) => current.y - path[index].y);
      const maxCornerVerticalStep = verticalSteps.reduce(
        (maximum, step) => Math.max(maximum, Math.abs(step)),
        0
      );
      const maxSegmentSlopeDegrees = path
        .slice(1)
        .reduce((maximum, current, index) => {
          const previous = path[index];
          const horizontal = Math.hypot(
            current.x - previous.x,
            current.z - previous.z
          );
          const vertical = Math.abs(current.y - previous.y);
          const slope =
            horizontal === 0
              ? vertical === 0
                ? 0
                : 90
              : (Math.atan2(vertical, horizontal) * 180) / Math.PI;
          return Math.max(maximum, slope);
        }, 0);
      const failures: string[] = [];
      if (required && !reached) failures.push("unreachable");
      if (
        reached &&
        segment.maxDetourRatio !== undefined &&
        detourRatio !== null &&
        detourRatio > segment.maxDetourRatio
      ) {
        failures.push(`detour-ratio:${detourRatio.toFixed(3)}`);
      }
      if (
        reached &&
        segment.maxCornerVerticalStep !== undefined &&
        maxCornerVerticalStep > segment.maxCornerVerticalStep
      ) {
        failures.push(`vertical-step:${maxCornerVerticalStep.toFixed(3)}`);
      }
      if (
        reached &&
        segment.maxSegmentSlopeDegrees !== undefined &&
        maxSegmentSlopeDegrees > segment.maxSegmentSlopeDegrees
      ) {
        failures.push(`slope-degrees:${maxSegmentSlopeDegrees.toFixed(3)}`);
      }
      if (reached && segment.monotonicVertical) {
        const epsilon = segment.monotonicVerticalTolerance ?? 0.05;
        const ascending = verticalSteps.every((step) => step >= -epsilon);
        const descending = verticalSteps.every((step) => step <= epsilon);
        const monotonic =
          segment.monotonicVertical === "ascending"
            ? ascending
            : segment.monotonicVertical === "descending"
              ? descending
              : ascending || descending;
        if (!monotonic) failures.push("non-monotonic-vertical-path");
      }
      if (reached && segment.requiredAreas) {
        for (const area of segment.requiredAreas) {
          if (!traversedAreas.includes(area)) {
            failures.push(`missing-required-area:${area}`);
          }
        }
      }
      return {
        name: segment.name,
        passed: failures.length === 0,
        required,
        reached,
        corners: path.length,
        directLength,
        pathLength,
        detourRatio,
        maxCornerVerticalStep,
        maxSegmentSlopeDegrees,
        traversedAreas,
        failures
      };
    });
    return {
      name: region.name,
      passed:
        anchors.every((anchor) => anchor.passed) &&
        segments.every((segment) => segment.passed),
      anchors,
      segments
    };
  });
  return {
    schemaVersion: 1,
    passed: regions.every((region) => region.passed),
    regions
  };
}

function validationStatuses(
  report: NavigationValidationReport
): Map<string, boolean> {
  const statuses = new Map<string, boolean>();
  for (const region of report.regions) {
    statuses.set(`region:${region.name}`, region.passed);
    for (const anchor of region.anchors) {
      statuses.set(`anchor:${region.name}/${anchor.name}`, anchor.passed);
    }
    for (const segment of region.segments) {
      statuses.set(`segment:${region.name}/${segment.name}`, segment.passed);
    }
  }
  return statuses;
}

export function compareNavigationValidationReports(
  baseline: NavigationValidationReport,
  candidate: NavigationValidationReport,
  requireAllGates = false
): NavigationValidationComparison {
  if (
    JSON.stringify(baseline.provenance ?? null) !==
    JSON.stringify(candidate.provenance ?? null)
  ) {
    throw new Error(
      "navigation validation reports do not share the same validation provenance"
    );
  }
  const baselineStatuses = validationStatuses(baseline);
  const candidateStatuses = validationStatuses(candidate);
  const baselineKeys = [...baselineStatuses.keys()].sort();
  const candidateKeys = [...candidateStatuses.keys()].sort();
  if (baselineKeys.join("\n") !== candidateKeys.join("\n")) {
    throw new Error(
      "navigation validation reports do not contain the same gates"
    );
  }
  const improvements: string[] = [];
  const regressions: string[] = [];
  const unchangedFailures: string[] = [];
  for (const key of baselineKeys) {
    const before = baselineStatuses.get(key)!;
    const after = candidateStatuses.get(key)!;
    if (!before && after) improvements.push(key);
    else if (before && !after) regressions.push(key);
    else if (!after) unchangedFailures.push(key);
  }
  const candidatePassedAllGates = candidate.passed;
  return {
    passed:
      regressions.length === 0 &&
      improvements.length > 0 &&
      (!requireAllGates || candidatePassedAllGates),
    candidatePassedAllGates,
    improvements,
    regressions,
    unchangedFailures
  };
}
