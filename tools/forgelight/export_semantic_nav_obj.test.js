"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  exportSemanticRegion,
  loadCollisionMetadata
} = require("./export_semantic_nav_obj");
const { readBin } = require("./gen_navmesh");

function u32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32LE(value, index * 4));
  return buffer;
}

function f32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function writeCollision(path) {
  const meshes = [0, 1, 2, 3].map((kind) => ({
    kind,
    positions: [0, 0, 0, 0, 0, 0.5, 0.5, 0, 0],
    indices: [0, 1, 2]
  }));
  const parts = [Buffer.from("H1COL2\0\0", "latin1"), u32([2, 4, 4])];
  for (const mesh of meshes) {
    const header = Buffer.alloc(9);
    header.writeUInt8(mesh.kind, 0);
    header.writeUInt32LE(3, 1);
    header.writeUInt32LE(3, 5);
    parts.push(header, f32(mesh.positions), u32(mesh.indices));
  }
  parts.push(u32([0, 1, 2, 3]));
  const instances = [];
  for (let index = 0; index < 4; index++) {
    const x = index;
    instances.push(x, 1, 1, 0, 0, 0, 1, 1, 1, 1, x, 1, 1, x + 0.5, 1, 1.5);
  }
  parts.push(f32(instances));
  writeFileSync(path, Buffer.concat(parts));
}

function writeMetadata(path, collisionPath) {
  const collisionHash = createHash("sha256")
    .update(readFileSync(collisionPath))
    .digest("hex");
  const materials = [
    "nav_stair",
    "nav_obstacle_static",
    "nav_exclude",
    "nav_door_panel_dynamic"
  ];
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: "h1emu-h1col2-metadata-v1",
      formatVersion: 2,
      coordinateSpace: "h1z1-world-y-up-meters",
      collisionFile: "collision.bin",
      collisionSha256: collisionHash,
      meshCount: 4,
      instanceCount: 4,
      meshes: materials.map((semanticMaterial, meshIndex) => ({
        meshIndex,
        actorFile:
          meshIndex === 0
            ? "Common_Props_Modular_Stair01.adr"
            : `Mesh${meshIndex}.adr`,
        kind: meshIndex,
        semanticMaterial,
        instanceCount: 1
      }))
    })}\n`
  );
}

test("exports deterministic canonical semantics from heightmap plus H1COL2", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-obj-"));
  const collisionPath = join(root, "collision.bin");
  const metadataPath = join(root, "collision.metadata.json");
  const heightmapPath = join(root, "heightmap.png");
  writeCollision(collisionPath);
  writeMetadata(metadataPath, collisionPath);
  writeFileSync(heightmapPath, "synthetic heightmap identity");

  const dependencies = {
    readBin,
    loadHeightmap: async () => (x, z) => x + z
  };
  const firstOutput = join(root, "first.obj");
  const secondOutput = join(root, "second.obj");
  const common = {
    bounds: [0, 0, 4, 2],
    terrainStep: 1,
    collisionPath,
    metadataPath,
    heightmapPath
  };
  const first = await exportSemanticRegion(
    { ...common, outputPath: firstOutput },
    dependencies
  );
  const second = await exportSemanticRegion(
    { ...common, outputPath: secondOutput },
    dependencies
  );

  assert.equal(
    readFileSync(firstOutput, "utf8"),
    readFileSync(secondOutput, "utf8")
  );
  assert.equal(first.output.sha256, second.output.sha256);
  assert.deepEqual(
    { ...first, output: { ...first.output, file: "output.obj" } },
    { ...second, output: { ...second.output, file: "output.obj" } }
  );
  assert.equal(first.output.file, "first.obj");
  assert.deepEqual(first.counts.materialTriangles, {
    nav_door_panel_dynamic: 1,
    nav_exclude: 1,
    nav_obstacle_static: 1,
    nav_stair: 1,
    nav_terrain: 16
  });
  assert.deepEqual(first.counts.instanceKinds, {
    walkable: 1,
    solid: 1,
    thin: 1,
    door: 1
  });
  assert.equal(first.renderGeometryMerged, false);
  const obj = readFileSync(firstOutput, "utf8");
  assert.match(obj, /usemtl nav_terrain/);
  assert.match(obj, /usemtl nav_stair/);
  assert.match(obj, /usemtl nav_obstacle_static/);
  assert.match(obj, /usemtl nav_exclude/);
  assert.match(obj, /usemtl nav_door_panel_dynamic/);
  assert.doesNotMatch(obj, /usemtl (?!nav_)/);
});

test("rejects a sidecar that promotes thin collision to walkable", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-metadata-"));
  const collisionPath = join(root, "collision.bin");
  const metadataPath = join(root, "collision.metadata.json");
  writeCollision(collisionPath);
  writeMetadata(metadataPath, collisionPath);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata.meshes[2].semanticMaterial = "nav_floor_exterior";
  writeFileSync(metadataPath, JSON.stringify(metadata));
  const collision = readBin(collisionPath);
  const collisionHash = createHash("sha256")
    .update(readFileSync(collisionPath))
    .digest("hex");
  assert.throws(
    () => loadCollisionMetadata(metadataPath, collisionHash, collision),
    /invalid H1COL2 metadata mesh entry 2/
  );
});

test("refuses an unbounded or accidentally huge regional export", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-limit-"));
  const collisionPath = join(root, "collision.bin");
  const heightmapPath = join(root, "heightmap.png");
  writeCollision(collisionPath);
  writeFileSync(heightmapPath, "synthetic heightmap identity");
  await assert.rejects(
    exportSemanticRegion(
      {
        bounds: [0, 0, 100, 100],
        terrainStep: 1,
        maxTerrainVertices: 4,
        collisionPath,
        heightmapPath,
        outputPath: join(root, "too-large.obj")
      },
      { readBin, loadHeightmap: async () => () => 0 }
    ),
    /regional terrain requires 10201 vertices/
  );
});
