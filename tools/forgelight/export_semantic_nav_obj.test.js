"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  COLLISION_METADATA_SCHEMA,
  exportSemanticRegion,
  loadInstanceIds,
  loadCollisionMetadata,
  loadSemanticPolicy,
  loadTriangleSemantics,
  parseArgs
} = require("./export_semantic_nav_obj");
const { readBin } = require("./gen_navmesh");

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

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

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

function defaultMeshes() {
  return [0, 1, 2, 3].map((kind) => ({
    kind,
    positions: [0, 0, 0, 0, 0, 0.5, 0.5, 0, 0],
    indices: [0, 1, 2]
  }));
}

function writeCollision(path, meshes = defaultMeshes()) {
  const parts = [
    Buffer.from("H1COL2\0\0", "latin1"),
    u32([2, meshes.length, meshes.length])
  ];
  for (const mesh of meshes) {
    const header = Buffer.alloc(9);
    header.writeUInt8(mesh.kind, 0);
    header.writeUInt32LE(mesh.positions.length / 3, 1);
    header.writeUInt32LE(mesh.indices.length, 5);
    parts.push(header, f32(mesh.positions), u32(mesh.indices));
  }
  parts.push(u32(meshes.map((_, index) => index)));
  const instances = [];
  for (let index = 0; index < meshes.length; index++) {
    const x = index;
    instances.push(x, 1, 1, 0, 0, 0, 1, 1, 1, 1, x, 1, 1, x + 0.5, 1, 1.5);
  }
  parts.push(f32(instances));
  writeFileSync(path, Buffer.concat(parts));
}

function writeInstanceIds(path, ids = [101, 102, 103, 104]) {
  const header = Buffer.alloc(16);
  header.write("H1CID1\0\0", 0, "latin1");
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(ids.length, 12);
  writeFileSync(path, Buffer.concat([header, u32(ids)]));
}

function histogram(ids) {
  const result = {};
  for (const id of ids) {
    const material = SEMANTIC_MATERIALS[id];
    result[material] = (result[material] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right))
  );
}

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function writeSemanticPolicy(path, overrides = {}) {
  const value = {
    schema: "h1emu-h1col2-semantic-policy-v1",
    semanticContract: "h1emu-nav-semantics-v1",
    semanticSchemaVersion: 1,
    coordinateSpace: "h1z1-world-y-up-meters",
    defaults: { walkable: "nav_unknown" },
    rules: [
      { actorFile: "Common_Props_Modular_Stair01.adr", semantic: "nav_stair" },
      { actorFile: "Mesh1.adr", semantic: "nav_obstacle_static" }
    ],
    ...overrides
  };
  writeFileSync(path, `${canonicalJson(value)}\n`);
  return value;
}

function writeH1sem(path, collisionPath, meshSemantics) {
  const collisionHash = createHash("sha256")
    .update(readFileSync(collisionPath))
    .digest();
  const flattened = Buffer.from(meshSemantics.flat());
  const header = Buffer.alloc(64);
  header.write("H1SEM1\0\0", 0, "latin1");
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(64, 12);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(meshSemantics.length, 20);
  header.writeUInt32LE(flattened.length, 24);
  header.writeUInt32LE(0, 28);
  collisionHash.copy(header, 32);
  const offsets = [0];
  for (const values of meshSemantics)
    offsets.push(offsets[offsets.length - 1] + values.length);
  writeFileSync(path, Buffer.concat([header, u32(offsets), flattened]));
}

