import { resolve } from "node:path";
import { getNavMeshPositionsAndIndices } from "recast-navigation";

const cacheDirectory = process.argv[2];
if (!cacheDirectory) {
  console.error("Usage: npx tsx scripts/inspectPvPoliceSlopes.ts <cache-dir>");
  process.exit(1);
}

process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDirectory);

type Triangle = {
  index: number;
  vertices: number[];
  vertexKeys: string[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([new Float32Array([-235, 26, -1152, 1])]);

  const [positions, indices] = getNavMeshPositionsAndIndices(nav.navmesh);
  const triangles: Triangle[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const vertices = indices.slice(offset, offset + 3);
    const xs = vertices.map((vertex) => positions[vertex * 3]);
    const ys = vertices.map((vertex) => positions[vertex * 3 + 1]);
    const zs = vertices.map((vertex) => positions[vertex * 3 + 2]);
    const triangle = {
      index: offset / 3,
      vertices,
      vertexKeys: vertices.map((vertex) =>
        [
          positions[vertex * 3],
          positions[vertex * 3 + 1],
          positions[vertex * 3 + 2]
        ]
          .map((value) => value.toFixed(2))
          .join(",")
      ),
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs)
    };
    const centerX = (triangle.minX + triangle.maxX) / 2;
    const centerZ = (triangle.minZ + triangle.maxZ) / 2;
    if (
      centerX >= -244 &&
      centerX <= -223 &&
      centerZ >= -1168 &&
      centerZ <= -1133 &&
      triangle.maxY >= 24 &&
      triangle.minY <= 30.5 &&
      triangle.maxY - triangle.minY > 0.06
    ) {
      triangles.push(triangle);
    }
  }

  const parent = triangles.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const byVertex = new Map<string, number[]>();
  triangles.forEach((triangle, triangleIndex) => {
    for (const vertex of triangle.vertexKeys) {
      const owners = byVertex.get(vertex) ?? [];
      owners.push(triangleIndex);
      byVertex.set(vertex, owners);
    }
  });
  for (const owners of byVertex.values()) {
    for (let index = 1; index < owners.length; index++) {
      union(owners[0], owners[index]);
    }
  }

  const components = new Map<number, Triangle[]>();
  triangles.forEach((triangle, index) => {
    const root = find(index);
    const entries = components.get(root) ?? [];
    entries.push(triangle);
    components.set(root, entries);
  });
  const report = [...components.values()]
    .map((entries) => ({
      triangles: entries.length,
      minX: Math.min(...entries.map((entry) => entry.minX)),
      maxX: Math.max(...entries.map((entry) => entry.maxX)),
      minY: Math.min(...entries.map((entry) => entry.minY)),
      maxY: Math.max(...entries.map((entry) => entry.maxY)),
      minZ: Math.min(...entries.map((entry) => entry.minZ)),
      maxZ: Math.max(...entries.map((entry) => entry.maxZ)),
      vertices:
        entries.length <= 10
          ? [...new Set(entries.flatMap((entry) => entry.vertexKeys))].sort()
          : undefined
    }))
    .filter((component) => component.maxY - component.minY > 0.15)
    .sort((a, b) => b.maxY - b.minY - (a.maxY - a.minY));

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
