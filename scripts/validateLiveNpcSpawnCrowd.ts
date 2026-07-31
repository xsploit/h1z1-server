import { resolve } from "node:path";

process.env.DISABLE_PLUGINS = "true";
process.env.FORCE_DISABLE_WS = "true";
process.env.NAV_STREAMING = "1";

const cacheDirectory = process.argv[2];
const postSpawnSeconds = Number(process.argv[3] ?? 15);
if (!cacheDirectory) {
  console.error(
    "Usage: npx tsx scripts/validateLiveNpcSpawnCrowd.ts <cache-dir> [post-spawn-seconds]"
  );
  process.exit(1);
}
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);

async function main() {
  const {
    ZoneServer2016
  } = require("../out/servers/ZoneServer2016/zoneserver");
  const {
    createFakeCharacter,
    createFakeZoneClient
  } = require("../out/utils/test.utils");
  const { Npc } = require("../out/servers/ZoneServer2016/entities/npc");
  const { Raw } = require("recast-navigation");

  const server = new ZoneServer2016(
    12118,
    Buffer.from("F70IaxuU8C/w7FPXY1ibXw==", "base64"),
    undefined,
    2
  );
  await server.start();
  server.sendData = () => {};
  server.sendUnbufferedData = () => {};
  server.sendOrderedData = () => {};

  const player = createFakeCharacter(server);
  const client = createFakeZoneClient(server, player);
  player.state.position = new Float32Array([-125.55, 23.41, -1131.71, 1]);
  player.godMode = true;
  player.isReady = true;
  client.isLoading = false;
  server.firstRoutine(client);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  server.updatePathfindingPositions();

  const startedAt = Date.now();
  const deadline = startedAt + 45_000;
  let observedWorldRun = server.worldObjectManager.isRunning;
  let maxActiveAgents = 0;
  let samples = 0;
  while (Date.now() < deadline) {
    observedWorldRun ||= server.worldObjectManager.isRunning;
    if (!server.navManager.crowdHealthy) {
      throw new Error(
        `crowd faulted while NPCs were spawning after ${Date.now() - startedAt}ms`
      );
    }
    maxActiveAgents = Math.max(
      maxActiveAgents,
      server.navManager.crowd.getActiveAgentCount()
    );
    samples++;
    if (
      observedWorldRun &&
      !server.worldObjectManager.isRunning &&
      Object.keys(server._npcs).length > 0
    ) {
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (server.worldObjectManager.isRunning) {
    throw new Error("world NPC generation did not finish");
  }

  const postSpawnDeadline = Date.now() + postSpawnSeconds * 1000;
  while (Date.now() < postSpawnDeadline) {
    if (!server.navManager.crowdHealthy) {
      throw new Error("crowd faulted immediately after live NPC spawning");
    }
    maxActiveAgents = Math.max(
      maxActiveAgents,
      server.navManager.crowd.getActiveAgentCount()
    );
    samples++;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  const indexedNpcs = new Set(
    server._grid.flatMap((cell: { objects: unknown[] }) =>
      cell.objects.filter((entity) => entity instanceof Npc)
    )
  );
  const visibleNpcs = [...client.spawnedEntities].filter(
    (entity) => entity instanceof Npc
  ).length;
  if (indexedNpcs.size !== Object.keys(server._npcs).length) {
    throw new Error(
      `NPC visibility grid mismatch: indexed=${indexedNpcs.size}, world=${Object.keys(server._npcs).length}`
    );
  }
  if (visibleNpcs === 0) {
    throw new Error("ready PV client received zero nearby world NPCs");
  }

  console.log(
    JSON.stringify({
      worldNpcs: Object.keys(server._npcs).length,
      indexedNpcs: indexedNpcs.size,
      visibleNpcs,
      worldVehicles: Object.keys(server._vehicles).length,
      activeAgents: server.navManager.crowd.getActiveAgentCount(),
      maxActiveAgents,
      samples,
      crowdHealthy: server.navManager.crowdHealthy,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      wasmHeapMb: Math.round(Raw.Module.HEAPU8.buffer.byteLength / 1024 / 1024)
    })
  );
  await server.stop();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
