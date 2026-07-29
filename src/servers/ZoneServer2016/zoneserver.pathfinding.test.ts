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
      interpolatedPosition: { x: 11, y: 25.75, z: 12 }
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
