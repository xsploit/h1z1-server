process.env.DISABLE_PLUGINS = "true";
process.env.FORCE_DISABLE_WS = "true";
process.env.NAV_STREAMING = "1";

const center = new Float32Array([
  Number(process.argv[2] ?? 966.83),
  Number(process.argv[3] ?? 14),
  Number(process.argv[4] ?? -2691.36),
  1
]);
const spawnedNpcCount = Number(process.argv[5] ?? 500);
const crowdSteps = Number(process.argv[6] ?? 1000);

async function main() {
  const { ZoneServer2016 } =
    await import("../src/servers/ZoneServer2016/zoneserver");
  const { ModelIds } =
    await import("../src/servers/ZoneServer2016/models/enums");
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
  server.navManager.streamAround([center]);

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
  const playerAgent = server.navManager.createPassiveAgent(center);
  if (!playerAgent)
    throw new Error("failed to create saved-player passive agent");
  wrappers.push(playerAgent);
  const validationPlayerId = "validation-player";
  server._characters[validationPlayerId] = {
    characterId: validationPlayerId,
    isAlive: true,
    isVanished: false,
    isHidden: false,
    isSpectator: false,
    state: { position: center },
    navAgent: playerAgent,
    OnProjectileHit: () => undefined
  } as never;
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
  for (let i = 0; i < crowdSteps; i++) {
    rebuildAiTargetMap();
    tickNpcFsms(0.2);
    server.updatePathfindingPositions();
    if (!server.navManager.teleportAgent(playerAgent, center)) {
      throw new Error("saved-player teleport validation failed");
    }
    for (const vehicle of vehicleWrappers) {
      if (!server.navManager.teleportAgent(vehicle.agent, vehicle.position)) {
        throw new Error("world-vehicle teleport validation failed");
      }
    }
    // Use the fixed-step form directly. NavManager.updt() measures wall time,
    // so a tight validation loop otherwise performs almost no native crowd
    // updates after its first iteration.
    server.navManager.crowd.update(server.navManager.updateFrequency);
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
