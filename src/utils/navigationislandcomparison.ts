// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2026 H1emu community
//
// ======================================================================

import { createHash } from "node:crypto";
import {
  NAVIGATION_ISLAND_AUDIT_ALGORITHM,
  NavigationIslandAuditConfig,
  NavigationIslandAuditReport
} from "./navigationislandaudit";

export const NAVIGATION_ISLAND_SCOPE_SCHEMA = "navigation-island-scope-v1";
export const NAVIGATION_ISLAND_COMPARISON_ALGORITHM =
  "bounded-navigation-island-regression-v1";

type AuditRuntimeScope = {
  topologyOnly: boolean;
  streamSpacing: number;
  streamSamples: number;
  polygonSelection: string;
};

export type NavigationIslandReportBinding = {
  reportSha256: string;
};

export type NavigationIslandMetricName =
  | "unreachablePolygons"
  | "unreachableSurfaceArea"
  | "unreachableComponents"
  | "underFloorComponents"
  | "unresolvedLinks";

export type NavigationIslandComparisonReport = {
  schemaVersion: 1;
  algorithm: string;
  passed: boolean;
  reasons: string[];
  scope: {
    schema: string;
    binding: "explicit-scope-sha256" | "derived-report-fields";
    sha256: string;
  };
  sources: {
    baseline: NavigationIslandComparisonSource;
    candidate: NavigationIslandComparisonSource;
  };
  anchors: Array<{
    name: string;
    required: boolean;
    baselineValid: boolean;
    candidateValid: boolean;
    change: "improved" | "regressed" | "unchanged";
  }>;
  metrics: Array<{
    name: NavigationIslandMetricName;
    baseline: number;
    candidate: number;
    delta: number;
    change: "improved" | "regressed" | "unchanged";
  }>;
  improvements: string[];
  regressions: string[];
  unchangedRequiredAnchorFailures: string[];
};

type NavigationIslandComparisonSource = {
  reportSha256: string;
  auditConfigSha256: string;
  cacheCanonicalSha256: string;
  cacheParts: number;
  cacheBytes: number;
};

type AuditProvenance = {
  configSha256?: unknown;
  scopeSchema?: unknown;
  scopeSha256?: unknown;
  cache?: {
    parts?: unknown;
    totalBytes?: unknown;
    canonicalSha256?: unknown;
  };
  topologyOnly?: unknown;
  streamSpacing?: unknown;
  streamSamples?: unknown;
  polygonSelection?: unknown;
};

