import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bounds = process.argv.slice(2).map(Number);
if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
  console.error(
    "Usage: npx tsx scripts/listDoorsInBounds.ts <min-x> <min-z> <max-x> <max-z>"
  );
  process.exit(1);
}

const [minX, minZ, maxX, maxZ] = bounds;
const groups = JSON.parse(
  readFileSync(resolve("data/2016/zoneData/Z1_doors.json"), "utf8")
) as Array<{
  actorDefinition: string;
  instances: Array<{ position: number[]; rotation: number[] }>;
}>;

for (const group of groups) {
  for (const instance of group.instances) {
    const [x, y, z] = instance.position;
    if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
      console.log(
        JSON.stringify({
          actorDefinition: group.actorDefinition,
          position: [x, y, z],
          rotation: instance.rotation
        })
      );
    }
  }
}
