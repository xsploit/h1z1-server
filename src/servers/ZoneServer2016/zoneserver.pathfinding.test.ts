import assert from "node:assert";
import test from "node:test";
import { ZoneServer2016 } from "./zoneserver";

test("NPC crowd agents are retired when their streamed tile unloads", () => {
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
  let removedAgent: unknown;
  const server = {
    navManager: {
      streaming: true,
      streamAround() {},
      isPositionStreamed: () => false,
      removeAgent(agent: unknown) {
        removedAgent = agent;
      },
      createAgent: () => undefined
    },
    _npcs: { npc },
    _characters: {},
    _vehicles: {}
  };

  ZoneServer2016.prototype.updatePathfindingPositions.call(server);

  assert.equal(removedAgent, staleAgent);
  assert.equal(npc.navAgent, undefined);
});
