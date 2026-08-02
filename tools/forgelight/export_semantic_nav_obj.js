// Export one bounded, canonical-semantic OBJ from the authoritative runtime
// map sources: the native heightmap plus H1COL2 instanced collision.  This is
// a collision-first alternative to merging the render-derived world OBJ.
"use strict";

const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync
} = require("node:fs");
const { createHash } = require("node:crypto");
const { basename, dirname, resolve } = require("node:path");
const { Matrix4, Quaternion, Vector3 } = require("three");
const { loadHeightmap, readBin } = require("./gen_navmesh");

const SEMANTIC_SCHEMA = "h1emu-nav-semantics-v1";
const SOURCE_SCHEMA = "h1emu-collision-semantic-obj-v1";
const COLLISION_METADATA_SCHEMA = "h1emu-h1col2-metadata-v1";
const KIND_NAMES = ["walkable", "solid", "thin", "door"];
const DEFAULT_KIND_MATERIALS = [
  "nav_floor_exterior",
  "nav_obstacle_static",
  "nav_obstacle_static",
  "nav_door_panel_dynamic"
];
const WALKABLE_MATERIALS = new Set([
  "nav_road",
  "nav_floor_exterior",
  "nav_floor_interior",
  "nav_stair",
  "nav_ramp",
  "nav_threshold"
]);