function writeMetadata(
  path,
  collisionPath,
  schema,
  instanceIdsPath = null,
  triangleSemanticsPath = null,
  meshSemantics = null,
  semanticPolicyPath = null
) {
  const collision = readBin(collisionPath);
  const collisionBytes = readFileSync(collisionPath);
  const collisionHash = sha256(collisionBytes);
  const legacyMaterials = [
    "nav_stair",
    "nav_obstacle_static",
    "nav_exclude",
    "nav_door_panel_dynamic"
  ];
  const production = schema === COLLISION_METADATA_SCHEMA;
  const value = {
    schema,
    formatVersion: 2,
    coordinateSpace: "h1z1-world-y-up-meters",
    ...(schema !== "h1emu-h1col2-metadata-v1"
      ? { geometrySource: "adr_collision_cdta", renderFallbackCount: 0 }
      : {}),
    collisionFile: "collision.bin",
    collisionSha256: collisionHash,
    meshCount: collision.meshes.length,
    instanceCount: collision.instCount,
    ...(schema === "h1emu-h1col2-metadata-v3" || production
      ? {
          instanceIds: {
            file: "collision.instance_ids.bin",
            sha256: sha256(readFileSync(instanceIdsPath)),
            format: "H1CID1-u32le-v1",
            count: collision.instCount
          }
        }
      : {}),
    ...(production
      ? {
          semanticMode: "strict-production",
          limitations: [],
          dynamicDoorObstaclesAcknowledged: true,
          triangleSemantics: {
            file: "collision.triangle_semantics.bin",
            sha256: sha256(readFileSync(triangleSemanticsPath)),
            format: "H1SEM1-u8le-v1",
            semanticContract: "h1emu-nav-semantics-v1",
            semanticSchemaVersion: 1,
            collisionSha256: collisionHash,
            meshCount: collision.meshes.length,
            totalTriangleCount: meshSemantics.flat().length,
            unknownCount: meshSemantics.flat().filter((id) => id === 11).length,
            histogram: histogram(meshSemantics.flat())
          },
          semanticPolicy: {
            schema: "h1emu-h1col2-semantic-policy-v1",
            file: "semantic-policy.json",
            sha256: sha256(readFileSync(semanticPolicyPath))
          }
        }
      : {}),
    meshes: collision.meshes.map((mesh, meshIndex) => ({
      meshIndex,
      actorFile:
        meshIndex === 0
          ? "Common_Props_Modular_Stair01.adr"
          : `Mesh${meshIndex}.adr`,
      kind: mesh.kind,
      ...(schema !== "h1emu-h1col2-metadata-v1"
        ? {
            collisionAsset: `Mesh${meshIndex}.cdt`,
            triangleCount: mesh.idx.length / 3,
            semanticSource: production
              ? "per_triangle_sidecar_v1"
              : "actor_default_pending_per_triangle_table"
          }
        : {}),
      ...(production
        ? { semanticHistogram: histogram(meshSemantics[meshIndex]) }
        : {
            semanticMaterial:
              legacyMaterials[meshIndex] ??
              (mesh.kind === 0
                ? "nav_floor_exterior"
                : mesh.kind === 3
                  ? "nav_door_panel_dynamic"
                  : "nav_obstacle_static")
          }),
      instanceCount: 1
    }))
  };
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeProductionBundle(
  root,
  meshes = defaultMeshes(),
  meshSemantics = null
) {
  const collisionPath = join(root, "collision.bin");
  const instanceIdsPath = join(root, "collision.instance_ids.bin");
  const triangleSemanticsPath = join(root, "collision.triangle_semantics.bin");
  const semanticPolicyPath = join(root, "semantic-policy.json");
  const metadataPath = join(root, "collision.metadata.json");
  writeCollision(collisionPath, meshes);
  writeInstanceIds(
    instanceIdsPath,
    meshes.map((_, index) => 101 + index)
  );
  const semantics =
    meshSemantics ?? meshes.map((mesh) => [[5, 8, 10, 9][mesh.kind]]);
  writeH1sem(triangleSemanticsPath, collisionPath, semantics);
  writeSemanticPolicy(semanticPolicyPath);
  writeMetadata(
    metadataPath,
    collisionPath,
    COLLISION_METADATA_SCHEMA,
    instanceIdsPath,
    triangleSemanticsPath,
    semantics,
    semanticPolicyPath
  );
  return {
    collisionPath,
    instanceIdsPath,
    triangleSemanticsPath,
    semanticPolicyPath,
    metadataPath,
    meshSemantics: semantics
  };
}

function exportInputs(root, bundle) {
  const heightmapPath = join(root, "heightmap.png");
  writeFileSync(heightmapPath, "synthetic heightmap identity");
  return {
    bounds: [0, 0, 10, 2],
    terrainStep: 1,
    heightmapPath,
    ...bundle
  };
}

const dependencies = {
  readBin,
  loadHeightmap: async () => (x, z) => x + z
};

test("exports deterministic strict v4/H1SEM1 semantics and stable IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-obj-v4-"));
  const bundle = writeProductionBundle(root);
  const common = exportInputs(root, bundle);
  const firstOutput = join(root, "first.obj");
  const secondOutput = join(root, "second.obj");
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
  assert.equal(first.semanticMode, "per-triangle-h1sem1");
  assert.equal(first.inputs.collisionTriangleSemantics.matched, true);
  assert.deepEqual(first.inputs.collisionSemanticPolicy, {
    file: "semantic-policy.json",
    sha256: sha256(readFileSync(bundle.semanticPolicyPath)),
    matched: true,
    schema: "h1emu-h1col2-semantic-policy-v1",
    canonical: true
  });
  assert.deepEqual(first.counts.materialTriangles, {
    nav_door_panel_dynamic: 1,
    nav_exclude: 1,
    nav_obstacle_static: 1,
    nav_stair: 1,
    nav_terrain: 40
  });
  const obj = readFileSync(firstOutput, "utf8");
  assert.match(obj, /Common_Props_Modular_Stair01__instance_101/);
  assert.match(obj, /Mesh3__instance_104/);
  for (const material of [
    "nav_terrain",
    "nav_stair",
    "nav_obstacle_static",
    "nav_exclude",
    "nav_door_panel_dynamic"
  ])
    assert.match(obj, new RegExp(`usemtl ${material}`));
});

