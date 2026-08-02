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
const COLLISION_METADATA_SCHEMA = "h1emu-h1col2-metadata-v4";
const LEGACY_COLLISION_METADATA_SCHEMAS = new Set([
  "h1emu-h1col2-metadata-v1",
  "h1emu-h1col2-metadata-v2",
  "h1emu-h1col2-metadata-v3"
]);
const H1SEM1_FORMAT = "H1SEM1-u8le-v1";
const H1SEM1_MAGIC = "H1SEM1\0\0";
const H1SEM1_VERSION = 1;
const H1SEM1_HEADER_BYTES = 64;
const H1SEM1_SEMANTIC_SCHEMA_VERSION = 1;
const SEMANTIC_POLICY_SCHEMA = "h1emu-h1col2-semantic-policy-v1";
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
const SEMANTIC_MATERIALS = [
  null,
  "nav_terrain",
  "nav_road",
  "nav_floor_exterior",
  "nav_floor_interior",
  "nav_stair",
  "nav_ramp",
  "nav_threshold",
  "nav_obstacle_static",
  "nav_door_panel_dynamic",
  "nav_exclude",
  "nav_unknown"
];
const FIRST_WALKABLE_SEMANTIC_ID = 2;
const LAST_WALKABLE_SEMANTIC_ID = 7;
const TERRAIN_SEMANTIC_ID = 1;
const DOOR_PANEL_SEMANTIC_ID = 9;
const UNKNOWN_SEMANTIC_ID = 11;

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

