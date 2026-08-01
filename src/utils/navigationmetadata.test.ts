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

test("validates extractor navigation metadata", () => {
  const parsed = parseNavigationMetadata(validMetadata);
  assert.equal(parsed.instances.length, 1);
  assert.equal(parsed.instances[0].instanceId, 42);
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

test("dynamic doors follow the sidecar marker and explicit override", () => {
  const parsed = parseNavigationMetadata(validMetadata);
  assert.equal(shouldEnableDynamicDoorObstacles(parsed, undefined), true);
  assert.equal(shouldEnableDynamicDoorObstacles(parsed, "0"), false);
  assert.equal(shouldEnableDynamicDoorObstacles(null, "1"), true);
  assert.equal(shouldEnableDynamicDoorObstacles(null, undefined), false);
});
