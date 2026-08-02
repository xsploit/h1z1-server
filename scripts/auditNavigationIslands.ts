import { createHash } from "node:crypto";
import {
  createReadStream,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  createRegionalStreamSamples,
  evaluateNavigationIslandAudit,
  extractNavigationTopology,
  NavigationAuditAnchor,
  NavigationAuditPoint,
  NavigationIslandAuditConfig,
  resolveNavigationAuditAnchors
} from "../src/utils/navigationislandaudit";
import { createNavigationIslandAuditScope } from "../src/utils/navigationislandcomparison";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function numberOption(name: string, fallback: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function parseNumbers(raw: string, count: number, label: string): number[] {
  const values = raw.split(",").map(Number);
  if (
    values.length !== count ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`${label} must contain ${count} comma-separated numbers`);
  }
  return values;
}

function parseAnchor(raw: string): NavigationAuditAnchor {
  const [name, positionRaw, halfExtentsRaw] = raw.split(":");
  if (!name || !positionRaw || raw.split(":").length > 3) {
    throw new Error("--anchor must use name:x,y,z[:halfX,halfY,halfZ] syntax");
  }
  return {
    name,
    position: parseNumbers(
      positionRaw,
      3,
      `anchor ${name} position`
    ) as NavigationAuditPoint,
    halfExtents: halfExtentsRaw
      ? (parseNumbers(
          halfExtentsRaw,
          3,
          `anchor ${name} half extents`
        ) as NavigationAuditPoint)
      : [2, 2, 2],
    maxHorizontalSnap: numberOption("--max-anchor-horizontal-snap", 2),
    maxVerticalSnap: numberOption("--max-anchor-vertical-snap", 2)
  };
}

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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveStream);
  });
  return hash.digest("hex");
}

async function cacheProvenance(directory: string) {
  const parts = readdirSync(directory)
    .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
    .sort(
      (left, right) =>
        Number(left.match(/(\d+)\.bin$/)?.[1]) -
        Number(right.match(/(\d+)\.bin$/)?.[1])
    );
  if (!parts.length) throw new Error("no z1_cache_*.bin parts found");
  const records = [];
  for (const part of parts) {
    const path = join(directory, part);
    records.push({
      path: basename(path),
      bytes: statSync(path).size,
      sha256: await sha256File(path)
    });
  }
  return {
    parts: records,
    totalBytes: records.reduce((sum, record) => sum + record.bytes, 0),
    canonicalSha256: createHash("sha256")
      .update(canonical(records))
      .digest("hex")
  };
}

const cacheDirectory = option("--cache-dir");
const boundsRaw = option("--bounds");
const anchorRaw = options("--anchor");
const reportPath = option("--report");
if (!cacheDirectory || !boundsRaw || !anchorRaw.length) {
  console.error(
    "Usage: npx tsx scripts/auditNavigationIslands.ts --cache-dir <dir> " +
      "--bounds minX,minY,minZ,maxX,maxY,maxZ " +
      "--anchor name:x,y,z[:halfX,halfY,halfZ] [--anchor ...] " +
      "[--under-floor-below <y>] [--report <file>] [--allow-transitions]"
  );
  process.exit(1);
}

const boundsValues = parseNumbers(boundsRaw, 6, "--bounds");
const underFloorRaw = option("--under-floor-below");
const config: NavigationIslandAuditConfig = {
  name: option("--name") ?? "bounded-navigation-island-audit",
  bounds: {
    min: boundsValues.slice(0, 3) as NavigationAuditPoint,
    max: boundsValues.slice(3, 6) as NavigationAuditPoint
  },
  anchors: anchorRaw.map(parseAnchor),
  includeFlags: numberOption("--include-flags", 0xffff),
  excludeFlags: numberOption("--exclude-flags", 0),
  underFloorBelowY:
    underFloorRaw === undefined
      ? undefined
      : numberOption("--under-floor-below", 0),
  limits: {
    maxUnreachableComponents: numberOption("--max-unreachable-components", 0),
    maxUnreachablePolygons: numberOption("--max-unreachable-polygons", 0),
    maxUnreachableSurfaceArea: numberOption(
      "--max-unreachable-surface-area",
      0
    ),
    maxUnderFloorComponents: numberOption("--max-under-floor-components", 0)
  }
};
const streamSpacing = numberOption("--stream-spacing", 250);
const maxStreamSamples = numberOption("--max-stream-samples", 64);
const allowTransitions = process.argv.includes("--allow-transitions");

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);
if (!allowTransitions) process.env.NAV_TRANSITIONS = "0";

async function main() {
  const samples = createRegionalStreamSamples(config.bounds, streamSpacing);
  if (samples.length > maxStreamSamples) {
    throw new Error(
      `regional audit requires ${samples.length} stream samples, above limit ${maxStreamSamples}`
    );
  }
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");
  nav.streamAround(
    [...samples, ...config.anchors.map((anchor) => anchor.position)].map(
      (position) => new Float32Array([...position, 1])
    )
  );

  const topology = extractNavigationTopology(nav.navmesh);
  const anchors = resolveNavigationAuditAnchors(
    config,
    nav.navMeshQuery,
    topology
  );
  const report = evaluateNavigationIslandAudit(config, topology, anchors);
  const topologyOnly = !allowTransitions;
  const scope = createNavigationIslandAuditScope(config, {
    topologyOnly,
    streamSpacing,
    streamSamples: samples.length,
    polygonSelection: "centroid-inside-3d-bounds"
  });
  report.provenance = {
    configSha256: createHash("sha256").update(canonical(config)).digest("hex"),
    configSource: "command-line-v1",
    scopeSchema: scope.schema,
    scopeSha256: scope.sha256,
    cache: await cacheProvenance(resolve(cacheDirectory)),
    topologyOnly,
    streamSpacing,
    streamSamples: samples.length,
    polygonSelection: "centroid-inside-3d-bounds"
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), serialized);
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
