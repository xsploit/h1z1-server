// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { CrowdAgent, Vector3 } from "recast-navigation";
import { NavManager } from "../src/utils/recast";
import { navigationRuntime as R } from "../src/utils/navigationruntime";

type Distribution = {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length
      ? sorted.reduce((total, value) => total + value, 0) / sorted.length
      : null
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssMiB: Number((memory.rss / 1048576).toFixed(1)),
    heapUsedMiB: Number((memory.heapUsed / 1048576).toFixed(1)),
    wasmHeapMiB: Number(
      (Number(R.Raw.Module.HEAPU8?.byteLength ?? 0) / 1048576).toFixed(1)
    )
  };
}

function randomPoint(manager: NavManager): Vector3 {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = manager.navMeshQuery.findRandomPoint();
    if (
      result.success &&
      Number.isFinite(result.randomPoint.x) &&
      Number.isFinite(result.randomPoint.y) &&
      Number.isFinite(result.randomPoint.z)
    ) {
      return result.randomPoint;
    }
  }
  throw new Error("[NAV-BENCH] failed to sample a random navmesh point");
}

function addAgent(manager: NavManager): CrowdAgent {
  const point = randomPoint(manager);
  const agent = manager.createAgent(
    new Float32Array([point.x, point.y, point.z, 0])
  );
  if (!agent) throw new Error("[NAV-BENCH] failed to create crowd agent");
  return agent;
}

function localTarget(manager: NavManager, agent: CrowdAgent): Vector3 {
  const center = agent.position();
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = manager.navMeshQuery.findRandomPointAroundCircle(center, 75);
    if (
      result.success &&
      Number.isFinite(result.randomPoint.x) &&
      Number.isFinite(result.randomPoint.y) &&
      Number.isFinite(result.randomPoint.z)
    ) {
      return result.randomPoint;
    }
  }
  throw new Error("[NAV-BENCH] failed to sample a local replan target");
}

function stepCrowd(manager: NavManager): number {
  const startedAt = performance.now();
  manager.crowd.update(manager.updateFrequency);
  return performance.now() - startedAt;
}

async function main() {
  if (process.env.NAV_MONOLITHIC_64 !== "1") {
    throw new Error("[NAV-BENCH] NAV_MONOLITHIC_64=1 is required");
  }
  const populations = (process.env.NAV_BENCH_POPULATIONS ?? "500,1000,2000")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0)
    .sort((a, b) => a - b);
  if (!populations.length || populations.at(-1)! > 2000) {
    throw new Error("[NAV-BENCH] populations must be integers from 1 to 2000");
  }
  const sampleTicks = parsePositiveInt(process.env.NAV_BENCH_TICKS, 180);
  const maxReplanTicks = parsePositiveInt(
    process.env.NAV_BENCH_REPLAN_TICKS,
    600
  );
  const reportPath = process.env.NAV_BENCH_REPORT;

  const manager = new NavManager();
  const loadStartedAt = performance.now();
  await manager.loadNav();
  const loadSeconds = (performance.now() - loadStartedAt) / 1000;
  const agents: CrowdAgent[] = [];
  const results = [];

  for (const population of populations) {
    const addStartedAt = performance.now();
    while (agents.length < population) agents.push(addAgent(manager));
    const addSeconds = (performance.now() - addStartedAt) / 1000;
    if (manager.crowd.getActiveAgentCount() !== population) {
      throw new Error(
        `[NAV-BENCH] active-agent mismatch at ${population}: ` +
          manager.crowd.getActiveAgentCount()
      );
    }

    const requestStartedAt = performance.now();
    const pending = new Map<number, CrowdAgent>();
    let requestFailures = 0;
    for (const agent of agents) {
      if (agent.requestMoveTarget(localTarget(manager, agent))) {
        pending.set(agent.agentIndex, agent);
      } else {
        requestFailures++;
      }
    }
    const requestSeconds = (performance.now() - requestStartedAt) / 1000;

    const readyTicks: number[] = [];
    const replanUpdateMs: number[] = [];
    let targetFailures = 0;
    let replanTicks = 0;
    const validState = R.Detour.DT_CROWDAGENT_TARGET_VALID;
    const failedState = R.Detour.DT_CROWDAGENT_TARGET_FAILED;
    while (pending.size && replanTicks < maxReplanTicks) {
      replanTicks++;
      replanUpdateMs.push(stepCrowd(manager));
      for (const [agentIndex, agent] of pending) {
        const state = agent.raw.targetState;
        if (state === validState) {
          readyTicks.push(replanTicks);
          pending.delete(agentIndex);
        } else if (state === failedState) {
          targetFailures++;
          pending.delete(agentIndex);
        }
      }
    }

    const movingUpdateMs: number[] = [];
    for (let tick = 0; tick < sampleTicks; tick++) {
      movingUpdateMs.push(stepCrowd(manager));
    }

    const result = {
      population,
      addSeconds: Number(addSeconds.toFixed(3)),
      requestSeconds: Number(requestSeconds.toFixed(3)),
      requestFailures,
      targetFailures,
      timedOutTargets: pending.size,
      replanTicks,
      replanReadyTicks: distribution(readyTicks),
      replanUpdateMs: distribution(replanUpdateMs),
      movingUpdateMs: distribution(movingUpdateMs),
      memory: memorySnapshot()
    };
    results.push(result);
    console.log(`[NAV-BENCH] ${JSON.stringify(result)}`);
  }

  const report = {
    mode: "DT_POLYREF64-monolithic-full-population",
    timestamp: new Date().toISOString(),
    populations,
    sampleTicks,
    maxReplanTicks,
    loadSeconds: Number(loadSeconds.toFixed(3)),
    results
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(resolve(reportPath), serialized);
  process.stdout.write(serialized);
  for (const agent of agents) manager.removeAgent(agent);
  (manager as any).destroyStreamingRuntime();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
