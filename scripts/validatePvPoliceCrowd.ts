import { resolve } from "node:path";

const cacheDirectory = process.argv[2];
if (!cacheDirectory) {
  console.error("Usage: npx tsx scripts/validatePvPoliceCrowd.ts <cache-dir>");
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);

const road = new Float32Array([
  Number(process.argv[7] ?? -222),
  Number(process.argv[8] ?? 23.65),
  Number(process.argv[9] ?? -1157),
  1
]);
const interior = new Float32Array([
  Number(process.argv[3] ?? -236.22),
  Number(process.argv[4] ?? 25.45),
  Number(process.argv[5] ?? -1149.3),
  1
]);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([road]);
  if (process.argv[6] === "rebuild") {
    nav.crowd.destroy();
    (nav as unknown as { createCrowd(): void }).createCrowd();
  }

  const agent = nav.createAgent(road);
  const target = nav.getClosestNavPointVec3(interior);
  if (!agent || !target) throw new Error("failed to create crowd probe");
  agent.updateParameters({ maxSpeed: 2, maxAcceleration: 4 });
  if (!agent.requestMoveTarget(target)) {
    throw new Error("crowd rejected the interior target");
  }

  const points = [];
  for (let step = 0; step < 1_200; step++) {
    nav.crowd.update(0.05);
    if (step % 100 === 0) points.push(agent.position());
  }
  const final = agent.position();
  const distance = Math.hypot(
    final.x - target.x,
    final.y - target.y,
    final.z - target.z
  );
  console.log(
    JSON.stringify(
      {
        target,
        final,
        distance,
        state: agent.state(),
        parameters: agent.parameters(),
        velocity: agent.velocity(),
        desiredVelocity: agent.desiredVelocity(),
        corners: agent.corners(),
        points
      },
      null,
      2
    )
  );
  if (distance > 1) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
