import assert from "node:assert";
import test from "node:test";
import { Factions, isHostile } from "./factions";
import { createZombie } from "./zombie.jsm";
import { isMeleeTargetInArc } from "../entities/npc";

test("bandits fight players and hostile creatures", () => {
  assert.equal(isHostile(Factions.BANDIT, Factions.HUMAN), true);
  assert.equal(isHostile(Factions.BANDIT, Factions.ZOMBIE), true);
  assert.equal(isHostile(Factions.ZOMBIE, Factions.BANDIT), true);
});

test("raider melee trace requires reach, facing, and vertical overlap", () => {
  const attacker = new Float32Array([0, 0, 0, 1]);
  const trace = {
    reach: 1.35,
    halfArcDegrees: 55,
    verticalTolerance: 1.25
  };
  assert.equal(
    isMeleeTargetInArc(attacker, 0, new Float32Array([0.3, 0, 1.1, 1]), trace),
    true
  );
  assert.equal(
    isMeleeTargetInArc(attacker, 0, new Float32Array([0, 0, -1, 1]), trace),
    false
  );
  assert.equal(
    isMeleeTargetInArc(attacker, 0, new Float32Array([0, 0, 1.5, 1]), trace),
    false
  );
  assert.equal(
    isMeleeTargetInArc(attacker, 0, new Float32Array([0, 1.5, 1, 1]), trace),
    false
  );
});

test("human raider reuses zombie acquisition and chase behavior", () => {
  const playerPosition = new Float32Array([0, 0, 15, 1]);
  const npc = {
    characterId: "bandit",
    transientId: 10,
    faction: Factions.BANDIT,
    state: { position: new Float32Array([0, 0, 0, 1]) },
    navAgent: { requestMoveTarget: () => undefined },
    lookAtTarget: null,
    setSpeed: () => undefined,
    stopMovement: () => undefined,
    setAnimation: () => undefined,
    playAnimation: () => undefined,
    lookAt: () => undefined
  };
  const server = {
    navManager: {
      navMeshQuery: {
        findRandomPointAroundCircle: () => ({
          success: true,
          randomPoint: { x: 0, y: 0, z: 0 }
        })
      },
      getClosestNavPointVec3: () => ({ x: 0, y: 0, z: 0 })
    },
    aiTargetSpatialMap: new Map([
      [
        "0,0",
        [
          {
            id: "player",
            position: playerPosition,
            faction: Factions.HUMAN
          }
        ]
      ]
    ]),
    sounds: [],
    _characters: {
      player: {
        characterId: "player",
        state: { position: playerPosition },
        isAlive: true,
        isHidden: false,
        isVanished: false
      }
    },
    _npcs: { bandit: npc }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    detectionRange: 20,
    attackRange: 1.35,
    attackAnimation: "OneHandForehandSlashRight",
    attackImpactSeconds: 0.45,
    attackRecoverySeconds: 0.9
  });
  raider.tick(0.1);

  assert.equal(raider.state, "chase");
  assert.equal(raider.targetCharacterId, "player");
  assert.equal(raider.canFeed, false);
  assert.equal(raider.attackRange, 1.35);
  assert.equal(raider.attackAnimation, "OneHandForehandSlashRight");
  assert.equal(raider.attackImpactSeconds, 0.45);
  assert.equal(raider.attackRecoverySeconds, 0.9);
});

test("raider melee lands once at the configured animation impact", () => {
  const playerPosition = new Float32Array([0, 0, 1, 1]);
  let damageCalls = 0;
  let stopCalls = 0;
  const animations: string[] = [];
  const npc = {
    characterId: "bandit",
    transientId: 10,
    faction: Factions.BANDIT,
    state: { position: new Float32Array([0, 0, 0, 1]) },
    navAgent: { requestMoveTarget: () => undefined },
    lookAtTarget: null,
    setSpeed: () => undefined,
    stopMovement: () => {
      stopCalls++;
    },
    setAnimation: () => undefined,
    playAnimation: (animation: string) => {
      animations.push(animation);
    },
    lookAt: () => undefined,
    applyDamage: () => {
      damageCalls++;
    }
  };
  const server = {
    navManager: {
      navMeshQuery: {
        findRandomPointAroundCircle: () => ({
          success: true,
          randomPoint: { x: 0, y: 0, z: 0 }
        })
      },
      getClosestNavPointVec3: () => ({ x: 0, y: 0, z: 1 })
    },
    aiTargetSpatialMap: new Map([
      [
        "0,0",
        [
          {
            id: "player",
            position: playerPosition,
            faction: Factions.HUMAN
          }
        ]
      ]
    ]),
    sounds: [],
    _characters: {
      player: {
        characterId: "player",
        state: { position: playerPosition },
        isAlive: true,
        isHidden: false,
        isVanished: false
      }
    },
    _npcs: { bandit: npc }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    detectionRange: 20,
    attackRange: 1.35,
    attackAnimation: "OneHandForehandSlashRight",
    attackImpactSeconds: 0.45,
    attackRecoverySeconds: 0.9
  });

  raider.tick(0.1);
  raider.tick(0.1);
  raider.tick(0.1);
  assert.equal(raider.state, "attacking");
  assert.equal(stopCalls, 1);
  assert.deepEqual(animations, ["OneHandForehandSlashRight"]);

  raider.tick(0.44);
  assert.equal(damageCalls, 0);
  raider.tick(0.02);
  assert.equal(damageCalls, 1);
  raider.tick(0.2);
  assert.equal(damageCalls, 1);
  raider.tick(0.3);
  assert.equal(damageCalls, 1);
  assert.equal(raider.state, "attack");
});
