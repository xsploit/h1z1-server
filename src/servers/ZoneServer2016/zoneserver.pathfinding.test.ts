import assert from "node:assert";
import test from "node:test";
import { ZoneServer2016 } from "./zoneserver";

test("all crowd-agent references are invalidated before streamed tiles change", () => {
  const staleAgent = {
    interpolatedPosition: { x: 10, y: 10, z: 10 }
  };
  const npc = {
    state: {
      position: new Float32Array([10, 10, 10, 1])
    },
    navAgent: staleAgent,
    goTo() {
      assert.fail("an unloaded NPC must not replicate stale crowd movement");
    },
    syncIdleIfStopped() {
      assert.fail("an unloaded NPC must not synchronize a stale agent");
    }
  };
  const character = { state: npc.state, navAgent: staleAgent };
  const vehicle = { state: npc.state, navAgent: staleAgent };
  let invalidatedBeforeMutation = false;
  const server = {
    navManager: {
      streaming: true,
      crowdHealthy: true,
      streamAround(
        _positions: Float32Array[],
        beforeMutation: (() => void) | undefined
      ) {
        beforeMutation?.();
        invalidatedBeforeMutation =
          npc.navAgent === undefined &&
          character.navAgent === undefined &&
          vehicle.navAgent === undefined;
      },
      isPositionStreamed: () => false,
      createAgent: () => undefined
    },
    _npcs: { npc },
    _characters: { character },
    _vehicles: { vehicle },
    clearPathfindingAgentReferences: (
      ZoneServer2016.prototype as unknown as {
        clearPathfindingAgentReferences(): void;
      }
    ).clearPathfindingAgentReferences
  };

  ZoneServer2016.prototype.updatePathfindingPositions.call(server);

  assert.equal(invalidatedBeforeMutation, true);
  assert.equal(npc.navAgent, undefined);
  assert.equal(character.navAgent, undefined);
  assert.equal(vehicle.navAgent, undefined);
});

test("NPC grounding preserves the previous replicated vertical layer", () => {
  let replicatedPosition: Float32Array | undefined;
  const npc = {
    state: {
      position: new Float32Array([10, 25, 10, 1])
    },
    navAgent: {
      interpolatedPosition: { x: 10.01, y: 25, z: 10.01 },
      position: () => ({ x: 11, y: 25.75, z: 12 })
    },
    goTo(position: Float32Array) {
      replicatedPosition = position;
    },
    syncIdleIfStopped() {
      assert.fail("moving NPC was incorrectly synchronized as idle");
    }
  };
  const server = {
    navManager: {
      streaming: false,
      crowdHealthy: true,
      isPositionStreamed: () => true
    },
    collisionManager: {
      movementBlocked: () => false
    },
    _npcs: { npc },
    _characters: {},
    _vehicles: {},
    getGroundInfo(_position: Float32Array, navY: number, currentY: number) {
      assert.equal(navY, 25.75);
      assert.equal(currentY, 25);
      return {
        selection: {
          height: 25.75,
          source: "navmesh"
        }
      };
    }
  };

  ZoneServer2016.prototype.updatePathfindingPositions.call(server);

  assert.ok(replicatedPosition);
  assert.deepEqual(Array.from(replicatedPosition), [11, 25.75, 12, 0]);
});

test("NPC movement collision keeps the last safe position and resets Detour", () => {
  const previousToggle = process.env.NPC_MOVEMENT_COLLISION;
  delete process.env.NPC_MOVEMENT_COLLISION;
  try {
    let replicated = false;
    let reset = false;
    let synchronizedIdle = false;
    let teleportedTo: Float32Array | undefined;
    const agent = {
      position: () => ({ x: 10, y: 25, z: 10.2 }),
      resetMoveTarget() {
        reset = true;
      }
    };
    const npc = {
      characterId: "blocked-npc",
      state: {
        position: new Float32Array([10, 25, 10, 1])
      },
      navAgent: agent,
      goTo() {
        replicated = true;
      },
      syncIdleIfStopped() {
        synchronizedIdle = true;
      }
    };
    const server = {
      navManager: {
        streaming: false,
        crowdHealthy: true,
        isPositionStreamed: () => true,
        teleportAgent(_agent: unknown, position: Float32Array) {
          teleportedTo = new Float32Array(position);
          return true;
        }
      },
      collisionManager: {
        movementBlocked(from: Float32Array, to: Float32Array) {
          assert.deepEqual(Array.from(from), [10, 25, 10, 1]);
          assert.equal(to[0], 10);
          assert.equal(to[1], 25);
          assert.ok(Math.abs(to[2] - 10.2) < 0.0001);
          assert.equal(to[3], 0);
          return true;
        }
      },
      _npcs: { npc },
      _characters: {},
      _vehicles: {},
      getGroundInfo() {
        return { selection: { height: 25, source: "navmesh" } };
      }
    };

    ZoneServer2016.prototype.updatePathfindingPositions.call(server);

    assert.equal(replicated, false);
    assert.equal(reset, true);
    assert.equal(synchronizedIdle, true);
    assert.deepEqual(Array.from(teleportedTo!), [10, 25, 10, 1]);
    assert.deepEqual(Array.from(npc.state.position), [10, 25, 10, 1]);
  } finally {
    if (previousToggle === undefined) delete process.env.NPC_MOVEMENT_COLLISION;
    else process.env.NPC_MOVEMENT_COLLISION = previousToggle;
  }
});

test("player and vehicle movement never enters the native NPC crowd", () => {
  const staleAgent = {};
  const character = { navAgent: staleAgent };
  const vehicle = { navAgent: staleAgent };
  const server = {
    navManager: {
      streaming: false,
      crowdHealthy: true,
      createPassiveAgent: () =>
        assert.fail("players must not be added to dtCrowd"),
      teleportAgent: () =>
        assert.fail("player movement must not hard-teleport dtCrowd agents")
    },
    _npcs: {},
    _characters: { character },
    _vehicles: { vehicle }
  };

  ZoneServer2016.prototype.updatePathfindingPositions.call(server);

  assert.equal(character.navAgent, undefined);
  assert.equal(vehicle.navAgent, undefined);
});
