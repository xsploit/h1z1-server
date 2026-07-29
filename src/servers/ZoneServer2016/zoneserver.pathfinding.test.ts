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