const SHA256 = /^[a-f0-9]{64}$/;
const SURFACE_AREA_EPSILON = 1e-6;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and non-negative`);
  }
  return value;
}

function validSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function runtimeScope(provenance: AuditProvenance): AuditRuntimeScope {
  if (typeof provenance.topologyOnly !== "boolean") {
    throw new Error("audit provenance topologyOnly is missing");
  }
  if (typeof provenance.polygonSelection !== "string") {
    throw new Error("audit provenance polygonSelection is missing");
  }
  return {
    topologyOnly: provenance.topologyOnly,
    streamSpacing: finiteNonNegative(
      provenance.streamSpacing,
      "audit provenance streamSpacing"
    ),
    streamSamples: finiteNonNegative(
      provenance.streamSamples,
      "audit provenance streamSamples"
    ),
    polygonSelection: provenance.polygonSelection
  };
}

function reportProvenance(
  report: NavigationIslandAuditReport
): AuditProvenance {
  if (!report.provenance || typeof report.provenance !== "object") {
    throw new Error("navigation island audit report has no provenance");
  }
  return report.provenance as AuditProvenance;
}

function source(
  report: NavigationIslandAuditReport,
  binding: NavigationIslandReportBinding,
  label: string
): NavigationIslandComparisonSource {
  const provenance = reportProvenance(report);
  const parts = provenance.cache?.parts;
  if (!Array.isArray(parts) || !parts.length) {
    throw new Error(`${label} audit provenance has no cache parts`);
  }
  return {
    reportSha256: validSha256(binding.reportSha256, `${label} reportSha256`),
    auditConfigSha256: validSha256(
      provenance.configSha256,
      `${label} audit configSha256`
    ),
    cacheCanonicalSha256: validSha256(
      provenance.cache?.canonicalSha256,
      `${label} cache canonicalSha256`
    ),
    cacheParts: parts.length,
    cacheBytes: finiteNonNegative(
      provenance.cache?.totalBytes,
      `${label} cache totalBytes`
    )
  };
}

function anchorScope(report: NavigationIslandAuditReport) {
  const seen = new Set<string>();
  return report.anchors
    .map((anchor) => {
      if (
        !anchor.name ||
        seen.has(anchor.name) ||
        typeof anchor.required !== "boolean" ||
        typeof anchor.valid !== "boolean"
      ) {
        throw new Error(`invalid or duplicate audit anchor ${anchor.name}`);
      }
      seen.add(anchor.name);
      return { name: anchor.name, required: anchor.required };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function derivedScope(report: NavigationIslandAuditReport) {
  const provenance = reportProvenance(report);
  return {
    schema: NAVIGATION_ISLAND_SCOPE_SCHEMA,
    auditSchemaVersion: report.schemaVersion,
    auditAlgorithm: report.algorithm,
    name: report.name,
    bounds: report.bounds,
    filter: report.filter,
    underFloorBelowY: report.underFloorBelowY,
    anchors: anchorScope(report),
    runtime: runtimeScope(provenance)
  };
}

export function createNavigationIslandAuditScope(
  config: NavigationIslandAuditConfig,
  runtime: AuditRuntimeScope
): { schema: string; sha256: string } {
  const scope = {
    schema: NAVIGATION_ISLAND_SCOPE_SCHEMA,
    auditAlgorithm: NAVIGATION_ISLAND_AUDIT_ALGORITHM,
    name: config.name,
    bounds: config.bounds,
    filter: {
      includeFlags: config.includeFlags ?? 0xffff,
      excludeFlags: config.excludeFlags ?? 0
    },
    underFloorBelowY: config.underFloorBelowY ?? null,
    anchors: config.anchors
      .map((anchor) => ({
        name: anchor.name,
        required: anchor.required !== false,
        position: anchor.position,
        halfExtents: anchor.halfExtents ?? [2, 2, 2],
        maxHorizontalSnap:
          anchor.maxHorizontalSnap ?? anchor.halfExtents?.[0] ?? 2,
        maxVerticalSnap: anchor.maxVerticalSnap ?? anchor.halfExtents?.[1] ?? 2
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    runtime
  };
  return { schema: NAVIGATION_ISLAND_SCOPE_SCHEMA, sha256: sha256(scope) };
}

function explicitScope(report: NavigationIslandAuditReport): string | null {
  const provenance = reportProvenance(report);
  const schema = provenance.scopeSchema;
  const digest = provenance.scopeSha256;
  if (schema === undefined && digest === undefined) return null;
  if (schema !== NAVIGATION_ISLAND_SCOPE_SCHEMA) {
    throw new Error(
      `unsupported navigation island scope schema ${String(schema)}`
    );
  }
  return validSha256(digest, "audit provenance scopeSha256");
}

function validateReport(report: NavigationIslandAuditReport, label: string) {
  if (report.schemaVersion !== 2) {
    throw new Error(`${label} audit schema must be 2`);
  }
  if (report.algorithm !== NAVIGATION_ISLAND_AUDIT_ALGORITHM) {
    throw new Error(`${label} audit algorithm is incompatible`);
  }
  for (const [name, value] of Object.entries(report.stats)) {
    finiteNonNegative(value, `${label} stats.${name}`);
  }
  anchorScope(report);
  const runtime = runtimeScope(reportProvenance(report));
  if (!runtime.topologyOnly) {
    throw new Error(
      `${label} audit must be topology-only for regression gating`
    );
  }
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function compareNavigationIslandAuditReports(
  baseline: NavigationIslandAuditReport,
  candidate: NavigationIslandAuditReport,
  bindings: {
    baseline: NavigationIslandReportBinding;
    candidate: NavigationIslandReportBinding;
  }
): NavigationIslandComparisonReport {
  validateReport(baseline, "baseline");
  validateReport(candidate, "candidate");

  const baselineExplicitScope = explicitScope(baseline);
  const candidateExplicitScope = explicitScope(candidate);
  if (Boolean(baselineExplicitScope) !== Boolean(candidateExplicitScope)) {
    throw new Error(
      "navigation island reports mix explicit and legacy scope provenance"
    );
  }

  const baselineDerivedScope = derivedScope(baseline);
  const candidateDerivedScope = derivedScope(candidate);
  if (canonical(baselineDerivedScope) !== canonical(candidateDerivedScope)) {
    throw new Error(
      "navigation island reports do not share the same bounded audit scope"
    );
  }

  let scopeBinding: "explicit-scope-sha256" | "derived-report-fields" =
    "derived-report-fields";
  let scopeSha256 = sha256(baselineDerivedScope);
  if (baselineExplicitScope && candidateExplicitScope) {
    if (baselineExplicitScope !== candidateExplicitScope) {
      throw new Error(
        "navigation island reports do not share the same explicit scope hash"
      );
    }
    scopeBinding = "explicit-scope-sha256";
    scopeSha256 = baselineExplicitScope;
  }

  const baselineAnchors = new Map(
    baseline.anchors.map((anchor) => [anchor.name, anchor])
  );
  const anchors = candidate.anchors
    .map((after) => {
      const before = baselineAnchors.get(after.name)!;
      const change =
        before.valid === after.valid
          ? "unchanged"
          : after.valid
            ? "improved"
            : "regressed";
      return {
        name: after.name,
        required: after.required,
        baselineValid: before.valid,
        candidateValid: after.valid,
        change
      } as const;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const metricDefinitions: Array<{
    name: NavigationIslandMetricName;
    baseline: number;
    candidate: number;
    epsilon: number;
  }> = [
    {
      name: "unreachablePolygons",
      baseline: baseline.stats.unreachableAuditedPolygons,
      candidate: candidate.stats.unreachableAuditedPolygons,
      epsilon: 0
    },
    {
      name: "unreachableSurfaceArea",
      baseline: baseline.stats.unreachableSurfaceArea,
      candidate: candidate.stats.unreachableSurfaceArea,
      epsilon: SURFACE_AREA_EPSILON
    },
    {
      name: "unreachableComponents",
      baseline: baseline.stats.unreachableComponents,
      candidate: candidate.stats.unreachableComponents,
      epsilon: 0
    },
    {
      name: "underFloorComponents",
      baseline: baseline.stats.underFloorComponents,
      candidate: candidate.stats.underFloorComponents,
      epsilon: 0
    },
    {
      name: "unresolvedLinks",
      baseline: baseline.stats.unresolvedLinks,
      candidate: candidate.stats.unresolvedLinks,
      epsilon: 0
    }
  ];
  const metrics = metricDefinitions.map((metric) => {
    const rawDelta = metric.candidate - metric.baseline;
    const delta = round(rawDelta);
    const change =
      rawDelta > metric.epsilon
        ? "regressed"
        : rawDelta < -metric.epsilon
          ? "improved"
          : "unchanged";
    return {
      name: metric.name,
      baseline: metric.baseline,
      candidate: metric.candidate,
      delta,
      change
    } as const;
  });

  const improvements = [
    ...anchors
      .filter((anchor) => anchor.required && anchor.change === "improved")
      .map((anchor) => `required-anchor:${anchor.name}`),
    ...metrics
      .filter((metric) => metric.change === "improved")
      .map((metric) => `${metric.name}:${metric.baseline}->${metric.candidate}`)
  ].sort();
  const regressions = [
    ...anchors
      .filter((anchor) => anchor.required && anchor.change === "regressed")
      .map((anchor) => `required-anchor:${anchor.name}`),
    ...metrics
      .filter((metric) => metric.change === "regressed")
      .map((metric) => `${metric.name}:${metric.baseline}->${metric.candidate}`)
  ].sort();
  const unchangedRequiredAnchorFailures = anchors
    .filter(
      (anchor) =>
        anchor.required &&
        !anchor.candidateValid &&
        anchor.change === "unchanged"
    )
    .map((anchor) => anchor.name)
    .sort();

  return {
    schemaVersion: 1,
    algorithm: NAVIGATION_ISLAND_COMPARISON_ALGORITHM,
    passed: regressions.length === 0,
    reasons: regressions.map((regression) => `regression:${regression}`),
    scope: {
      schema: NAVIGATION_ISLAND_SCOPE_SCHEMA,
      binding: scopeBinding,
      sha256: scopeSha256
    },
    sources: {
      baseline: source(baseline, bindings.baseline, "baseline"),
      candidate: source(candidate, bindings.candidate, "candidate")
    },
    anchors,
    metrics,
    improvements,
    regressions,
    unchangedRequiredAnchorFailures
  };
}
