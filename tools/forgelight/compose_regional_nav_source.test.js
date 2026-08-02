"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  composeRegionalHybrid,
  intersectRectangle,
  loadPolicy,
  subtractRectangle
} = require("./compose_regional_nav_source");

const BOUNDS = { minX: 0, minZ: 0, maxX: 4, maxZ: 2 };

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "h1emu-hybrid-source-"));
  const paths = Object.fromEntries(
    [
      "base.obj",
      "base.source.json",
      "overlay.obj",
      "overlay-manifest.json",
      "overlay-lint.json",
      "policy.json"
    ].map((name) => [name, join(root, name)])
  );
  writeFileSync(
    paths["base.obj"],
    [
      "# h1emu-nav-semantics-v1",
      "o base_terrain",
      "usemtl nav_terrain",
      "v 0 0 0",
      "v 4 0 0",
      "v 4 0 2",
      "v 0 0 2",
      "f 1 2 3",
      "f 1 3 4",
      "o PoliceCollision__instance_7",
      "usemtl nav_floor_exterior",
      "v 1 0.1 0",
      "v 3 0.1 0",
      "v 3 0.6 2",
      "v 1 0.6 2",
      "f 5 6 7 8",
      "usemtl nav_obstacle_static",
      "v 2 0 0.5",
      "v 2 1 0.5",
      "v 2 0 1.5",
      "f 9 10 11",
      "o collision_prop__instance_9",
      "usemtl nav_obstacle_static",
      "v 0.5 0 0.5",
      "v 0.5 1 0.5",
      "v 0.5 0 1.5",
      "f 12 13 14",
      "o paper__instance_10",
      "usemtl nav_exclude",
      "v 3.5 0 0.5",
      "v 3.6 0 0.5",
      "v 3.5 0 0.6",
      "f 15 16 17",
      ""
    ].join("\n")
  );
  writeJson(paths["base.source.json"], {
    schema: "h1emu-collision-semantic-obj-v1",
    semanticContract: "h1emu-nav-semantics-v1",
    coordinateSpace: "h1z1-world-y-up-meters",
    sourceStrategy: "heightmap-plus-h1col2-only",
    renderGeometryMerged: false,
    bounds: BOUNDS
  });
  writeFileSync(
    paths["overlay.obj"],
    [
      "# h1emu-nav-semantics-v1",
      "o PoliceRender__instance_11",
      "usemtl nav_stair",
      "v 1 0 0",
      "v 3 0 0",
      "v 3 0.5 2",
      "v 1 0.5 2",
      "f 1 2 3 4",
      "usemtl nav_obstacle_static",
      "v 1.5 0 1",
      "v 1.5 1 1",
      "v 2.5 0 1",
      "f -3 -2 -1",
      "o unrelated_render_prop",
      "usemtl nav_obstacle_static",
      "v 3.5 0 1",
      "v 3.5 1 1",
      "v 3.8 0 1",
      "f -3 -2 -1",
      ""
    ].join("\n")
  );
  writeJson(paths["overlay-manifest.json"], {
    schemaVersion: 1,
    semanticSchemaVersion: 1,
    semanticMode: "strict",
    coordinateSpace: "h1z1-world-y-up-meters",
    navBounds: BOUNDS,
    worldObj: { path: "overlay.obj", sha256: sha256(paths["overlay.obj"]) }
  });
  writeJson(paths["overlay-lint.json"], {
    schemaVersion: 3,
    semanticSchemaVersion: 1,
    coordinateSpace: "h1z1-world-y-up-meters",
    bounds: BOUNDS,
    errors: []
  });
  writeJson(paths["policy.json"], {
    schema: "h1emu-regional-hybrid-policy-v1",
    coordinateSpace: "h1z1-world-y-up-meters",
    bounds: BOUNDS,
    ownership: [
      {
        id: "reviewed-entry",
        owner: "render-semantic-object",
        bounds: { minX: 1, minZ: 0, maxX: 3, maxZ: 2 },
        objectReplacement: {
          baseObject: "PoliceCollision__instance_7",
          overlayObject: "PoliceRender__instance_11"
        },
        requiredMaterials: ["nav_stair"]
      }
    ]
  });
  return { root, paths };
}

