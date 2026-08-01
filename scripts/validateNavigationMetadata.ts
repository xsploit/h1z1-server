import { resolve } from "node:path";
import { loadNavigationMetadata } from "../src/utils/navigationmetadata";

const path = resolve(
  process.argv[2] ?? "data/2016/navigation_metadata.json"
);
const metadata = loadNavigationMetadata(path);
if (!metadata) {
  throw new Error(`navigation metadata not found: ${path}`);
}

const counts = metadata.instances.reduce<Record<string, number>>(
  (result, instance) => {
    result[instance.kind] = (result[instance.kind] ?? 0) + 1;
    return result;
  },
  {}
);
const actors = new Set(
  metadata.instances.map((instance) => instance.actorDefinition)
);

console.log(`Navigation metadata: ${path}`);
console.log(`Coordinate space: ${metadata.coordinateSpace}`);
console.log(
  `Door geometry excluded: ${metadata.bakedDoorGeometryExcluded ? "yes" : "no"}`
);
console.log(`Instances: ${metadata.instances.length}`);
console.log(`Doors: ${counts.door ?? 0}`);
console.log(`Stairs: ${counts.stairs ?? 0}`);
console.log(`Actor definitions: ${actors.size}`);