test("emits material switches per triangle and advances past degenerates", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-per-face-"));
  const meshes = [
    {
      kind: 0,
      positions: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 0, 1, 1, 3, 2]
    }
  ];
  const bundle = writeProductionBundle(root, meshes, [[2, 5, 4]]);
  const outputPath = join(root, "per-face.obj");
  const report = await exportSemanticRegion(
    { ...exportInputs(root, bundle), outputPath },
    dependencies
  );
  const obj = readFileSync(outputPath, "utf8");
  assert.match(
    obj,
    /usemtl nav_road\nf \d+ \d+ \d+\nusemtl nav_floor_interior\nf \d+ \d+ \d+/
  );
  assert.doesNotMatch(obj, /usemtl nav_stair/);
  assert.equal(report.counts.droppedDegenerateTriangles, 1);
  assert.equal(report.counts.materialTriangles.nav_road, 1);
  assert.equal(report.counts.materialTriangles.nav_floor_interior, 1);
});

test("normalizes only downward-wound H1SEM1 walkable faces", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-winding-"));
  const meshes = [
    {
      kind: 0,
      positions: [0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0],
      indices: [0, 1, 2, 3, 4, 5]
    }
  ];
  const bundle = writeProductionBundle(root, meshes, [[2, 8]]);
  const outputPath = join(root, "winding.obj");
  const report = await exportSemanticRegion(
    { ...exportInputs(root, bundle), outputPath },
    dependencies
  );
  const obj = readFileSync(outputPath, "utf8");
  const objectStart = obj.indexOf(
    "o Common_Props_Modular_Stair01__instance_101"
  );
  const collisionObj = obj.slice(objectStart);
  const faceLines = collisionObj
    .split("\n")
    .filter((line) => line.startsWith("f "));
  const first = faceLines[0].split(" ").slice(1).map(Number);
  const second = faceLines[1].split(" ").slice(1).map(Number);
  assert.deepEqual(first, [first[0], first[0] + 2, first[0] + 1]);
  assert.deepEqual(second, [first[0] + 3, first[0] + 4, first[0] + 5]);
  assert.match(
    collisionObj,
    /usemtl nav_road\nf \d+ \d+ \d+\nusemtl nav_obstacle_static\nf \d+ \d+ \d+/
  );
  assert.equal(report.counts.normalizedWalkableWindingTriangles, 1);
  assert.equal(report.counts.materialTriangles.nav_obstacle_static, 1);
});

test("production default rejects missing and legacy metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-legacy-gate-"));
  const collisionPath = join(root, "collision.bin");
  const metadataPath = join(root, "collision.metadata.json");
  const heightmapPath = join(root, "heightmap.png");
  writeCollision(collisionPath);
  writeMetadata(metadataPath, collisionPath, "h1emu-h1col2-metadata-v1");
  writeFileSync(heightmapPath, "heightmap");
  const base = {
    bounds: [0, 0, 10, 2],
    collisionPath,
    heightmapPath,
    outputPath: join(root, "missing.obj")
  };
  await assert.rejects(
    exportSemanticRegion(base, dependencies),
    /requires .*v4 metadata/
  );
  await assert.rejects(
    exportSemanticRegion(
      { ...base, metadataPath, outputPath: join(root, "legacy-refused.obj") },
      dependencies
    ),
    /legacy v1-v3 metadata requires --allow-legacy-actor-semantics/
  );
});