function options(fixture, outputName) {
  const { root, paths } = fixture;
  return {
    baseObjPath: paths["base.obj"],
    baseReportPath: paths["base.source.json"],
    overlayObjPath: paths["overlay.obj"],
    overlayManifestPath: paths["overlay-manifest.json"],
    overlayLintPath: paths["overlay-lint.json"],
    policyPath: paths["policy.json"],
    outputPath: join(root, outputName)
  };
}

function projectedMaterialAreas(path) {
  const vertices = [null];
  let material = null;
  const areas = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("v "))
      vertices.push(line.split(/\s+/).slice(1).map(Number));
    else if (line.startsWith("usemtl ")) material = line.slice(7);
    else if (line.startsWith("f ")) {
      const [a, b, c] = line
        .split(/\s+/)
        .slice(1)
        .map((value) => vertices[Number(value)]);
      const area =
        Math.abs(
          a[0] * (b[2] - c[2]) + b[0] * (c[2] - a[2]) + c[0] * (a[2] - b[2])
        ) / 2;
      areas[material] = (areas[material] ?? 0) + area;
    }
  }
  return areas;
}

test("replaces one exact actor while preserving terrain, props, and excludes", async () => {
  const fixture = createFixture();
  const report = await composeRegionalHybrid(options(fixture, "hybrid.obj"));
  const output = readFileSync(join(fixture.root, "hybrid.obj"), "utf8");
  const areas = projectedMaterialAreas(join(fixture.root, "hybrid.obj"));

  assert.equal(areas.nav_terrain, 8);
  assert.equal(areas.nav_stair, 4);
  assert.equal(report.renderGeometryMerged, true);
  assert.equal(
    report.counts.baseObjectReplacedMaterialTriangles.nav_floor_exterior,
    2
  );
  assert.equal(
    report.counts.baseObjectReplacedMaterialTriangles.nav_obstacle_static,
    1
  );
  assert.equal(report.counts.baseOutputMaterialTriangles.nav_exclude, 1);
  assert.equal(
    report.counts.overlayUnownedDiscardedMaterialTriangles.nav_obstacle_static,
    1
  );
  assert.equal(
    report.rules.crossSourceMappedObjectOverlapByConstruction,
    false
  );
  assert.equal(report.ownership[0].emittedMaterialTriangles.nav_stair, 2);
  assert.equal(
    report.ownership[0].emittedMaterialTriangles.nav_obstacle_static,
    1
  );
  assert.match(output, /collision_prop__instance_9/);
  assert.match(output, /paper__instance_10/);
  assert.match(output, /PoliceRender__instance_11/);
  assert.doesNotMatch(output, /PoliceCollision__instance_7/);
  assert.doesNotMatch(output, /unrelated_render_prop/);
  assert.equal(
    output.match(/^o .*PoliceRender__instance_11$/gm)?.length,
    1,
    "material changes must not split one exact actor into multiple OBJ objects"
  );
  assert.equal(
    report.rules.materialChangesPreserveExactOutputObjectIdentity,
    true
  );
});

test("produces deterministic geometry for the same owned seam", async () => {
  const fixture = createFixture();
  const first = await composeRegionalHybrid(options(fixture, "first.obj"));
  const second = await composeRegionalHybrid(options(fixture, "second.obj"));
  assert.equal(
    readFileSync(join(fixture.root, "first.obj"), "utf8"),
    readFileSync(join(fixture.root, "second.obj"), "utf8")
  );
  assert.equal(first.output.sha256, second.output.sha256);
  assert.deepEqual(first.counts, second.counts);
});

