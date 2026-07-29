import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getNavMeshPositionsAndIndices } from "recast-navigation";

const cacheDir = process.argv[2];
const output = process.argv[3];
const centerX = Number(process.argv[4]);
const centerY = Number(process.argv[5]);
const centerZ = Number(process.argv[6]);
const radius = Number(process.argv[7] ?? 50);
if (
  !cacheDir ||
  !output ||
  !Number.isFinite(centerX) ||
  !Number.isFinite(centerY) ||
  !Number.isFinite(centerZ) ||
  !Number.isFinite(radius) ||
  radius <= 0
) {
  console.error(
    "Usage: npx tsx scripts/renderStreamingNav.ts <cache-dir> <output.png> <x> <y> <z> [radius]"
  );
  process.exit(1);
}

const bounds = {
  minX: centerX - radius,
  minZ: centerZ - radius,
  maxX: centerX + radius,
  maxZ: centerZ + radius
};
process.env.NAV_STREAMING = "1";
process.env.NAV_CACHE_DIR = resolve(cacheDir);

async function main() {
  const { NavManager } = await import("../src/utils/recast");
  const nav = new NavManager();
  await nav.loadNav();
  nav.streamAround([new Float32Array([centerX, centerY, centerZ, 1])]);

  const [positions, indices] = getNavMeshPositionsAndIndices(nav.navmesh);
  const size = 1600;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f1e8";
  ctx.fillRect(0, 0, size, size);
  const sx = size / (bounds.maxX - bounds.minX);
  const sz = size / (bounds.maxZ - bounds.minZ);
  const px = (x: number) => (x - bounds.minX) * sx;
  const pz = (z: number) => size - (z - bounds.minZ) * sz;

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const y = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const shade = Math.max(0, Math.min(100, 55 + (y - centerY) * 8));
    ctx.fillStyle = `hsl(205 45% ${shade}%)`;
    ctx.strokeStyle = "rgba(10, 25, 35, 0.28)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px(positions[a]), pz(positions[a + 2]));
    ctx.lineTo(px(positions[b]), pz(positions[b + 2]));
    ctx.lineTo(px(positions[c]), pz(positions[c + 2]));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = "#e11d48";
  ctx.beginPath();
  ctx.arc(px(centerX), pz(centerZ), 7, 0, Math.PI * 2);
  ctx.fill();
  writeFileSync(output, canvas.toBuffer("image/png"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
