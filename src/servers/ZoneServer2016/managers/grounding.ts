export const EXPECTED_HEIGHTMAP_SIZE = 8192;
const MAX_BILINEAR_SPREAD = 4;
const STRUCTURE_TERRAIN_TOLERANCE = 0.5;

export type TerrainSamplingMode = "bilinear" | "reference" | "nearest";
export type GroundSource = "structure" | "terrain" | "navmesh" | "current";

export interface TerrainHeightSample {
  height: number;
  min: number;
  max: number;
  mode: TerrainSamplingMode;
}

export interface GroundCandidates {
  terrainY: number | null;
  structureY: number | null;
  navY: number | null;
  currentY: number;
}

export interface GroundSelection {
  height: number;
  source: GroundSource;
}

export function decodeHeightmapPixel(red: number, green: number): number {
  return (red - 16) * 8 + green / 32;
}

function pixelHeight(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number
): number {
  const index = (y * width + x) * 4;
  return decodeHeightmapPixel(data[index], data[index + 1]);
}

export function sampleTerrainHeight(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  worldX: number,
  worldZ: number,
  referenceY?: number
): TerrainHeightSample | null {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (
    worldX < -halfHeight ||
    worldX > halfHeight ||
    worldZ < -halfWidth ||
    worldZ > halfWidth
  ) {
    return null;
  }

  const pixelX = Math.min(width - 1, Math.max(0, worldZ + halfWidth));
  const pixelY = Math.min(height - 1, Math.max(0, halfHeight - worldX));
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const values = [
    pixelHeight(data, width, x0, y0),
    pixelHeight(data, width, x1, y0),
    pixelHeight(data, width, x0, y1),
    pixelHeight(data, width, x1, y1)
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (x0 === x1 || y0 === y1 || (pixelX === x0 && pixelY === y0)) {
    return {
      height: values[0],
      min: values[0],
      max: values[0],
      mode: "nearest"
    };
  }

  if (max - min <= MAX_BILINEAR_SPREAD) {
    const fractionX = pixelX - x0;
    const fractionY = pixelY - y0;
    const top = values[0] + (values[1] - values[0]) * fractionX;
    const bottom = values[2] + (values[3] - values[2]) * fractionX;
    return {
      height: top + (bottom - top) * fractionY,
      min,
      max,
      mode: "bilinear"
    };
  }

  if (referenceY !== undefined && Number.isFinite(referenceY)) {
    let closest = values[0];
    for (const value of values.slice(1)) {
      if (Math.abs(value - referenceY) < Math.abs(closest - referenceY)) {
        closest = value;
      }
    }
    return { height: closest, min, max, mode: "reference" };
  }

  const nearestX = Math.round(pixelX);
  const nearestY = Math.round(pixelY);
  return {
    height: pixelHeight(data, width, nearestX, nearestY),
    min,
    max,
    mode: "nearest"
  };
}

export function selectGroundSurface(
  candidates: GroundCandidates
): GroundSelection {
  const { terrainY, structureY, navY, currentY } = candidates;
  if (
    structureY !== null &&
    Number.isFinite(structureY) &&
    (terrainY === null || structureY >= terrainY - STRUCTURE_TERRAIN_TOLERANCE)
  ) {
    return { height: structureY, source: "structure" };
  }
  if (terrainY !== null && Number.isFinite(terrainY)) {
    return { height: terrainY, source: "terrain" };
  }
  if (navY !== null && Number.isFinite(navY)) {
    return { height: navY, source: "navmesh" };
  }
  return { height: currentY, source: "current" };
}
