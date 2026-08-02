import assert from "node:assert";
import test from "node:test";
import {
  parseNavigationMetadata,
  shouldEnableDynamicDoorObstacles
} from "./navigationmetadata";

const validMetadata = {
  version: 1,
  coordinateSpace: "h1z1-world-y-up-meters",
  bakedDoorGeometryExcluded: true,
  instances: [
    {
      actorDefinition: "Common_Props_Doors_ResidentialFront01",
      kind: "door",
      instanceId: 42,
      position: [1, 2, 3, 1],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1, 1]
    }
  ]
};

const validSemanticMetadata = {
  version: 2,
  semanticSchemaVersion: 1,
  semanticMode: "strict",
  canonicalMaterials: [
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
  ],
  coordinateSpace: "h1z1-world-y-up-meters",
  bakedDoorGeometryExcluded: true,
  instances: [
    {
      actorDefinition: "Common_Props_Doors_ResidentialFront01",
      kind: "door",
      objectName: "Common_Props_Doors_ResidentialFront01__instance_42",
      semantic: "nav_door_panel_dynamic",
      classificationSource: "rule:Common_Props_Doors_*",
      geometrySource: "render_dme_fallback",
      geometryAsset: "ResidentialFront01_LOD0.dme",
      instanceId: 42,
      position: [1, 2, 3, 1],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1, 1]
    }
  ]
};

test("validates extractor navigation metadata", () => {
  const parsed = parseNavigationMetadata(validMetadata);
  assert.equal(parsed.instances.length, 1);
  assert.equal(parsed.instances[0].instanceId, 42);
});

test("validates strict semantic extractor metadata", () => {
  const parsed = parseNavigationMetadata(validSemanticMetadata);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.semanticMode, "strict");
  assert.equal(parsed.instances[0].semantic, "nav_door_panel_dynamic");
});

test("rejects incomplete semantic provenance", () => {
  const invalid = structuredClone(validSemanticMetadata);
  delete (invalid.instances[0] as Partial<(typeof invalid.instances)[0]>)
    .geometrySource;
  assert.throws(
    () => parseNavigationMetadata(invalid),
    /invalid semantic provenance/
  );
});

test("rejects duplicate navigation metadata instances", () => {
  assert.throws(
    () =>
      parseNavigationMetadata({
        ...validMetadata,
        instances: [validMetadata.instances[0], validMetadata.instances[0]]
      }),
    /duplicate navigation metadata instance/
  );
});

test("dynamic doors require both a compatible sidecar and explicit opt-in", () => {
  const parsed = parseNavigationMetadata(validMetadata);
  assert.equal(shouldEnableDynamicDoorObstacles(parsed, undefined), false);
  assert.equal(shouldEnableDynamicDoorObstacles(parsed, "0"), false);
  assert.equal(shouldEnableDynamicDoorObstacles(parsed, "1"), true);
  assert.equal(shouldEnableDynamicDoorObstacles(null, "1"), false);
  assert.equal(shouldEnableDynamicDoorObstacles(null, undefined), false);
});
