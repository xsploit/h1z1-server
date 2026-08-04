import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

process.env.DISABLE_PLUGINS = "true";
process.env.FORCE_DISABLE_WS = "true";
process.env.NAV_STREAMING = "1";
const compiledRuntime = process.argv[7] === "compiled";
const movementMode = process.argv[9] ?? "static";
const routeToCenter = movementMode === "route";
const tourWorld = movementMode === "tour";
const churnObstacles = process.argv[10] === "churn";
const routeStart = new Float32Array([-125.55, 23.41, -1131.71, 1]);
const tourWaypoints = [
  routeStart,
  new Float32Array([-235.28, 22.22, -1152.39, 1]),
  new Float32Array([-696.48, 13.86, -1847.15, 1]),
  new Float32Array([-1924.4, 62.6, -2148.8, 1]),
  new Float32Array([-685, 69.96, 1185.49, 1]),
  new Float32Array([2185.32, 42.36, 2130.49, 1]),
  new Float32Array([2209.17, 47.42, -1011.48, 1]),
  new Float32Array([3824.41, 168.19, -4000, 1])
];
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
  const installedRuntimeRoot = process.env.H1Z1_VALIDATION_RUNTIME_ROOT;
  const runtimeModule = installedRuntimeRoot
    ? require(join(installedRuntimeRoot, "out/utils/navigationruntime"))
    : compiledRuntime
      ? require("../out/utils/navigationruntime")
      : await import("../src/utils/navigationruntime");
  const R = runtimeModule.navigationRuntime;
  const { ZoneServer2016 } = installedRuntimeRoot
    ? require(
        join(installedRuntimeRoot, "out/servers/ZoneServer2016/zoneserver")
      )
    : compiledRuntime
      ? require("../out/servers/ZoneServer2016/zoneserver")
      : await import("../src/servers/ZoneServer2016/zoneserver");
  const { ModelIds } = installedRuntimeRoot
    ? require(
        join(installedRuntimeRoot, "out/servers/ZoneServer2016/models/enums")
      )
    : compiledRuntime
      ? require("../out/servers/ZoneServer2016/models/enums")
      : await import("../src/servers/ZoneServer2016/models/enums");
  const { createFakeCharacter, createFakeZoneClient } = installedRuntimeRoot
    ? require(join(installedRuntimeRoot, "out/utils/test.utils"))
    : compiledRuntime
      ? require("../out/utils/test.utils")
      : await import("../src/utils/test.utils");
  const server = new ZoneServer2016(
    12117,
    Buffer.from("F70IaxuU8C/w7FPXY1ibXw==", "base64"),
    undefined,
    2
  );
  await server.start();
  server.sendData = () => {};
  server.sendUnbufferedData = () => {};
  server.sendOrderedData = () => {};

  const deadline = Date.now() + 30_000;
  let observedWorldRun = server.worldObjectManager.isRunning;
  while (Date.now() < deadline) {
    observedWorldRun ||= server.worldObjectManager.isRunning;
    if (observedWorldRun && !server.worldObjectManager.isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (server.worldObjectManager.isRunning) {
    throw new Error("world object generation did not finish before validation");
  }
  const internals = server as unknown as {
    aiTickRoutine?: NodeJS.Timeout;
    pathfindingRoutine?: NodeJS.Timeout;
    recastRoutine?: NodeJS.Timeout;
  };
  if (internals.aiTickRoutine) clearInterval(internals.aiTickRoutine);
  if (internals.pathfindingRoutine) clearInterval(internals.pathfindingRoutine);
  if (internals.recastRoutine) clearInterval(internals.recastRoutine);

  const initialPosition = tourWorld
    ? tourWaypoints[0]
    : routeToCenter
      ? routeStart
      : center;
  Object.assign(server.navManager as object, { _lastStreamMs: 0 });
  server.navManager.streamAround([initialPosition]);

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
  const snappedCenterPosition = new Float32Array([
    centerSnap.nearestPoint.x,
    centerSnap.nearestPoint.y,
    centerSnap.nearestPoint.z,
    1
  ]);
  const playerAgent =
    server.navManager.createPassiveAgent(initialPosition) ??
    server.navManager.createPassiveAgent(snappedCenterPosition);
  if (!playerAgent)
    throw new Error("failed to create saved-player passive agent");
  wrappers.push(playerAgent);
  const validationCharacter = createFakeCharacter(server);
  createFakeZoneClient(server, validationCharacter);
  validationCharacter.state.position = initialPosition;
  validationCharacter.navAgent = playerAgent;
  validationCharacter.godMode = true;
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

  const maxAgentIndexExclusive =
    process.env.NAV_MONOLITHIC_64 === "1" ? 2000 : 1000;
  const invalidIndexes = wrappers
    .map((agent) => agent.agentIndex)
    .filter(
      (agentIndex) =>
        !Number.isInteger(agentIndex) ||
        agentIndex < 0 ||
        agentIndex >= maxAgentIndexExclusive
    );
  const aiInternals = server as unknown as {
    _rebuildAiTargetMap(): void;
    tickNpcFsms(dt: number): void;
  };
  const rebuildAiTargetMap = aiInternals._rebuildAiTargetMap.bind(server);
  const tickNpcFsms = aiInternals.tickNpcFsms.bind(server);
  const realDateNow = Date.now;
  let simulatedNow = realDateNow();
  const memoryStart = process.memoryUsage();
  const wasmHeapStart = R.Raw.Module.HEAPU8.buffer.byteLength;
  const navDiagnostics = server.navManager as unknown as {
    _loadedCols: Set<string>;
    _cacheLoadedCols: Set<string>;
    _streamCacheLayers: Map<string, unknown[]>;
    _streamCacheLayerCount: number;
    _streamCacheCapacity: number;
  };
  let activeObstacle: ReturnType<typeof server.navManager.addObstacle> = null;
  let obstacleAdds = 0;
  let obstacleRemovals = 0;
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
      } else if (tourWorld) {
        validationCharacter.state.position =
          tourWaypoints[Math.floor(i / 200) % tourWaypoints.length];
      }
      if (churnObstacles && i % 20 === 0) {
        activeObstacle = server.navManager.addObstacle(
          validationCharacter.state.position,
          { x: 0.75, y: 1.5, z: 0.75 }
        );
        if (activeObstacle) obstacleAdds++;
      } else if (churnObstacles && i % 20 === 10 && activeObstacle) {
        server.navManager.removeObstacle(activeObstacle);
        activeObstacle = null;
        obstacleRemovals++;
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
      if (!server.navManager.obstacleUpdatesHealthy) {
        const activeObstacles = [
          ...(
            server.navManager as unknown as {
              _activeObstacles: Set<unknown>;
            }
          )._activeObstacles
        ];
        throw new Error(
          `obstacle updates faulted on live update ${i}; active=${activeObstacles.length}; ` +
            `tail=${JSON.stringify(activeObstacles.slice(-5))}`
        );
      }
    }
  } finally {
    if (activeObstacle) {
      server.navManager.removeObstacle(activeObstacle);
      server.navManager.updt();
      obstacleRemovals++;
    }
    Date.now = realDateNow;
  }

  const maxNavMeshTiles = server.navManager.navmesh.getMaxTiles();
  let activeNavMeshTiles = 0;
  for (let tileIndex = 0; tileIndex < maxNavMeshTiles; tileIndex++) {
    if (server.navManager.navmesh.getTile(tileIndex).header()) {
      activeNavMeshTiles++;
    }
  }
  const forceGc = (globalThis as { gc?: () => void }).gc;
  forceGc?.();
  const memoryEnd = process.memoryUsage();

  const report = {
    worldNpcs: Object.keys(server._npcs).length,
    worldVehicles: Object.keys(server._vehicles).length,
    center: Array.from(center.slice(0, 3)),
    crowdSteps,
    npcAgents,
    vehicleAgents,
    wrapperCount: wrappers.length,
    activeAgents: server.navManager.crowd.getActiveAgentCount(),
    invalidIndexes,
    crowdHealthy: server.navManager.crowdHealthy,
    obstacleUpdatesHealthy: server.navManager.obstacleUpdatesHealthy,
    obstacleAdds,
    obstacleRemovals,
    navigationMode:
      process.env.NAV_MONOLITHIC_64 === "1" ? "monolithic64" : "streaming",
    streaming: {
      loadedColumns: navDiagnostics._loadedCols.size,
      cachedColumns: navDiagnostics._cacheLoadedCols.size,
      cachedLayers: navDiagnostics._streamCacheLayerCount,
      layerCapacity: navDiagnostics._streamCacheCapacity,
      activeNavMeshTiles,
      maxNavMeshTiles,
      maxLayersPerColumn: Array.from(
        navDiagnostics._streamCacheLayers.values()
      ).reduce((maximum, layers) => Math.max(maximum, layers.length), 0)
    },
    memory: {
      rssStartMb: Math.round(memoryStart.rss / 1024 / 1024),
      rssEndMb: Math.round(memoryEnd.rss / 1024 / 1024),
      heapTotalStartMb: Math.round(memoryStart.heapTotal / 1024 / 1024),
      heapTotalEndMb: Math.round(memoryEnd.heapTotal / 1024 / 1024),
      heapUsedStartMb: Math.round(memoryStart.heapUsed / 1024 / 1024),
      heapUsedEndMb: Math.round(memoryEnd.heapUsed / 1024 / 1024),
      externalStartMb: Math.round(memoryStart.external / 1024 / 1024),
      externalEndMb: Math.round(memoryEnd.external / 1024 / 1024),
      arrayBuffersStartMb: Math.round(memoryStart.arrayBuffers / 1024 / 1024),
      arrayBuffersEndMb: Math.round(memoryEnd.arrayBuffers / 1024 / 1024),
      forcedGc: Boolean(forceGc),
      wasmHeapStartMb: Math.round(wasmHeapStart / 1024 / 1024),
      wasmHeapEndMb: Math.round(
        R.Raw.Module.HEAPU8.buffer.byteLength / 1024 / 1024
      ),
      wasmResizeHeapAvailable:
        typeof R.Raw.Module._emscripten_resize_heap === "function"
    }
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.NAV_WORLD_CROWD_REPORT) {
    writeFileSync(resolve(process.env.NAV_WORLD_CROWD_REPORT), serialized);
  }
  process.stdout.write(serialized);
  process.exit(server.navManager.crowdHealthy ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