function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`);
  return number;
}

function validateBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4)
    throw new Error("bounds must be [minX,minZ,maxX,maxZ]");
  const result = bounds.map((value, index) =>
    finiteNumber(value, `bounds[${index}]`)
  );
  if (result[0] >= result[2] || result[1] >= result[3])
    throw new Error("bounds min values must be smaller than max values");
  return result;
}

function validateH1Col2(data) {
  if (!data || !Array.isArray(data.meshes))
    throw new Error("invalid H1COL2 data");
  if (
    !(data.instMesh instanceof Uint32Array) ||
    !(data.instData instanceof Float32Array) ||
    data.instMesh.length !== data.instCount ||
    data.instData.length !== data.instCount * 16
  )
    throw new Error("invalid H1COL2 instance tables");
  data.meshes.forEach((mesh, meshIndex) => {
    if (!Number.isInteger(mesh.kind) || mesh.kind < 0 || mesh.kind > 3)
      throw new Error(`H1COL2 mesh ${meshIndex} has invalid kind ${mesh.kind}`);
    if (!(mesh.pos instanceof Float32Array) || mesh.pos.length % 3 !== 0)
      throw new Error(`H1COL2 mesh ${meshIndex} has invalid positions`);
    if (!(mesh.idx instanceof Uint32Array) || mesh.idx.length % 3 !== 0)
      throw new Error(`H1COL2 mesh ${meshIndex} has invalid indices`);
    const vertexCount = mesh.pos.length / 3;
    for (const index of mesh.idx)
      if (index >= vertexCount)
        throw new Error(
          `H1COL2 mesh ${meshIndex} index ${index} is out of range`
        );
  });
  for (let instanceIndex = 0; instanceIndex < data.instCount; instanceIndex++) {
    if (data.instMesh[instanceIndex] >= data.meshes.length)
      throw new Error(
        `H1COL2 instance ${instanceIndex} has invalid mesh index`
      );
    const offset = instanceIndex * 16;
    for (let component = 0; component < 16; component++)
      if (!Number.isFinite(data.instData[offset + component]))
        throw new Error(`H1COL2 instance ${instanceIndex} has non-finite data`);
  }
  return data;
}

function allowedMaterial(kind, material) {
  if (kind === 0) return WALKABLE_MATERIALS.has(material);
  if (kind === 1) return material === "nav_obstacle_static";
  if (kind === 2)
    return material === "nav_obstacle_static" || material === "nav_exclude";
  return kind === 3 && material === "nav_door_panel_dynamic";
}

function loadCollisionMetadata(path, collisionHash, collision) {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value.schema !== COLLISION_METADATA_SCHEMA ||
    value.formatVersion !== 2 ||
    value.coordinateSpace !== "h1z1-world-y-up-meters" ||
    value.collisionSha256 !== collisionHash ||
    value.meshCount !== collision.meshes.length ||
    value.instanceCount !== collision.instCount ||
    !Array.isArray(value.meshes) ||
    value.meshes.length !== collision.meshes.length
  )
    throw new Error("H1COL2 metadata does not match the collision artifact");

  const byMesh = Array.from({ length: collision.meshes.length });
  for (const entry of value.meshes) {
    const index = entry?.meshIndex;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= collision.meshes.length ||
      byMesh[index] ||
      entry.kind !== collision.meshes[index].kind ||
      typeof entry.actorFile !== "string" ||
      !entry.actorFile ||
      !allowedMaterial(entry.kind, entry.semanticMaterial)
    )
      throw new Error(`invalid H1COL2 metadata mesh entry ${index}`);
    byMesh[index] = entry;
  }
  if (byMesh.some((entry) => !entry))
    throw new Error("H1COL2 metadata mesh indices are incomplete");
  return { value, byMesh };
}

function axis(min, max, step) {
  const values = [min];
  for (let value = min + step; value < max; value += step) values.push(value);
  if (values[values.length - 1] !== max) values.push(max);
  return values;
}

function formatNumber(value) {
  if (Object.is(value, -0) || Math.abs(value) < 0.0000005) return "0";
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function safeObjectName(value) {
  return (
    value
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "mesh"
  );
}

function intersects(bounds, data, offset) {
  return !(
    data[offset + 13] < bounds[0] ||
    data[offset + 10] > bounds[2] ||
    data[offset + 15] < bounds[1] ||
    data[offset + 12] > bounds[3]
  );
}

function createLineWriter(path) {
  const fd = openSync(path, "wx");
  let buffered = "";
  return {
    line(value) {
      buffered += `${value}\n`;
      if (buffered.length >= 1024 * 1024) {
        writeSync(fd, buffered);
        buffered = "";
      }
    },
    close() {
      if (buffered) writeSync(fd, buffered);
      closeSync(fd);
    }
  };
}

async function exportSemanticRegion(options, dependencies = {}) {
  const bounds = validateBounds(options.bounds);
  const terrainStep = finiteNumber(options.terrainStep ?? 1, "terrainStep");
  if (terrainStep <= 0)
    throw new Error("terrainStep must be greater than zero");
  const outputPath = resolve(options.outputPath);
  const reportPath = resolve(options.reportPath ?? `${outputPath}.source.json`);
  const heightmapPath = resolve(options.heightmapPath);
  const collisionPath = resolve(options.collisionPath);
  if (existsSync(outputPath) || existsSync(reportPath))
    throw new Error("output OBJ and report paths must not already exist");

  const xValues = axis(bounds[0], bounds[2], terrainStep);
  const zValues = axis(bounds[1], bounds[3], terrainStep);
  const terrainVertices = xValues.length * zValues.length;
  const maxTerrainVertices = Number(options.maxTerrainVertices ?? 4_000_000);
  if (!Number.isInteger(maxTerrainVertices) || maxTerrainVertices < 4)
    throw new Error("maxTerrainVertices must be an integer of at least four");
  if (terrainVertices > maxTerrainVertices)
    throw new Error(
      `regional terrain requires ${terrainVertices} vertices; limit is ${maxTerrainVertices}`
    );

  const collisionHash = sha256File(collisionPath);
  const heightmapHash = sha256File(heightmapPath);
  const collision = validateH1Col2(
    (dependencies.readBin ?? readBin)(collisionPath)
  );
  let metadataPath = options.metadataPath
    ? resolve(options.metadataPath)
    : null;
  if (!metadataPath) {
    const candidate = collisionPath.replace(/\.bin$/i, ".metadata.json");
    if (candidate !== collisionPath && existsSync(candidate))
      metadataPath = candidate;
  }
  const metadata = loadCollisionMetadata(
    metadataPath,
    collisionHash,
    collision
  );
  const getHeight = await (dependencies.loadHeightmap ?? loadHeightmap)(
    heightmapPath
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const materials = {};
  const instanceKinds = [0, 0, 0, 0];
  let includedInstances = 0;
  let droppedTriangles = 0;
  let vertexBase = 1;
  const writer = createLineWriter(outputPath);
  try {
    writer.line(`# ${SEMANTIC_SCHEMA}`);
    writer.line("# collision-first source: native heightmap + H1COL2 only");
    writer.line("o native_terrain");
    writer.line("usemtl nav_terrain");
    for (const x of xValues) {
      for (const z of zValues) {
        const height = getHeight(x, z);
        if (!Number.isFinite(height))
          throw new Error(
            `heightmap returned a non-finite sample at ${x},${z}`
          );
        writer.line(
          `v ${formatNumber(x)} ${formatNumber(height)} ${formatNumber(z)}`
        );
      }
    }
    for (let ix = 0; ix < xValues.length - 1; ix++) {
      for (let iz = 0; iz < zValues.length - 1; iz++) {
        const a = vertexBase + ix * zValues.length + iz;
        const b = vertexBase + (ix + 1) * zValues.length + iz;
        const c = b + 1;
        const d = a + 1;
        writer.line(`f ${a} ${c} ${b}`);
        writer.line(`f ${a} ${d} ${c}`);
      }
    }
    materials.nav_terrain = (xValues.length - 1) * (zValues.length - 1) * 2;
    vertexBase += terrainVertices;

    const matrix = new Matrix4();
    const translation = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    const vertex = new Vector3();
    const edge1 = new Vector3();
    const edge2 = new Vector3();
    for (
      let instanceIndex = 0;
      instanceIndex < collision.instCount;
      instanceIndex++
    ) {
      const offset = instanceIndex * 16;
      if (!intersects(bounds, collision.instData, offset)) continue;
      const meshIndex = collision.instMesh[instanceIndex];
      const mesh = collision.meshes[meshIndex];
      const meshMetadata = metadata?.byMesh[meshIndex];
      const material =
        meshMetadata?.semanticMaterial ?? DEFAULT_KIND_MATERIALS[mesh.kind];
      if (!allowedMaterial(mesh.kind, material))
        throw new Error(`mesh ${meshIndex} has unsafe semantic ${material}`);

      translation.set(
        collision.instData[offset],
        collision.instData[offset + 1],
        collision.instData[offset + 2]
      );
      rotation.set(
        collision.instData[offset + 3],
        collision.instData[offset + 4],
        collision.instData[offset + 5],
        collision.instData[offset + 6]
      );
      scale.set(
        collision.instData[offset + 7],
        collision.instData[offset + 8],
        collision.instData[offset + 9]
      );
      matrix.compose(translation, rotation, scale);
      const actorName = meshMetadata
        ? safeObjectName(meshMetadata.actorFile)
        : `h1col2_mesh_${meshIndex}`;
      writer.line(`o ${actorName}__instance_${instanceIndex}`);
      writer.line(`usemtl ${material}`);
      const worldPositions = [];
      for (let position = 0; position < mesh.pos.length; position += 3) {
        vertex
          .set(
            mesh.pos[position],
            mesh.pos[position + 1],
            mesh.pos[position + 2]
          )
          .applyMatrix4(matrix);
        if (![vertex.x, vertex.y, vertex.z].every(Number.isFinite))
          throw new Error(
            `instance ${instanceIndex} produced a non-finite vertex`
          );
        worldPositions.push(vertex.x, vertex.y, vertex.z);
        writer.line(
          `v ${formatNumber(vertex.x)} ${formatNumber(vertex.y)} ${formatNumber(vertex.z)}`
        );
      }
      for (let index = 0; index < mesh.idx.length; index += 3) {
        const a = mesh.idx[index];
        const b = mesh.idx[index + 1];
        const c = mesh.idx[index + 2];
        const aOffset = a * 3;
        const bOffset = b * 3;
        const cOffset = c * 3;
        edge1.set(
          worldPositions[bOffset] - worldPositions[aOffset],
          worldPositions[bOffset + 1] - worldPositions[aOffset + 1],
          worldPositions[bOffset + 2] - worldPositions[aOffset + 2]
        );
        edge2.set(
          worldPositions[cOffset] - worldPositions[aOffset],
          worldPositions[cOffset + 1] - worldPositions[aOffset + 1],
          worldPositions[cOffset + 2] - worldPositions[aOffset + 2]
        );
        if (
          a === b ||
          b === c ||
          a === c ||
          edge1.cross(edge2).lengthSq() < 1e-12
        ) {
          droppedTriangles++;
          continue;
        }
        writer.line(`f ${vertexBase + a} ${vertexBase + b} ${vertexBase + c}`);
        materials[material] = (materials[material] ?? 0) + 1;
      }
      vertexBase += mesh.pos.length / 3;
      instanceKinds[mesh.kind]++;
      includedInstances++;
    }
    writer.close();
  } catch (error) {
    try {
      writer.close();
    } catch {
      // Preserve the original export failure during best-effort cleanup.
    }
    rmSync(outputPath, { force: true });
    throw error;
  }

  const limitations = [
    "H1COL2 classifies merged actor meshes, not connected components; composite roofs and floors cannot be separated here.",
    "Terrain remains underneath intersecting structures because H1COL2 has no footprint/portal ownership contract.",
    "Intersecting instances are emitted whole and are clipped by the bounded Recast bake, preserving actor topology."
  ];
  if (!metadata)
    limitations.unshift(
      "No matching H1COL2 metadata sidecar was available; walkable structures use nav_floor_exterior and lose road/stair/interior area identity."
    );
  const report = {
    schema: SOURCE_SCHEMA,
    semanticContract: SEMANTIC_SCHEMA,
    coordinateSpace: "h1z1-world-y-up-meters",
    sourceStrategy: "heightmap-plus-h1col2-only",
    renderGeometryMerged: false,
    output: {
      file: basename(outputPath),
      sha256: sha256File(outputPath)
    },
    bounds: {
      minX: bounds[0],
      minZ: bounds[1],
      maxX: bounds[2],
      maxZ: bounds[3]
    },
    terrainStep,
    inputs: {
      heightmap: { file: basename(heightmapPath), sha256: heightmapHash },
      collision: { file: basename(collisionPath), sha256: collisionHash },
      collisionMetadata: metadataPath
        ? {
            file: basename(metadataPath),
            sha256: sha256File(metadataPath),
            matched: true
          }
        : null
    },
    counts: {
      terrainVertices,
      terrainTriangles: materials.nav_terrain,
      includedInstances,
      instanceKinds: Object.fromEntries(
        KIND_NAMES.map((name, index) => [name, instanceKinds[index]])
      ),
      materialTriangles: Object.fromEntries(
        Object.entries(materials).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      droppedDegenerateTriangles: droppedTriangles
    },
    limitations
  };
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx"
    });
  } catch (error) {
    rmSync(outputPath, { force: true });
    rmSync(reportPath, { force: true });
    throw error;
  }
  return report;
}