test("producer-shaped v4 requires acknowledged strict-production mode", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-producer-mode-"));
  const bundle = writeProductionBundle(root);
  const collision = readBin(bundle.collisionPath);
  const collisionHash = sha256(readFileSync(bundle.collisionPath));

  const strict = loadCollisionMetadata(
    bundle.metadataPath,
    collisionHash,
    collision
  );
  assert.equal(strict.isProduction, true);
  assert.equal(strict.value.semanticMode, "strict-production");

  const diagnostic = JSON.parse(readFileSync(bundle.metadataPath, "utf8"));
  diagnostic.semanticMode = "diagnostic";
  diagnostic.limitations = [
    "Diagnostic bundles may contain nav_unknown and must not be consumed as production navigation."
  ];
  writeFileSync(bundle.metadataPath, `${JSON.stringify(diagnostic)}\n`);
  assert.throws(
    () => loadCollisionMetadata(bundle.metadataPath, collisionHash, collision),
    /requires semanticMode strict-production/
  );

  diagnostic.semanticMode = "strict-production";
  diagnostic.limitations[0] =
    "Runtime dynamic door-obstacle parity is unproven; non-streaming navigation paths may bypass DoorEntity blockers.";
  writeFileSync(bundle.metadataPath, `${JSON.stringify(diagnostic)}\n`);
  assert.throws(
    () => loadCollisionMetadata(bundle.metadataPath, collisionHash, collision),
    /strict-production has unresolved limitations/
  );

  diagnostic.limitations = [];
  diagnostic.dynamicDoorObstaclesAcknowledged = false;
  writeFileSync(bundle.metadataPath, `${JSON.stringify(diagnostic)}\n`);
  assert.throws(
    () => loadCollisionMetadata(bundle.metadataPath, collisionHash, collision),
    /lacks dynamic door-obstacle acknowledgement/
  );
});

test("legacy actor semantics remain available only by explicit diagnostic flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-legacy-"));
  const collisionPath = join(root, "collision.bin");
  const metadataPath = join(root, "collision.metadata.json");
  const heightmapPath = join(root, "heightmap.png");
  writeCollision(collisionPath);
  writeMetadata(metadataPath, collisionPath, "h1emu-h1col2-metadata-v1");
  writeFileSync(heightmapPath, "heightmap");
  const outputPath = join(root, "legacy.obj");
  const report = await exportSemanticRegion(
    {
      bounds: [0, 0, 10, 2],
      collisionPath,
      metadataPath,
      heightmapPath,
      outputPath,
      allowLegacyActorSemantics: true
    },
    dependencies
  );
  assert.equal(report.semanticMode, "legacy-actor-diagnostic");
  assert.match(readFileSync(outputPath, "utf8"), /usemtl nav_stair/);
});

