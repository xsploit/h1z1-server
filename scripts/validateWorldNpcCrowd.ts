process.env.DISABLE_PLUGINS = "true";
process.env.FORCE_DISABLE_WS = "true";
process.env.NAV_STREAMING = "1";
const compiledRuntime = process.argv[7] === "compiled";
const routeToCenter = process.argv[9] === "route";
const routeStart = new Float32Array([-125.55, 23.41, -1131.71, 1]);
if (process.argv[8]) {
  process.env.NAV_CACHE_DIR = require("node:path").resolve(process.argv[8]);
}

const center = new Float32Array([
  Number(process.argv[2] ?? 966.83),
  Number(process.argv[3] ?? 14),
  Number(process.argv[4] ?? -2691.36),
  1
]);
const spawnedNpcCount = Number(process.argv[5] ?? 500);
const crowdSteps = Number(process.argv[6] ?? 1000);

async function main() {
  const { ZoneServer2016 } = compiledRuntime
    ? require("../out/servers/ZoneServer2016/zoneserver")
    : await import("../src/servers/ZoneServer2016/zoneserver");
  const { ModelIds } = compiledRuntime
    ? require("../out/servers/ZoneServer2016/models/enums")
    : await import("../src/servers/ZoneServer2016/models/enums");
  const server = new ZoneServer2016(
    12117,
    Buffer.from("F70IaxuU8C/w7FPXY1ibXw==", "base64"),
    undefined,
    2
  );
  await server.start();

  const deadline = Date.now() + 30_000;
  while (Object.keys(server._npcs).length < 700 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const internals = server as unknown as {
    aiTickRoutine?: NodeJS.Timeout;
    pathfindingRoutine?: NodeJS.Timeout;
    recastRoutine?: NodeJS.Timeout;
  };
  if (internals.aiTickRoutine) clearInterval(internals.aiTickRoutine);
  if (internals.pathfindingRoutine) clearInterval(internals.pathfindingRoutine);
  if (internals.recastRoutine) clearInterval(internals.recastRoutine);

  Object.assign(server.navManager as object, { _lastStreamMs: 0 });
  server.navManager.streamAround([routeToCenter ? routeStart : center]);

  const centerSnap = server.navManager.navMeshQuery.findNearestPoly(
    { x: center[0], y: center[1], z: center[2] },
    { halfExtents: { x: 5, y: 10, z: 5 } }
  );
  if (!centerSnap.nearestRef) throw new Error("saved position is off navmesh");
  for (let i = 0; i < spawnedNpcCount; i++) {
    const point = server.navManager.navMeshQuery.findRandomPointAroundCircle(
      centerSnap.nearestPoint,
      10
    );
    if (!point.success) continue;
    server.worldObjectManager.createNpc(
      server,
      ModelIds.SURVIVOR_MALE_HEAD_01,
      new Float32Array([
        point.randomPoint.x,
        point.randomPoint.y,
        point.randomPoint.z,
        1
      ]),
      new Float32Array([0, 0, 0, 1])
    );
  }

  const wrappers = [];
  const vehicleWrappers = [];
  let npcAgents = 0;
  let vehicleAgents = 0;
  const playerAgent = server.navManager.createPassiveAgent(
    routeToCenter ? routeStart : center
  );
  if (!playerAgent)
    throw new Error("failed to create saved-player passive agent");
  wrappers.push(playerAgent);
  const validationPlayerId = "validation-player";
  const validationCharacter = {
    characterId: validationPlayerId,
    isAlive: true,
    isVanished: false,
    isHidden: false,
    isSpectator: false,
    state: { position: routeToCenter ? routeStart : center },
    navAgent: playerAgent,
    OnProjectileHit: () => undefined
  };
  server._characters[validationPlayerId] = validationCharacter as never;
  for (const npc of Object.values(server._npcs)) {
    const agent =
      npc.navAgent ?? server.navManager.createAgent(npc.state.position);
    if (!agent) continue;
    npc.navAgent = agent;
    wrappers.push(agent);
    agent.requestMoveTarget(centerSnap.nearestPoint);
    npcAgents++;
  }
  for (const vehicle of Object.values(server._vehicles)) {
    const agent = server.navManager.createPassiveAgent(
      vehicle.state.position,
      2
    );
    if (!agent) continue;
    vehicle.navAgent = agent;
    wrappers.push(agent);
    vehicleWrappers.push({ agent, position: vehicle.state.position });
    vehicleAgents++;
  }

  const invalidIndexes = wrappers
    .map((agent) => agent.agentIndex)
    .filter(
      (agentIndex) =>
        !Number.isInteger(agentIndex) || agentIndex < 0 || agentIndex >= 1000
    );
  const aiInternals = server as unknown as {
    _rebuildAiTargetMap(): void;
    tickNpcFsms(dt: number): void;
  };
  const rebuildAiTargetMap = aiInternals._rebuildAiTargetMap.bind(server);
  const tickNpcFsms = aiInternals.tickNpcFsms.bind(server);
  const realDateNow = Date.now;
  let simulatedNow = realDateNow();
  Date.now = () => simulatedNow;
  try {
    for (let i = 0; i < crowdSteps; i++) {
      simulatedNow += 200;
      if (routeToCenter) {
        const progress = Math.min(1, i / Math.max(1, crowdSteps - 1));
        validationCharacter.state.position = new Float32Array([
          routeStart[0] + (center[0] - routeStart[0]) * progress,
          routeStart[1] + (center[1] - routeStart[1]) * progress,
          routeStart[2] + (center[2] - routeStart[2]) * progress,
          1
        ]);
      }
      rebuildAiTargetMap();
      tickNpcFsms(0.2);
      server.updatePathfindingPositions();
      // Exercise the same obstacle-mutation and interpolated crowd-update path
      // as the live server while advancing one deterministic fixed step.
      server.navManager.updt();
      if (!server.navManager.crowdHealthy) {
        throw new Error(`crowd faulted on live update ${i}`);
      }
    }
  } finally {
    Date.now = realDateNow;
  }

  console.log(
    JSON.stringify({
      worldNpcs: Object.keys(server._npcs).length,
      worldVehicles: Object.keys(server._vehicles).length,
      center: Array.from(center.slice(0, 3)),
      crowdSteps,
      npcAgents,
      vehicleAgents,
      wrapperCount: wrappers.length,
      activeAgents: server.navManager.crowd.getActiveAgentCount(),
      invalidIndexes,
      crowdHealthy: server.navManager.crowdHealthy
    })
  );
  process.exit(server.navManager.crowdHealthy ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
