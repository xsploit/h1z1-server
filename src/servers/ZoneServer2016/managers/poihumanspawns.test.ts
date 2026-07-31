import assert from "node:assert";
import test from "node:test";
import {
  getPoiHumanSpawnSlots,
  POI_HUMAN_SPAWN_PROFILES
} from "./poihumanspawns";

test("POI human profiles create stable unique slots", () => {
  const slots = getPoiHumanSpawnSlots();

  assert.equal(slots.length, 18);
  assert.equal(new Set(slots.map(({ spawnerId }) => spawnerId)).size, 18);
  assert.equal(slots.filter(({ id }) => id === "military").length, 5);
  assert.equal(slots.filter(({ id }) => id === "hospital").length, 3);
  assert.equal(slots.filter(({ id }) => id.startsWith("police-")).length, 10);
  assert.ok(slots.every(({ disposition }) => disposition === "survivor"));
});

test("POI profiles remain bounded to their extracted map anchors", () => {
  assert.deepEqual(POI_HUMAN_SPAWN_PROFILES[0].position, [
    844,
    16.1,
    -2659,
    1
  ]);
  assert.deepEqual(POI_HUMAN_SPAWN_PROFILES[1].position, [
    1814.4,
    99.1,
    -2788.4,
    1
  ]);
  assert.ok(
    POI_HUMAN_SPAWN_PROFILES.every(
      ({ count, patrolRadius }) => count <= 5 && patrolRadius <= 100
    )
  );
});
