process.env.DISABLE_PLUGINS = "true";
process.env.FORCE_DISABLE_WS = "true";
process.env.NAV_STREAMING = "1";

const center = new Float32Array([
  Number(process.argv[2] ?? -125.55),
  Number(process.argv[3] ?? 23.41),
  Number(process.argv[4] ?? -1131.71),
  1
]);
const radius = Number(process.argv[5] ?? 250);

async function main() {
  const { ZoneServer2016 } =
    await import("../src/servers/ZoneServer2016/zoneserver");
  const server = new ZoneServer2016(
    12118,
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

  const samples = [];
  for (const npc of Object.values(server._npcs)) {
    const dx = npc.state.position[0] - center[0];
    const dz = npc.state.position[2] - center[2];
    if (Math.hypot(dx, dz) > radius) continue;

    npc.navAgent ??=
      server.navManager.createAgent(npc.state.position) ?? undefined;
    if (!npc.navAgent) continue;
    const navPosition = npc.navAgent.position();
    const position = new Float32Array([
      navPosition.x,
      navPosition.y,
      navPosition.z,
      1
    ]);
    const ground = server.getGroundInfo(
      position,
      navPosition.y,
      npc.state.position[1]
    );
    samples.push({
      id: npc.characterId,
      model: npc.actorModelId,
      x: position[0],
      z: position[2],
      currentY: npc.state.position[1],
      navY: navPosition.y,
      terrainY: ground.terrainSample?.height ?? null,
      structureY: ground.structureY,
      selectedY: ground.selection.height,
      selectedSource: ground.selection.source,
      selectedMinusNav: ground.selection.height - navPosition.y,
      selectedMinusCurrent: ground.selection.height - npc.state.position[1]
    });
  }

  const suspicious = samples
    .filter((sample) => Math.abs(sample.selectedMinusCurrent) > 1.5)
    .sort(
      (left, right) =>
        Math.abs(right.selectedMinusCurrent) -
        Math.abs(left.selectedMinusCurrent)
    );
  const sources = samples.reduce<Record<string, number>>((counts, sample) => {
    counts[sample.selectedSource] = (counts[sample.selectedSource] ?? 0) + 1;
    return counts;
  }, {});

  console.log(
    JSON.stringify(
      {
        center: Array.from(center.slice(0, 3)),
        radius,
        sampleCount: samples.length,
        sources,
        suspiciousCount: suspicious.length,
        suspicious: suspicious.slice(0, 25)
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