test("requires hash-bound canonical semantic policy bytes and sorted unique rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-policy-"));
  const bundle = writeProductionBundle(root);
  const validBytes = readFileSync(bundle.semanticPolicyPath);
  const validExpected = {
    schema: "h1emu-h1col2-semantic-policy-v1",
    file: "semantic-policy.json",
    sha256: sha256(validBytes)
  };
  assert.equal(
    loadSemanticPolicy(bundle.semanticPolicyPath, validExpected).schema,
    "h1emu-h1col2-semantic-policy-v1"
  );
  assert.throws(
    () =>
      loadSemanticPolicy(bundle.semanticPolicyPath, {
        ...validExpected,
        sha256: "0".repeat(64)
      }),
    /SHA256 does not match/
  );

  const policy = JSON.parse(validBytes);
  const cases = [
    [
      "bom",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validBytes]),
      /without a BOM/
    ],
    ["pretty", `${JSON.stringify(policy, null, 2)}\n`, /not canonical JSON/],
    [
      "wrong-schema",
      `${canonicalJson({ ...policy, schema: "wrong" })}\n`,
      /invalid H1COL2 semantic policy contract/
    ],
    [
      "unsorted",
      `${canonicalJson({ ...policy, rules: [...policy.rules].reverse() })}\n`,
      /not sorted by actorFile.casefold/
    ],
    [
      "duplicate",
      `${canonicalJson({
        ...policy,
        rules: [
          policy.rules[0],
          {
            ...policy.rules[0],
            actorFile: policy.rules[0].actorFile.toUpperCase()
          }
        ]
      })}\n`,
      /duplicate actorFile/
    ]
  ];
  for (const [name, contents, expectedError] of cases) {
    const path = join(root, `${name}.json`);
    writeFileSync(path, contents);
    assert.throws(
      () =>
        loadSemanticPolicy(path, {
          ...validExpected,
          sha256: sha256(readFileSync(path))
        }),
      expectedError,
      name
    );
  }

  writeFileSync(
    bundle.semanticPolicyPath,
    `${JSON.stringify(policy, null, 2)}\n`
  );
  const brokenSemantics = Buffer.from(
    readFileSync(bundle.triangleSemanticsPath)
  );
  brokenSemantics.write("BROKEN!!", 0, "latin1");
  writeFileSync(bundle.triangleSemanticsPath, brokenSemantics);
  const metadata = JSON.parse(readFileSync(bundle.metadataPath, "utf8"));
  metadata.semanticPolicy.sha256 = sha256(
    readFileSync(bundle.semanticPolicyPath)
  );
  metadata.triangleSemantics.sha256 = sha256(brokenSemantics);
  writeFileSync(bundle.metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    exportSemanticRegion(
      {
        ...exportInputs(root, bundle),
        outputPath: join(root, "policy-before-h1sem.obj")
      },
      dependencies
    ),
    /semantic policy bytes are not canonical/
  );
});

test("rejects H1SEM1 header, exact-length, hash, cardinality, offset, and ID corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-corrupt-"));
  const bundle = writeProductionBundle(root);
  const collision = readBin(bundle.collisionPath);
  const metadata = JSON.parse(readFileSync(bundle.metadataPath, "utf8"));
  const collisionHash = sha256(readFileSync(bundle.collisionPath));
  const original = readFileSync(bundle.triangleSemanticsPath);
  const cases = [
    [
      "magic",
      (data) => data.write("BROKEN!!", 0, "latin1"),
      /invalid H1SEM1 magic/
    ],
    [
      "version",
      (data) => data.writeUInt32LE(2, 8),
      /unsupported H1SEM1 version 2/
    ],
    [
      "header",
      (data) => data.writeUInt32LE(60, 12),
      /invalid H1SEM1 header size/
    ],
    [
      "schema",
      (data) => data.writeUInt32LE(2, 16),
      /unsupported H1SEM1 semantic schema/
    ],
    [
      "reserved",
      (data) => data.writeUInt32LE(1, 28),
      /reserved field must be zero/
    ],
    [
      "collision hash",
      (data) => data.fill(0, 32, 64),
      /H1COL2 SHA256 mismatch/
    ],
    ["mesh count", (data) => data.writeUInt32LE(3, 20), /cardinality/],
    ["first offset", (data) => data.writeUInt32LE(1, 64), /first mesh offset/],
    ["nonmonotonic", (data) => data.writeUInt32LE(0, 72), /not monotonic/],
    [
      "id zero",
      (data) => (data[data.length - 1] = 0),
      /invalid H1SEM1 semantic id 0/
    ],
    [
      "id high",
      (data) => (data[data.length - 1] = 12),
      /invalid H1SEM1 semantic id 12/
    ],
    [
      "terrain",
      (data) => (data[data.length - 1] = 1),
      /cannot contain terrain/
    ],
    [
      "unknown",
      (data) => (data[data.length - 1] = 11),
      /cannot contain unknown/
    ]
  ];
  for (const [name, mutate, expected] of cases) {
    const path = join(root, `${name.replace(/\s/g, "-")}.bin`);
    const data = Buffer.from(original);
    mutate(data);
    writeFileSync(path, data);
    const expectedContract = {
      ...metadata.triangleSemantics,
      sha256: sha256(data)
    };
    assert.throws(
      () =>
        loadTriangleSemantics(path, expectedContract, collisionHash, collision),
      expected,
      name
    );
  }

  const truncatedPath = join(root, "truncated.bin");
  writeFileSync(truncatedPath, original.subarray(0, original.length - 1));
  assert.throws(
    () =>
      loadTriangleSemantics(
        truncatedPath,
        {
          ...metadata.triangleSemantics,
          sha256: sha256(readFileSync(truncatedPath))
        },
        collisionHash,
        collision
      ),
    /truncated H1SEM1/
  );
  const trailingPath = join(root, "trailing.bin");
  writeFileSync(trailingPath, Buffer.concat([original, Buffer.from([1])]));
  assert.throws(
    () =>
      loadTriangleSemantics(
        trailingPath,
        {
          ...metadata.triangleSemantics,
          sha256: sha256(readFileSync(trailingPath))
        },
        collisionHash,
        collision
      ),
    /trailing H1SEM1/
  );
});