test("clips base terrain only inside an explicit contained structure footprint", async () => {
  const fixture = createFixture();
  const policy = JSON.parse(readFileSync(fixture.paths["policy.json"], "utf8"));
  policy.ownership[0].terrainOcclusionBounds = {
    minX: 1,
    minZ: 0,
    maxX: 3,
    maxZ: 2
  };
  writeJson(fixture.paths["policy.json"], policy);

  const report = await composeRegionalHybrid(
    options(fixture, "terrain-occluded.obj")
  );
  const areas = projectedMaterialAreas(
    join(fixture.root, "terrain-occluded.obj")
  );
  assert.equal(areas.nav_terrain, 4);
  assert.equal(report.counts.baseTerrainOcclusionSelectedTriangles, 2);
  assert.equal(report.counts.baseTerrainOcclusionRemovedProjectedArea, 4);
  assert.equal(
    report.ownership[0].matchedInputTriangles
      .terrainOcclusionRemovedProjectedArea,
    4
  );
  assert.equal(
    report.rules.terrainOcclusionRequiresExplicitContainedEvidenceBounds,
    true
  );
});

test("supports multiple exact object replacements with overlapping evidence bounds", async () => {
  const fixture = createFixture();
  writeFileSync(
    fixture.paths["base.obj"],
    `${readFileSync(fixture.paths["base.obj"], "utf8")}\n` +
      [
        "o RoadCollision__instance_12",
        "usemtl nav_exclude",
        "v 3.2 0 0",
        "v 3.8 0 0",
        "v 3.2 0 1",
        "f -3 -2 -1",
        ""
      ].join("\n")
  );
  writeFileSync(
    fixture.paths["overlay.obj"],
    `${readFileSync(fixture.paths["overlay.obj"], "utf8")}\n` +
      [
        "o RoadRender__instance_13",
        "usemtl nav_road",
        "v 3.2 0 0",
        "v 3.8 0 0",
        "v 3.2 0 1",
        "f -3 -2 -1",
        ""
      ].join("\n")
  );
  const manifest = JSON.parse(
    readFileSync(fixture.paths["overlay-manifest.json"], "utf8")
  );
  manifest.worldObj.sha256 = sha256(fixture.paths["overlay.obj"]);
  writeJson(fixture.paths["overlay-manifest.json"], manifest);
  const policy = JSON.parse(readFileSync(fixture.paths["policy.json"], "utf8"));
  policy.ownership.push({
    id: "reviewed-road",
    owner: "render-semantic-object",
    bounds: { minX: 2.5, minZ: 0, maxX: 4, maxZ: 2 },
    objectReplacement: {
      baseObject: "RoadCollision__instance_12",
      overlayObject: "RoadRender__instance_13"
    },
    requiredMaterials: ["nav_road"]
  });
  writeJson(fixture.paths["policy.json"], policy);

  const report = await composeRegionalHybrid(
    options(fixture, "multi-object.obj")
  );
  assert.equal(report.ownership.length, 2);
  assert.equal(
    report.counts.baseObjectReplacedMaterialTriangles.nav_exclude,
    1
  );
  assert.equal(report.counts.overlayOutputMaterialTriangles.nav_road, 1);
});

test("fails closed on duplicate object mappings or missing required semantics", async () => {
  const duplicateMapping = createFixture();
  const policy = JSON.parse(
    readFileSync(duplicateMapping.paths["policy.json"], "utf8")
  );
  policy.ownership.push({
    id: "duplicate",
    owner: "render-semantic-object",
    bounds: { minX: 1, minZ: 0, maxX: 3, maxZ: 2 },
    objectReplacement: {
      baseObject: "PoliceCollision__instance_7",
      overlayObject: "PoliceRender__instance_11"
    },
    requiredMaterials: ["nav_floor_interior"]
  });
  writeJson(duplicateMapping.paths["policy.json"], policy);
  assert.throws(
    () => loadPolicy(duplicateMapping.paths["policy.json"]),
    /replaced more than once/
  );

  const missing = createFixture();
  const missingPolicy = JSON.parse(
    readFileSync(missing.paths["policy.json"], "utf8")
  );
  missingPolicy.ownership[0].requiredMaterials = ["nav_threshold"];
  writeJson(missing.paths["policy.json"], missingPolicy);
  await assert.rejects(
    composeRegionalHybrid(options(missing, "missing.obj")),
    /emitted no required nav_threshold/
  );
});

