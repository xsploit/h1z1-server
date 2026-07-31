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
  assert.equal(slots.filter(({ role }) => role === "military").length, 5);
  assert.equal(slots.filter(({ role }) => role === "medic").length, 3);
  assert.equal(slots.filter(({ role }) => role === "police").length, 10);
});

test("POI profiles use deterministic surface posts instead of wide random areas", () => {
  assert.deepEqual(POI_HUMAN_SPAWN_PROFILES[0].positions[0], [
    688.5,
    48.08,
    -2476,
    1
  ]);
  const militaryTeleport = [696.53, -2470.62];
  assert.ok(
    POI_HUMAN_SPAWN_PROFILES[0].positions
      .slice(0, 2)
      .every(
        ([x, _y, z]) =>
          Math.hypot(x - militaryTeleport[0], z - militaryTeleport[1]) < 12
      )
  );
  assert.deepEqual(POI_HUMAN_SPAWN_PROFILES[1].positions[0], [
    1895.92,
    93.69,
    -2747.17,
    1
  ]);
  assert.ok(
    POI_HUMAN_SPAWN_PROFILES.every(
      ({ positions, patrolRadius }) =>
        positions.length <= 5 && patrolRadius <= 80
    )
  );
  assert.ok(
    getPoiHumanSpawnSlots().every(({ position }) => position.length === 4)
  );
});