function parseArgs(argv) {
  const result = { terrainStep: 1, maxTerrainVertices: 4_000_000 };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--bounds") {
      result.bounds = argv.slice(index + 1, index + 5).map(Number);
      index += 4;
    } else if (name === "--heightmap") result.heightmapPath = argv[++index];
    else if (name === "--collision") result.collisionPath = argv[++index];
    else if (name === "--collision-metadata")
      result.metadataPath = argv[++index];
    else if (name === "--output") result.outputPath = argv[++index];
    else if (name === "--report") result.reportPath = argv[++index];
    else if (name === "--terrain-step")
      result.terrainStep = Number(argv[++index]);
    else if (name === "--max-terrain-vertices")
      result.maxTerrainVertices = Number(argv[++index]);
    else throw new Error(`unknown argument: ${name}`);
  }
  for (const required of [
    "bounds",
    "heightmapPath",
    "collisionPath",
    "outputPath"
  ])
    if (result[required] === undefined)
      throw new Error(`missing --${required}`);
  return result;
}

async function main() {
  const report = await exportSemanticRegion(parseArgs(process.argv.slice(2)));
  console.log(
    `[semantic-obj] wrote ${report.counts.terrainTriangles} terrain triangles and ` +
      `${report.counts.includedInstances} H1COL2 instances`
  );
}

module.exports = {
  COLLISION_METADATA_SCHEMA,
  SOURCE_SCHEMA,
  exportSemanticRegion,
  loadCollisionMetadata,
  parseArgs,
  validateH1Col2
};

if (require.main === module)
  main().catch((error) => {
    console.error(`[semantic-obj] ${error.message}`);
    process.exitCode = 1;
  });