test("rejects terrain occlusion outside evidence or without a replacement structure surface", () => {
  const outside = createFixture();
  const outsidePolicy = JSON.parse(
    readFileSync(outside.paths["policy.json"], "utf8")
  );
  outsidePolicy.ownership[0].terrainOcclusionBounds = {
    minX: 0.5,
    minZ: 0,
    maxX: 3,
    maxZ: 2
  };
  writeJson(outside.paths["policy.json"], outsidePolicy);
  assert.throws(
    () => loadPolicy(outside.paths["policy.json"]),
    /terrain occlusion is outside/
  );

  const noSurface = createFixture();
  const noSurfacePolicy = JSON.parse(
    readFileSync(noSurface.paths["policy.json"], "utf8")
  );
  noSurfacePolicy.ownership[0].requiredMaterials = ["nav_road"];
  noSurfacePolicy.ownership[0].terrainOcclusionBounds = {
    minX: 1,
    minZ: 0,
    maxX: 3,
    maxZ: 2
  };
  writeJson(noSurface.paths["policy.json"], noSurfacePolicy);
  assert.throws(
    () => loadPolicy(noSurface.paths["policy.json"]),
    /cannot occlude terrain/
  );
});

test("requires one exact source object on each side of a contained replacement", async () => {
  const missing = createFixture();
  const missingPolicy = JSON.parse(
    readFileSync(missing.paths["policy.json"], "utf8")
  );
  missingPolicy.ownership[0].objectReplacement.baseObject = "not-present";
  writeJson(missing.paths["policy.json"], missingPolicy);
  await assert.rejects(
    composeRegionalHybrid(options(missing, "missing-object.obj")),
    /requires exactly one collision object not-present/
  );

  const duplicate = createFixture();
  writeFileSync(
    duplicate.paths["base.obj"],
    `${readFileSync(duplicate.paths["base.obj"], "utf8")}o PoliceCollision__instance_7\n`
  );
  await assert.rejects(
    composeRegionalHybrid(options(duplicate, "duplicate-object.obj")),
    /requires exactly one collision object PoliceCollision__instance_7/
  );

  const partial = createFixture();
  const partialPolicy = JSON.parse(
    readFileSync(partial.paths["policy.json"], "utf8")
  );
  partialPolicy.ownership[0].bounds.maxX = 2.5;
  writeJson(partial.paths["policy.json"], partialPolicy);
  await assert.rejects(
    composeRegionalHybrid(options(partial, "partial-object.obj")),
    /does not contain both complete selected replacement objects/
  );
});

test("fails closed when overlay evidence does not bind the render OBJ", async () => {
  const fixture = createFixture();
  const manifest = JSON.parse(
    readFileSync(fixture.paths["overlay-manifest.json"], "utf8")
  );
  manifest.worldObj.sha256 = "0".repeat(64);
  writeJson(fixture.paths["overlay-manifest.json"], manifest);
  await assert.rejects(
    composeRegionalHybrid(options(fixture, "bad-evidence.obj")),
    /does not match its OBJ/
  );
});

test("accepts a smaller overlapping render evidence region bound to complete actors", async () => {
  const fixture = createFixture();
  const manifest = JSON.parse(
    readFileSync(fixture.paths["overlay-manifest.json"], "utf8")
  );
  const lint = JSON.parse(
    readFileSync(fixture.paths["overlay-lint.json"], "utf8")
  );
  manifest.navBounds = { minX: 0.5, minZ: 0, maxX: 3.5, maxZ: 2 };
  lint.bounds = manifest.navBounds;
  writeJson(fixture.paths["overlay-manifest.json"], manifest);
  writeJson(fixture.paths["overlay-lint.json"], lint);
  const report = await composeRegionalHybrid(
    options(fixture, "smaller-evidence.obj")
  );
  assert.deepEqual(report.inputs.overlayObj.evidenceBounds, manifest.navBounds);
});

test("rectangle operations clip sloped geometry without inventing height", () => {
  const triangle = [
    [0, 0, 0],
    [4, 4, 0],
    [4, 4, 2]
  ];
  const bounds = { minX: 1, minZ: 0, maxX: 3, maxZ: 2 };
  const inside = intersectRectangle(triangle, bounds);
  const outside = subtractRectangle(triangle, bounds);
  assert.ok(inside.length >= 3);
  assert.ok(outside.length >= 1);
  for (const point of inside) assert.ok(Math.abs(point[0] - point[1]) < 1e-8);
});
