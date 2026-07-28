import assert from "node:assert";
import test from "node:test";
import { HUMAN_ENCOUNTERS } from "./humanencountermanager";

test("authored human encounters use proximity lifetimes and role-specific groups", () => {
  const military = HUMAN_ENCOUNTERS.filter(
    (encounter) => encounter.archetype === "military"
  );
  const police = HUMAN_ENCOUNTERS.filter(
    (encounter) => encounter.archetype === "police"
  );

  assert.equal(military.length, 1);
  assert.equal(military[0].count, 5);
  assert.equal(police.length, 4);
  assert.ok(police.every((encounter) => encounter.count === 2));
  assert.ok(
    HUMAN_ENCOUNTERS.every(
      (encounter) => encounter.activationRadius < encounter.despawnRadius
    )
  );
  assert.equal(
    new Set(HUMAN_ENCOUNTERS.map((encounter) => encounter.id)).size,
    HUMAN_ENCOUNTERS.length
  );
});