function semanticCompatibleWithKind(kind, semanticId) {
  if (kind === 0)
    return (
      (semanticId >= FIRST_WALKABLE_SEMANTIC_ID &&
        semanticId <= LAST_WALKABLE_SEMANTIC_ID) ||
      semanticId === 8 ||
      semanticId === 10
    );
  if (kind === 1) return semanticId === 8;
  if (kind === 2) return semanticId === 8 || semanticId === 10;
  return kind === 3 && semanticId === DOOR_PANEL_SEMANTIC_ID;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizedHistogram(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const normalized = {};
  for (const [material, count] of Object.entries(value)) {
    if (!SEMANTIC_MATERIALS.includes(material) || material === null)
      throw new Error(`${label} contains invalid semantic ${material}`);
    if (!Number.isInteger(count) || count <= 0)
      throw new Error(`${label}.${material} must be a positive integer`);
    normalized[material] = count;
  }
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

function assertHistogram(expected, actual, label) {
  const normalized = normalizedHistogram(expected, label);
  if (JSON.stringify(normalized) !== JSON.stringify(actual))
    throw new Error(`${label} does not match H1SEM1 triangle semantics`);
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("semantic policy contains a non-JSON value");
  return encoded;
}

function loadSemanticPolicy(path, expected) {
  const data = readFileSync(path);
  if (sha256File(path) !== expected.sha256)
    throw new Error("semantic policy SHA256 does not match H1COL2 metadata");
  if (
    data.length >= 3 &&
    data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  )
    throw new Error("semantic policy must be canonical UTF-8 without a BOM");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("semantic policy is not valid UTF-8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("semantic policy is not valid JSON");
  }
  if (
    value?.schema !== SEMANTIC_POLICY_SCHEMA ||
    expected.schema !== SEMANTIC_POLICY_SCHEMA ||
    value.semanticContract !== SEMANTIC_SCHEMA ||
    value.semanticSchemaVersion !== H1SEM1_SEMANTIC_SCHEMA_VERSION ||
    value.coordinateSpace !== "h1z1-world-y-up-meters" ||
    !value.defaults ||
    typeof value.defaults !== "object" ||
    Array.isArray(value.defaults) ||
    !Array.isArray(value.rules)
  )
    throw new Error("invalid H1COL2 semantic policy contract");
  let previousActorFile = null;
  const actorFiles = new Set();
  for (let index = 0; index < value.rules.length; index++) {
    const rule = value.rules[index];
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule) ||
      typeof rule.actorFile !== "string" ||
      !rule.actorFile
    )
      throw new Error(`semantic policy rule ${index} has invalid actorFile`);
    const actorFile = rule.actorFile.toLowerCase();
    if (actorFiles.has(actorFile))
      throw new Error(
        `semantic policy has duplicate actorFile ${rule.actorFile}`
      );
    if (previousActorFile !== null && previousActorFile > actorFile)
      throw new Error(
        "semantic policy rules are not sorted by actorFile.casefold"
      );
    actorFiles.add(actorFile);
    previousActorFile = actorFile;
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (!data.equals(canonicalBytes))
    throw new Error("semantic policy bytes are not canonical JSON plus LF");
  return value;
}

function validateInstanceIdContract(value, collision) {
  if (
    value?.format !== "H1CID1-u32le-v1" ||
    value?.count !== collision.instCount ||
    typeof value?.file !== "string" ||
    !value.file ||
    !isSha256(value?.sha256)
  )
    throw new Error("invalid H1COL2 metadata instance-ID contract");
}

function loadCollisionMetadata(
  path,
  collisionHash,
  collision,
  { allowLegacyActorSemantics = false } = {}
) {
  if (!path) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  const isProduction = value.schema === COLLISION_METADATA_SCHEMA;
  const isLegacy = LEGACY_COLLISION_METADATA_SCHEMAS.has(value.schema);
  if (!isProduction && !(isLegacy && allowLegacyActorSemantics))
    throw new Error(
      `production export requires ${COLLISION_METADATA_SCHEMA} metadata with H1SEM1; ` +
        "legacy v1-v3 metadata requires --allow-legacy-actor-semantics"
    );
  if (
    (!isProduction && !isLegacy) ||
    value.formatVersion !== 2 ||
    value.coordinateSpace !== "h1z1-world-y-up-meters" ||
    value.collisionSha256 !== collisionHash ||
    value.meshCount !== collision.meshes.length ||
    value.instanceCount !== collision.instCount ||
    !Array.isArray(value.meshes) ||
    value.meshes.length !== collision.meshes.length
  )
    throw new Error("H1COL2 metadata does not match the collision artifact");

  const collisionFirst = value.schema !== "h1emu-h1col2-metadata-v1";
  if (
    collisionFirst &&
    (value.geometrySource !== "adr_collision_cdta" ||
      value.renderFallbackCount !== 0)
  )
    throw new Error(
      "H1COL2 metadata v2 is not a zero-fallback ADR collision export"
    );

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
      (collisionFirst &&
        (typeof entry.collisionAsset !== "string" ||
          !entry.collisionAsset.toLowerCase().endsWith(".cdt") ||
          !Number.isInteger(entry.triangleCount) ||
          entry.triangleCount !== collision.meshes[index].idx.length / 3)) ||
      (isProduction
        ? entry.semanticSource !== "per_triangle_sidecar_v1" ||
          !entry.semanticHistogram ||
          typeof entry.semanticHistogram !== "object" ||
          Array.isArray(entry.semanticHistogram)
        : entry.semanticSource === undefined
          ? false
          : collisionFirst &&
            entry.semanticSource !==
              "actor_default_pending_per_triangle_table") ||
      (!isProduction && !allowedMaterial(entry.kind, entry.semanticMaterial))
    )
      throw new Error(`invalid H1COL2 metadata mesh entry ${index}`);
    byMesh[index] = entry;
  }
  if (byMesh.some((entry) => !entry))
    throw new Error("H1COL2 metadata mesh indices are incomplete");
  if (isProduction || value.schema === "h1emu-h1col2-metadata-v3")
    validateInstanceIdContract(value.instanceIds, collision);

  if (isProduction) {
    const semantics = value.triangleSemantics;
    if (
      !semantics ||
      typeof semantics.file !== "string" ||
      !semantics.file ||
      !isSha256(semantics.sha256) ||
      semantics.format !== H1SEM1_FORMAT ||
      semantics.semanticContract !== SEMANTIC_SCHEMA ||
      semantics.semanticSchemaVersion !== H1SEM1_SEMANTIC_SCHEMA_VERSION ||
      semantics.collisionSha256 !== collisionHash ||
      semantics.meshCount !== collision.meshes.length ||
      semantics.totalTriangleCount !==
        collision.meshes.reduce((sum, mesh) => sum + mesh.idx.length / 3, 0) ||
      semantics.unknownCount !== 0
    )
      throw new Error("invalid H1COL2 metadata v4 triangle-semantics contract");
    normalizedHistogram(
      semantics.histogram,
      "H1COL2 metadata triangleSemantics.histogram"
    );
    if (
      !value.semanticPolicy ||
      value.semanticPolicy.schema !== SEMANTIC_POLICY_SCHEMA ||
      typeof value.semanticPolicy.file !== "string" ||
      !value.semanticPolicy.file ||
      !isSha256(value.semanticPolicy.sha256)
    )
      throw new Error("invalid H1COL2 metadata v4 semantic-policy contract");
  }
  return { value, byMesh, isProduction };
}

