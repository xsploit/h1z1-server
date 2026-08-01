import { resolve } from "node:path";
import type { CrowdAgent } from "recast-navigation";

const cacheDir = process.argv[2];
const agentsPerWindow = Number(process.argv[3] ?? 60);
const stepsPerWindow = Number(process.argv[4] ?? 25);
const transitionCount = Number(process.argv[5] ?? 12);
if (!cacheDir) {
  console.error(
    "Usage: npx tsx scripts/validateStreamingCrowdLifecycle.ts <cache-dir> [agents-per-window] [steps-per-window] [transition-count]"
  );
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();

  let agents: CrowdAgent[] = [];
  let invalidations = 0;
  nav.setAgentInvalidationHandler(() => {
    agents = [];
    invalidations++;
  });

  const validationCenters = [
    // Pleasant Valley police department: this layered interior previously
    // reproduced the native crowd heap corruption seen by the live server.
    new Float32Array([-1924.4, 62.6, -2148.8, 1]),
    new Float32Array([966.83, 14, -2691.36, 1]),
    new Float32Array([-125.55, 23.41, -1131.71, 1])
  ];
  const centers = Array.from(
    { length: transitionCount },
    (_, index) => validationCenters[index % validationCenters.length]
  );

  let created = 0;
  for (const center of centers) {
    Object.assign(nav as object, { _lastStreamMs: 0 });
    if (!nav.streamAround([center])) {
      throw new Error("expected stream window to change");
    }

    const points = [];
    for (let i = 0; i < 80; i++) {
      const result = nav.navMeshQuery.findRandomPoint();
      if (result.success) points.push(result.randomPoint);
    }
    if (points.length < 20) {
      throw new Error(
        `stream window produced only ${points.length} nav points`
      );
    }

    for (let i = 0; i < agentsPerWindow; i++) {
      const gamePoint = NavManager.navToGame(points[i % points.length]);
      const agent =
        i % 6 === 0
          ? nav.createPassiveAgent(gamePoint)
          : nav.createAgent(gamePoint);
      if (!agent) continue;
      agents.push(agent);
      created++;
      if (i % 6 !== 0) {
        agent.requestMoveTarget(points[(i + 7) % points.length]);
      }
    }

    for (let i = 0; i < stepsPerWindow; i++) {
      nav.crowd.update(nav.updateFrequency);
    }
    if (!nav.crowdHealthy) throw new Error("crowd faulted after stream change");
    for (const agent of agents) {
      const position = agent.position();
      if (
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(position.z)
      ) {
        throw new Error("crowd produced a non-finite agent position");
      }
    }
  }

  const obstacleSample = nav.navMeshQuery.findRandomPoint();
  if (!obstacleSample.success) {
    throw new Error("failed to find dynamic-obstacle test point");
  }
  const obstaclePoint = NavManager.navToGame(obstacleSample.randomPoint);
  const obstacle = nav.addObstacle(obstaclePoint, { x: 1, y: 2, z: 1 }, 0);
  if (!obstacle) throw new Error("failed to add lifecycle test obstacle");
  nav.updt();
  nav.removeObstacle(obstacle);
  nav.updt();
  if (!nav.crowdHealthy) {
    throw new Error("crowd faulted during dynamic-obstacle rebuild");
  }

  console.log(
    JSON.stringify({
      streamTransitions: centers.length,
      agentInvalidations: invalidations,
      agentsCreated: created,
      stepsPerWindow,
      crowdHealthy: nav.crowdHealthy
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
