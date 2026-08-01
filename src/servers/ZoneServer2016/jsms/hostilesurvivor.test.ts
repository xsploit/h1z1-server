import assert from "node:assert";
import test from "node:test";
import { Factions, isHostile } from "./factions";
import { createZombie } from "./zombie.jsm";
import { isMeleeTargetInArc } from "../entities/npc";
import {
  getBanditHitChance,
  getHumanNpcRoleConfig,
  selectHumanNpcWeaponKit,
  selectBanditWeaponKit
} from "../entities/hostilesurvivor";
import { Items } from "../models/enums";

test("bandits fight players and hostile creatures", () => {
  assert.equal(isHostile(Factions.BANDIT, Factions.HUMAN), true);
  assert.equal(isHostile(Factions.BANDIT, Factions.ZOMBIE), true);
  assert.equal(isHostile(Factions.ZOMBIE, Factions.BANDIT), true);
});

test("survivors ally with players and fight bandits and zombies", () => {
  assert.equal(isHostile(Factions.SURVIVOR, Factions.HUMAN), false);
  assert.equal(isHostile(Factions.HUMAN, Factions.SURVIVOR), false);
  assert.equal(isHostile(Factions.SURVIVOR, Factions.BANDIT), true);
  assert.equal(isHostile(Factions.SURVIVOR, Factions.ZOMBIE), true);
  assert.equal(isHostile(Factions.BANDIT, Factions.SURVIVOR), true);
  assert.equal(isHostile(Factions.ZOMBIE, Factions.SURVIVOR), true);
});

test("bandit firearm kits are weighted and deterministic at boundaries", () => {
  assert.equal(selectBanditWeaponKit(0).itemDefinitionId, Items.WEAPON_R380);
  assert.equal(
    selectBanditWeaponKit(0.349).itemDefinitionId,
    Items.WEAPON_R380
  );
  assert.equal(selectBanditWeaponKit(0.35).itemDefinitionId, Items.WEAPON_M9);
  assert.equal(selectBanditWeaponKit(0.799).itemDefinitionId, Items.WEAPON_M9);
  assert.equal(selectBanditWeaponKit(0.8).itemDefinitionId, Items.WEAPON_AR15);
});

test("POI human roles receive distinct durable combat identities", () => {
  const military = getHumanNpcRoleConfig("military");
  const police = getHumanNpcRoleConfig("police");
  const medic = getHumanNpcRoleConfig("medic");

  assert.equal(military.health, 25000);
  assert.equal(police.health, 17500);
  assert.equal(medic.health, 15000);
  assert.ok(military.health > police.health);
  assert.ok(police.health > medic.health);
  assert.equal(
    selectHumanNpcWeaponKit("military", 0).itemDefinitionId,
    Items.WEAPON_AR15
  );
  assert.equal(
    selectHumanNpcWeaponKit("police", 0).itemDefinitionId,
    Items.WEAPON_M9
  );
  assert.equal(
    selectHumanNpcWeaponKit("medic", 0).itemDefinitionId,
    Items.WEAPON_R380
  );
});

test("bandit accuracy falls with range and remains bounded", () => {
  assert.equal(getBanditHitChance(0), 0.72);
  assert.ok(getBanditHitChance(10) > getBanditHitChance(30));
  assert.equal(getBanditHitChance(100), 0.18);
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
      findRandomNavPointAround: () => new Float32Array([0, 0, 0, 0]),
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

test("human raiders choose the nearest hostile and retain long-range targets", () => {
  const farPosition = new Float32Array([0, 0, 60, 1]);
  const nearPosition = new Float32Array([0, 0, 55, 1]);
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
  const farZombie = {
    characterId: "far-zombie",
    faction: Factions.ZOMBIE,
    state: { position: farPosition },
    isAlive: true
  };
  const nearZombie = {
    characterId: "near-zombie",
    faction: Factions.ZOMBIE,
    state: { position: nearPosition },
    isAlive: true
  };
  const server = {
    navManager: {
      findRandomNavPointAround: () => new Float32Array([0, 0, 0, 0]),
      getClosestNavPointVec3: (target: Float32Array) => target
    },
    aiTargetSpatialMap: new Map([
      [
        "0,1",
        [
          { id: "far-zombie", position: farPosition, faction: Factions.ZOMBIE },
          {
            id: "near-zombie",
            position: nearPosition,
            faction: Factions.ZOMBIE
          }
        ]
      ]
    ]),
    sounds: [],
    _characters: {},
    _npcs: {
      bandit: npc,
      "far-zombie": farZombie,
      "near-zombie": nearZombie
    }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    detectionRange: 70,
    attackRange: 30
  });
  raider.tick(0.1);
  assert.equal(raider.targetCharacterId, "near-zombie");
  assert.equal(raider.state, "chase");

  raider.tick(0.1);
  assert.equal(raider.targetCharacterId, "near-zombie");
  assert.equal(raider.state, "chase");
});

test("human raiders abandon a target when navigation makes no progress", () => {
  const zombiePosition = new Float32Array([0, 0, 10, 1]);
  const npc = {
    characterId: "survivor",
    transientId: 10,
    faction: Factions.SURVIVOR,
    state: { position: new Float32Array([0, 0, 0, 1]) },
    navAgent: { requestMoveTarget: () => undefined },
    lookAtTarget: null,
    setSpeed: () => undefined,
    stopMovement: () => undefined,
    setAnimation: () => undefined,
    playAnimation: () => undefined,
    lookAt: () => undefined
  };
  const target = {
    characterId: "zombie",
    faction: Factions.ZOMBIE,
    state: { position: zombiePosition },
    isAlive: true
  };
  const server = {
    navManager: {
      findRandomNavPointAround: () => new Float32Array([1, 0, 0, 1]),
      getClosestNavPointVec3: (position: Float32Array) => position
    },
    aiTargetSpatialMap: new Map([
      [
        "0,0",
        [{ id: "zombie", position: zombiePosition, faction: Factions.ZOMBIE }]
      ]
    ]),
    sounds: [],
    _characters: {},
    _npcs: { survivor: npc, zombie: target }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    detectionRange: 30,
    attackRange: 20,
    canAttackTarget: () => false,
    stalledTargetTimeoutSeconds: 2,
    targetReacquireDelaySeconds: 3
  });

  raider.tick(0.1);
  assert.equal(raider.state, "chase");
  raider.tick(1.1);
  raider.tick(1.1);

  assert.equal(raider.state, "wander");
  assert.equal(raider.targetCharacterId, null);
  assert.equal(raider.ignoredTargetCharacterId, "zombie");
  raider.tick(0.1);
  assert.equal(raider.state, "wander");
  assert.equal(raider.targetCharacterId, null);
});