test("enforces the production H1COL2-kind to H1SEM1 compatibility matrix", () => {
  const cases = [
    [0, 9, /kind 0 has unsafe semantic nav_door_panel_dynamic/],
    [1, 10, /kind 1 has unsafe semantic nav_exclude/],
    [2, 3, /kind 2 has unsafe semantic nav_floor_exterior/],
    [2, 9, /kind 2 has unsafe semantic nav_door_panel_dynamic/],
    [3, 8, /kind 3 has unsafe semantic nav_obstacle_static/]
  ];
  for (const [kind, semanticId, expectedError] of cases) {
    const root = mkdtempSync(
      join(tmpdir(), `h1emu-semantic-kind-${kind}-${semanticId}-`)
    );
    const mesh = {
      kind,
      positions: [0, 0, 0, 0, 0, 1, 1, 0, 0],
      indices: [0, 1, 2]
    };
    const bundle = writeProductionBundle(root, [mesh], [[semanticId]]);
    const metadata = JSON.parse(readFileSync(bundle.metadataPath, "utf8"));
    assert.throws(
      () =>
        loadTriangleSemantics(
          bundle.triangleSemanticsPath,
          metadata.triangleSemantics,
          sha256(readFileSync(bundle.collisionPath)),
          readBin(bundle.collisionPath)
        ),
      expectedError,
      `kind ${kind} semantic ${semanticId}`
    );
  }
});

test("rejects mismatched v4 metadata histograms and preserves H1CID1 validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-semantic-contract-"));
  const bundle = writeProductionBundle(root);
  const metadata = JSON.parse(readFileSync(bundle.metadataPath, "utf8"));
  const ids = loadInstanceIds(
    bundle.instanceIdsPath,
    metadata.instanceIds,
    readBin(bundle.collisionPath)
  );
  assert.deepEqual([...ids], [101, 102, 103, 104]);

  metadata.meshes[0].semanticHistogram = { nav_road: 1 };
  writeFileSync(bundle.metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    exportSemanticRegion(
      {
        ...exportInputs(root, bundle),
        outputPath: join(root, "bad-histogram.obj")
      },
      dependencies
    ),
    /mesh 0 semanticHistogram does not match/
  );
});

test("CLI exposes explicit H1SEM1 and legacy controls", () => {
  assert.deepEqual(
    parseArgs([
      "--bounds",
      "0",
      "0",
      "1",
      "1",
      "--heightmap",
      "height.png",
      "--collision",
      "collision.bin",
      "--collision-metadata",
      "collision.metadata.json",
      "--collision-triangle-semantics",
      "collision.h1sem",
      "--collision-instance-ids",
      "collision.h1cid",
      "--allow-legacy-actor-semantics",
      "--output",
      "out.obj"
    ]),
    {
      terrainStep: 1,
      maxTerrainVertices: 4_000_000,
      bounds: [0, 0, 1, 1],
      heightmapPath: "height.png",
      collisionPath: "collision.bin",
      metadataPath: "collision.metadata.json",
      triangleSemanticsPath: "collision.h1sem",
      instanceIdsPath: "collision.h1cid",
      allowLegacyActorSemantics: true,
      outputPath: "out.obj"
    }
  );
});

test("refuses an accidentally huge regional export before reading inputs", async () => {
  await assert.rejects(
    exportSemanticRegion({
      bounds: [0, 0, 100, 100],
      terrainStep: 1,
      maxTerrainVertices: 4,
      collisionPath: "unused.bin",
      heightmapPath: "unused.png",
      outputPath: "unused.obj"
    }),
    /regional terrain requires 10201 vertices/
  );
});