function loadTriangleSemantics(path, expected, collisionHash, collision) {
  const data = readFileSync(path);
  if (data.length < H1SEM1_HEADER_BYTES)
    throw new Error(
      `truncated H1SEM1 header: expected ${H1SEM1_HEADER_BYTES} bytes, got ${data.length}`
    );
  if (data.subarray(0, 8).toString("latin1") !== H1SEM1_MAGIC)
    throw new Error("invalid H1SEM1 magic");
  const version = data.readUInt32LE(8);
  const headerBytes = data.readUInt32LE(12);
  const semanticSchemaVersion = data.readUInt32LE(16);
  const meshCount = data.readUInt32LE(20);
  const totalTriangleCount = data.readUInt32LE(24);
  const reserved = data.readUInt32LE(28);
  const boundCollisionHash = data.subarray(32, 64).toString("hex");
  if (version !== H1SEM1_VERSION)
    throw new Error(`unsupported H1SEM1 version ${version}`);
  if (headerBytes !== H1SEM1_HEADER_BYTES)
    throw new Error(
      `invalid H1SEM1 header size ${headerBytes}, expected ${H1SEM1_HEADER_BYTES}`
    );
  if (semanticSchemaVersion !== H1SEM1_SEMANTIC_SCHEMA_VERSION)
    throw new Error(
      `unsupported H1SEM1 semantic schema version ${semanticSchemaVersion}`
    );
  if (reserved !== 0)
    throw new Error(`H1SEM1 reserved field must be zero, got ${reserved}`);
  if (
    meshCount !== collision.meshes.length ||
    meshCount !== expected.meshCount ||
    totalTriangleCount !== expected.totalTriangleCount
  )
    throw new Error("H1SEM1 mesh/triangle cardinality does not match metadata");
  const expectedLength =
    H1SEM1_HEADER_BYTES + (meshCount + 1) * 4 + totalTriangleCount;
  if (data.length < expectedLength)
    throw new Error(
      `truncated H1SEM1 artifact: expected ${expectedLength} bytes, got ${data.length}`
    );
  if (data.length > expectedLength)
    throw new Error(
      `trailing H1SEM1 data: expected ${expectedLength} bytes, got ${data.length}`
    );
  if (
    boundCollisionHash !== collisionHash ||
    expected.collisionSha256 !== collisionHash
  )
    throw new Error("H1SEM1 H1COL2 SHA256 mismatch");
  if (sha256File(path) !== expected.sha256)
    throw new Error("H1SEM1 SHA256 does not match H1COL2 metadata");

  const offsets = new Uint32Array(meshCount + 1);
  for (let index = 0; index <= meshCount; index++)
    offsets[index] = data.readUInt32LE(H1SEM1_HEADER_BYTES + index * 4);
  if (offsets[0] !== 0)
    throw new Error(`H1SEM1 first mesh offset must be zero, got ${offsets[0]}`);
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    if (offsets[meshIndex + 1] < offsets[meshIndex])
      throw new Error(
        `H1SEM1 mesh offsets are not monotonic at mesh ${meshIndex}`
      );
    const actualCount = offsets[meshIndex + 1] - offsets[meshIndex];
    const requiredCount = collision.meshes[meshIndex].idx.length / 3;
    if (actualCount !== requiredCount)
      throw new Error(
        `H1SEM1 mesh ${meshIndex} triangle count mismatch: expected ${requiredCount}, artifact has ${actualCount}`
      );
  }
  if (offsets[meshCount] !== totalTriangleCount)
    throw new Error(
      `H1SEM1 final mesh offset ${offsets[meshCount]} does not equal total triangle count ${totalTriangleCount}`
    );

  const semanticsStart = H1SEM1_HEADER_BYTES + (meshCount + 1) * 4;
  const semanticIds = data.subarray(semanticsStart);
  const histogram = {};
  const meshHistograms = [];
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const meshHistogram = {};
    for (
      let ordinal = offsets[meshIndex];
      ordinal < offsets[meshIndex + 1];
      ordinal++
    ) {
      const semanticId = semanticIds[ordinal];
      const material = SEMANTIC_MATERIALS[semanticId];
      if (!material)
        throw new Error(
          `invalid H1SEM1 semantic id ${semanticId} at triangle ${ordinal}`
        );
      if (
        semanticId === TERRAIN_SEMANTIC_ID ||
        semanticId === UNKNOWN_SEMANTIC_ID
      )
        throw new Error(
          `production H1SEM1 cannot contain ${material.slice(4)} semantic id at triangle ${ordinal}`
        );
      if (
        !semanticCompatibleWithKind(
          collision.meshes[meshIndex].kind,
          semanticId
        )
      )
        throw new Error(
          `H1SEM1 mesh ${meshIndex} kind ${collision.meshes[meshIndex].kind} has unsafe semantic ${material}`
        );
      histogram[material] = (histogram[material] ?? 0) + 1;
      meshHistogram[material] = (meshHistogram[material] ?? 0) + 1;
    }
    meshHistograms.push(
      Object.fromEntries(
        Object.entries(meshHistogram).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      )
    );
  }
  const sortedHistogram = Object.fromEntries(
    Object.entries(histogram).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  assertHistogram(
    expected.histogram,
    sortedHistogram,
    "H1COL2 metadata triangleSemantics.histogram"
  );
  return { offsets, semanticIds, histogram: sortedHistogram, meshHistograms };
}