test("human raiders keep chasing while their navigation agent makes progress", () => {
  const zombiePosition = new Float32Array([0, 0, 20, 1]);
  const npcPosition = new Float32Array([0, 0, 0, 1]);
  const npc = {
    characterId: "survivor",
    transientId: 10,
    faction: Factions.SURVIVOR,
    state: { position: npcPosition },
    navAgent: { requestMoveTarget: () => undefined },
    lookAtTarget: null,
    setSpeed: () => undefined,
    stopMovement: () => undefined,
    setAnimation: () => undefined,
    playAnimation: () => undefined,
    lookAt: () => undefined
  };
  const target = {
    characterId: "zombie",
    faction: Factions.ZOMBIE,
    state: { position: zombiePosition },
    isAlive: true
  };
  const server = {
    navManager: {
      findRandomNavPointAround: () => new Float32Array([0, 0, 0, 1]),
      getClosestNavPointVec3: (position: Float32Array) => position
    },
    aiTargetSpatialMap: new Map([
      [
        "0,0",
        [{ id: "zombie", position: zombiePosition, faction: Factions.ZOMBIE }]
      ]
    ]),
    sounds: [],
    _characters: {},
    _npcs: { survivor: npc, zombie: target }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    detectionRange: 30,
    attackRange: 5,
    stalledTargetTimeoutSeconds: 2,
    targetReacquireDelaySeconds: 3
  });

  raider.tick(0.1);
  raider.tick(1.1);
  npc.state.position[0] = 2;
  raider.tick(1.1);
  raider.tick(1.1);

  assert.equal(raider.state, "chase");
  assert.equal(raider.targetCharacterId, "zombie");
});

test("human patrol mode rests briefly and then resumes roaming", () => {
  const patrolRequests: Float32Array[] = [];
  const npc = {
    characterId: "bandit",
    transientId: 10,
    faction: Factions.BANDIT,
    state: { position: new Float32Array([10, 0, 10, 1]) },
    navAgent: {
      requestMoveTarget: (target: Float32Array) => patrolRequests.push(target)
    },
    lookAtTarget: null,
    setSpeed: () => undefined,
    stopMovement: () => undefined,
    setAnimation: () => undefined,
    playAnimation: () => undefined,
    lookAt: () => undefined
  };
  const server = {
    navManager: {
      findRandomNavPointAround: (_origin: Float32Array, radius: number) =>
        new Float32Array([radius, 0, radius, 1]),
      getClosestNavPointVec3: (target: Float32Array) => target
    },
    aiTargetSpatialMap: new Map(),
    sounds: [],
    _characters: {},
    _npcs: { bandit: npc }
  };

  const raider = createZombie(npc as never, server as never, {
    canFeed: false,
    fixedPatrolOrigin: true,
    patrolWakeSeconds: 1,
    patrolRadius: 100
  });
  raider.tick(51);

  assert.equal(raider.state, "idle");
  raider.tick(1.1);
  assert.equal(raider.state, "wander");
  assert.equal(raider.agitation, 50);
  assert.deepEqual(Array.from(raider.wanderOrigin), [10, 0, 10, 1]);
  assert.ok(patrolRequests.length >= 2);
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
      findRandomNavPointAround: () => new Float32Array([0, 0, 0, 0]),
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

test("ranged raider waits, checks line of sight, and uses its attack callback", () => {
  const playerPosition = new Float32Array([0, 0, 10, 1]);
  let fireCalls = 0;
  let lineOfSight = false;
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
    playAnimation: () => assert.fail("ranged attacks use weapon packets"),
    lookAt: () => undefined
  };
  const server = {
    navManager: {
      findRandomNavPointAround: () => new Float32Array([0, 0, 0, 0]),
      getClosestNavPointVec3: () => ({ x: 0, y: 0, z: 10 })
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
    detectionRange: 55,
    attackRange: 30,
    attackImpactSeconds: 0.1,
    attackRecoverySeconds: 0.2,
    attackCooldownSeconds: 0.5,
    attackImmediatelyOnReach: false,
    attackImmediatelyAfterRecovery: false,
    playAttackAnimation: false,
    canAttackTarget: () => lineOfSight,
    performAttack: () => {
      fireCalls++;
    }
  });

  raider.tick(0.1);
  raider.tick(0.1);
  assert.equal(raider.state, "chase");
  assert.equal(fireCalls, 0);

  lineOfSight = true;
  raider.tick(0.1);
  assert.equal(raider.state, "attack");
  raider.tick(0.49);
  assert.equal(fireCalls, 0);
  raider.tick(0.02);
  assert.equal(raider.state, "attacking");
  raider.tick(0.11);
  assert.equal(fireCalls, 1);
});
