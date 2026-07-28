import assert from "node:assert";
import test from "node:test";
import { Npc } from "./npc";

function makeMeleeFixture(
  targetPosition: Float32Array,
  mountedVehicle = "",
  vehicleExists = true
) {
  let characterHits = 0;
  let vehicleHits = 0;
  const character = {
    characterId: "player",
    isAlive: true,
    isRespawning: false,
    state: { position: targetPosition },
    isGodMode: () => false,
    getHealth: () => 100,
    OnMeleeHit: () => {
      characterHits++;
    }
  };
  const server = {
    getClientByCharId: () => ({
      isLoading: false,
      character,
      vehicle: { mountedVehicle }
    }),
    _vehicles:
      mountedVehicle && vehicleExists
        ? {
            [mountedVehicle]: {
              OnMeleeHit: () => {
                vehicleHits++;
              }
            }
          }
        : {},
    collisionManager: { segmentBlocked: () => false }
  };
  const npc = {
    server,
    characterId: "zombie",
    state: {
      position: new Float32Array([0, 0, 0, 1]),
      yaw: 0
    },
    npcMeleeDamage: 2500,
    npcMeleeWeapon: 0,
    npcMeleeTrace: {
      reach: 1.65,
      halfArcDegrees: 65,
      verticalTolerance: 1.5
    },
    infectsTargetOnMelee: false
  };
  return {
    apply: () => Npc.prototype.applyDamage.call(npc as never, "player"),
    get characterHits() {
      return characterHits;
    },
    get vehicleHits() {
      return vehicleHits;
    }
  };
}

test("NPC melee misses a target outside the impact arc", () => {
  const fixture = makeMeleeFixture(new Float32Array([0, 0, -1, 1]));
  fixture.apply();
  assert.equal(fixture.characterHits, 0);
});

test("NPC melee hits a target inside the impact arc", () => {
  const fixture = makeMeleeFixture(new Float32Array([0, 0, 1, 1]));
  fixture.apply();
  assert.equal(fixture.characterHits, 1);
});

test("NPC melee hits the mounted vehicle instead of its occupant", () => {
  const fixture = makeMeleeFixture(new Float32Array([0, 0, 1, 1]), "vehicle");
  fixture.apply();
  assert.equal(fixture.vehicleHits, 1);
  assert.equal(fixture.characterHits, 0);
});

test("stale mounted vehicle state never spills melee damage onto occupant", () => {
  const fixture = makeMeleeFixture(
    new Float32Array([0, 0, 1, 1]),
    "missing",
    false
  );
  fixture.apply();
  assert.equal(fixture.vehicleHits, 0);
  assert.equal(fixture.characterHits, 0);
});