function loadInstanceIds(path, expected, collision) {
  const data = readFileSync(path);
  if (
    data.length < 16 ||
    data.subarray(0, 8).toString("latin1") !== "H1CID1\0\0" ||
    data.readUInt32LE(8) !== 1
  )
    throw new Error("invalid H1CID1 instance-ID sidecar header");
  const count = data.readUInt32LE(12);
  if (
    count !== collision.instCount ||
    count !== expected.count ||
    data.length !== 16 + count * 4 ||
    sha256File(path) !== expected.sha256
  )
    throw new Error("H1CID1 sidecar does not match H1COL2 metadata");
  return new Uint32Array(
    data.buffer.slice(data.byteOffset + 16, data.byteOffset + data.length)
  );
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
    collision,
    {
      allowLegacyActorSemantics: options.allowLegacyActorSemantics === true
    }
  );
  if (!metadata && options.allowLegacyActorSemantics !== true)
    throw new Error(
      `production export requires ${COLLISION_METADATA_SCHEMA} metadata with H1SEM1`
    );
  let triangleSemanticsPath = null;
  let triangleSemantics = null;
  let semanticPolicyPath = null;
  let semanticPolicy = null;
  if (metadata?.isProduction) {
    semanticPolicyPath = resolve(
      dirname(metadataPath),
      metadata.value.semanticPolicy.file
    );
    semanticPolicy = loadSemanticPolicy(
      semanticPolicyPath,
      metadata.value.semanticPolicy
    );
    triangleSemanticsPath = options.triangleSemanticsPath
      ? resolve(options.triangleSemanticsPath)
      : resolve(dirname(metadataPath), metadata.value.triangleSemantics.file);
    triangleSemantics = loadTriangleSemantics(
      triangleSemanticsPath,
      metadata.value.triangleSemantics,
      collisionHash,
      collision
    );
    for (let meshIndex = 0; meshIndex < collision.meshes.length; meshIndex++)
      assertHistogram(
        metadata.byMesh[meshIndex].semanticHistogram,
        triangleSemantics.meshHistograms[meshIndex],
        `H1COL2 metadata mesh ${meshIndex} semanticHistogram`
      );
  } else if (options.triangleSemanticsPath) {
    throw new Error(
      "--collision-triangle-semantics requires production metadata schema v4"
    );
  }
  let instanceIdsPath = null;
  let instanceIds = null;
  if (
    metadata?.isProduction ||
    metadata?.value.schema === "h1emu-h1col2-metadata-v3"
  ) {
    instanceIdsPath = options.instanceIdsPath
      ? resolve(options.instanceIdsPath)
      : resolve(dirname(metadataPath), metadata.value.instanceIds.file);
    instanceIds = loadInstanceIds(
      instanceIdsPath,
      metadata.value.instanceIds,
      collision
    );
  }
  const getHeight = await (dependencies.loadHeightmap ?? loadHeightmap)(
    heightmapPath
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const materials = {};
  const instanceKinds = [0, 0, 0, 0];
  let includedInstances = 0;
  let droppedTriangles = 0;
  let normalizedWalkableWindingTriangles = 0;
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
      const legacyMaterial = triangleSemantics
        ? null
        : (meshMetadata?.semanticMaterial ?? DEFAULT_KIND_MATERIALS[mesh.kind]);
      if (legacyMaterial && !allowedMaterial(mesh.kind, legacyMaterial))
        throw new Error(
          `mesh ${meshIndex} has unsafe semantic ${legacyMaterial}`
        );

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
      writer.line(
        `o ${actorName}__instance_${instanceIds?.[instanceIndex] ?? instanceIndex}`
      );
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
      let activeMaterial = null;
      for (let index = 0; index < mesh.idx.length; index += 3) {
        const triangleOrdinal = index / 3;
        const semanticId = triangleSemantics
          ? triangleSemantics.semanticIds[
              triangleSemantics.offsets[meshIndex] + triangleOrdinal
            ]
          : null;
        const material = triangleSemantics
          ? SEMANTIC_MATERIALS[semanticId]
          : legacyMaterial;
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
        const normalLengthSquared = edge1.cross(edge2).lengthSq();
        if (a === b || b === c || a === c || normalLengthSquared < 1e-12) {
          droppedTriangles++;
          continue;
        }
        if (material !== activeMaterial) {
          writer.line(`usemtl ${material}`);
          activeMaterial = material;
        }
        const normalizeWalkableWinding =
          triangleSemantics &&
          semanticId >= FIRST_WALKABLE_SEMANTIC_ID &&
          semanticId <= LAST_WALKABLE_SEMANTIC_ID &&
          edge1.y < 0;
        if (normalizeWalkableWinding) normalizedWalkableWindingTriangles++;
        writer.line(
          `f ${vertexBase + a} ${vertexBase + (normalizeWalkableWinding ? c : b)} ${vertexBase + (normalizeWalkableWinding ? b : c)}`
        );
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
    "Terrain remains underneath intersecting structures because H1COL2 has no footprint/portal ownership contract.",
    "Intersecting instances are emitted whole and are clipped by the bounded Recast bake, preserving actor topology."
  ];
  if (!triangleSemantics)
    limitations.unshift(
      "Diagnostic legacy actor semantics are enabled; composite meshes do not have per-triangle surface identity."
    );
  const report = {
    schema: SOURCE_SCHEMA,
    semanticContract: SEMANTIC_SCHEMA,
    semanticMode: triangleSemantics
      ? "per-triangle-h1sem1"
      : "legacy-actor-diagnostic",
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
        : null,
      collisionInstanceIds: instanceIdsPath
        ? {
            file: basename(instanceIdsPath),
            sha256: sha256File(instanceIdsPath),
            matched: true
          }
        : null,
      collisionTriangleSemantics: triangleSemanticsPath
        ? {
            file: basename(triangleSemanticsPath),
            sha256: sha256File(triangleSemanticsPath),
            matched: true,
            format: H1SEM1_FORMAT
          }
        : null,
      collisionSemanticPolicy: semanticPolicyPath
        ? {
            file: basename(semanticPolicyPath),
            sha256: sha256File(semanticPolicyPath),
            matched: true,
            schema: semanticPolicy.schema,
            canonical: true
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
      droppedDegenerateTriangles: droppedTriangles,
      normalizedWalkableWindingTriangles
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
    else if (name === "--collision-instance-ids")
      result.instanceIdsPath = argv[++index];
    else if (name === "--collision-triangle-semantics")
      result.triangleSemanticsPath = argv[++index];
    else if (name === "--allow-legacy-actor-semantics")
      result.allowLegacyActorSemantics = true;
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
  H1SEM1_FORMAT,
  SEMANTIC_POLICY_SCHEMA,
  SOURCE_SCHEMA,
  exportSemanticRegion,
  loadInstanceIds,
  loadCollisionMetadata,
  loadSemanticPolicy,
  loadTriangleSemantics,
  parseArgs,
  validateH1Col2
};

if (require.main === module)
  main().catch((error) => {
    console.error(`[semantic-obj] ${error.message}`);
    process.exitCode = 1;
  });
