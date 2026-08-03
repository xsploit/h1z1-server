import { resolve } from "node:path";
import {
  loadNavigationValidationConfig,
  NavigationProbeTuple
} from "../src/utils/navigationvalidation";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cacheDirectory = option("--cache-dir");
if (!cacheDirectory) {
  console.error(
    "Usage: npx tsx scripts/validateNavigationCrowdRoutes.ts --cache-dir <collision-dir> [--config <file>] [--region <name>] [--segment <name>] [--steps <count>] [--step-seconds <seconds>] [--summary]"
  );
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);
process.env.NAV_TRANSITIONS ??= "1";

const configPath = resolve(
  option("--config") ?? "data/2016/navigationValidationRegions.pvEvidence.json"
);
const selectedRegion = option("--region");
const selectedSegment = option("--segment");
const maximumSteps = Number(option("--steps") ?? 600);
const stepSeconds = Number(option("--step-seconds") ?? 0.05);
const summaryOnly = process.argv.includes("--summary");

if (!Number.isInteger(maximumSteps) || maximumSteps <= 0) {
  throw new Error("--steps must be a positive integer");
}
if (!Number.isFinite(stepSeconds) || stepSeconds <= 0 || stepSeconds > 1) {
  throw new Error("--step-seconds must be greater than zero and at most one");
}

function asGamePosition(position: NavigationProbeTuple): Float32Array {
  return new Float32Array([position[0], position[1], position[2], 1]);
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function horizontalDistanceToSegment(
  position: { x: number; z: number },
  start: { x: number; z: number },
  end: { x: number; z: number }
): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) {
    return Math.hypot(position.x - start.x, position.z - start.z);
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((position.x - start.x) * dx + (position.z - start.z) * dz) /
        lengthSquared
    )
  );
  return Math.hypot(
    position.x - (start.x + projection * dx),
    position.z - (start.z + projection * dz)
  );
}

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const config = loadNavigationValidationConfig(configPath);
  const regions = selectedRegion
    ? config.regions.filter((region) => region.name === selectedRegion)
    : config.regions;
  if (!regions.length) {
    throw new Error(`navigation region not found: ${selectedRegion}`);
  }

  const nav = new NavManager();
  await nav.loadNav();
  if (!nav.streaming) throw new Error("streaming cache did not load");

  const streamPositions = regions.flatMap((region) =>
    region.anchors
      .filter((anchor) => !anchor.mustBeOffNavmesh)
      .map((anchor) => asGamePosition(anchor.position))
  );
  Object.assign(nav as object, { _lastStreamMs: 0 });
  nav.streamAround(streamPositions);

  const results: Array<Record<string, unknown>> = [];
  const realDateNow = Date.now;
  let simulatedNow = realDateNow();
  Date.now = () => simulatedNow;
  try {
    for (const region of regions) {
      const anchors = new Map(
        region.anchors.map((anchor) => [anchor.name, anchor])
      );
      for (const segment of region.segments) {
        if (selectedSegment && segment.name !== selectedSegment) continue;
        const from = anchors.get(segment.from);
        const to = anchors.get(segment.to);
        if (!from || !to || from.mustBeOffNavmesh || to.mustBeOffNavmesh) {
          continue;
        }

        const start = asGamePosition(from.position);
        const target = asGamePosition(to.position);
        const startSnap = nav.findNearestPolyOnFloor(start, 2);
        const targetSnap = nav.findNearestPolyOnFloor(target, 2);
        const tolerance = segment.reachTolerance ?? 0.6;
        if (!startSnap.nearestRef || !targetSnap.nearestRef) {
          results.push({
            region: region.name,
            segment: segment.name,
            passed: false,
            failure: "anchor did not snap to the loaded navmesh",
            startRef: startSnap.nearestRef,
            targetRef: targetSnap.nearestRef
          });
          continue;
        }

        const agent = nav.createAgent(start);
        if (!agent) {
          results.push({
            region: region.name,
            segment: segment.name,
            passed: false,
            failure: "crowd agent could not be created"
          });
          continue;
        }

        const accepted = agent.requestMoveTarget(targetSnap.nearestPoint);
        let closestDistance = distance(
          agent.position(),
          targetSnap.nearestPoint
        );
        let finalDistance = closestDistance;
        let steps = 0;
        let walkingSteps = 0;
        let offMeshSteps = 0;
        let invalidSteps = 0;
        let stationarySteps = 0;
        let previous = agent.position();
        let maxLateralDeviation = horizontalDistanceToSegment(
          previous,
          startSnap.nearestPoint,
          targetSnap.nearestPoint
        );
        const sampledPositions: Array<[number, number, number]> = [
          [previous.x, previous.y, previous.z]
        ];

        if (accepted) {
          for (; steps < maximumSteps && finalDistance > tolerance; steps++) {
            simulatedNow += stepSeconds * 1000;
            nav.updt();
            const current = agent.position();
            const state = agent.state();
            if (state === 0) invalidSteps++;
            else if (state === 1) walkingSteps++;
            else if (state === 2) offMeshSteps++;
            const movement = distance(current, previous);
            stationarySteps = movement < 0.001 ? stationarySteps + 1 : 0;
            previous = current;
            maxLateralDeviation = Math.max(
              maxLateralDeviation,
              horizontalDistanceToSegment(
                current,
                startSnap.nearestPoint,
                targetSnap.nearestPoint
              )
            );
            finalDistance = distance(current, targetSnap.nearestPoint);
            closestDistance = Math.min(closestDistance, finalDistance);
            if (steps % 20 === 0 || finalDistance <= tolerance) {
              sampledPositions.push([current.x, current.y, current.z]);
            }
            if (!nav.crowdHealthy || stationarySteps >= 100) break;
          }
        }

        const passed =
          accepted &&
          nav.crowdHealthy &&
          finalDistance <= tolerance &&
          (segment.maxLateralDeviation === undefined ||
            maxLateralDeviation <= segment.maxLateralDeviation);
        const result: Record<string, unknown> = {
          region: region.name,
          segment: segment.name,
          passed,
          accepted,
          steps,
          elapsedSeconds: Number((steps * stepSeconds).toFixed(2)),
          tolerance,
          closestDistance: Number(closestDistance.toFixed(3)),
          finalDistance: Number(finalDistance.toFixed(3)),
          maxLateralDeviation: Number(maxLateralDeviation.toFixed(3)),
          allowedLateralDeviation: segment.maxLateralDeviation ?? null,
          finalState: agent.state(),
          walkingSteps,
          offMeshSteps,
          invalidSteps,
          stationarySteps,
          start: startSnap.nearestPoint,
          target: targetSnap.nearestPoint,
          final: agent.position()
        };
        if (!summaryOnly) result.sampledPositions = sampledPositions;
        results.push(result);
        nav.removeAgent(agent);
      }
    }
  } finally {
    Date.now = realDateNow;
  }

  if (selectedSegment && !results.length) {
    throw new Error(`navigation segment not found: ${selectedSegment}`);
  }

  const passed = results.length > 0 && results.every((result) => result.passed);
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        cacheDirectory: resolve(cacheDirectory),
        configPath,
        passed,
        routes: results
      },
      null,
      2
    )
  );
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
