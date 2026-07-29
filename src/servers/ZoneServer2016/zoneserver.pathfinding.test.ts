import assert from "node:assert";
import test from "node:test";
import { ZoneServer2016 } from "./zoneserver";

test("NPC replication preserves the Recast interior floor", () => {
  let replicatedPosition: Float32Array | undefined;
  const npc = {
    state: {
      position: new Float32Array([10, 4, 10, 1])
    },
    navAgent: {
      interpolatedPosition: { x: 11, y: 25, z: 12 }
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
      streaming: false
    },
    _npcs: { npc },
    _characters: {},
    _vehicles: {},
    getGroundInfo() {
      assert.fail("Recast movement must not be re-grounded");
    }
  };

  ZoneServer2016.prototype.updatePathfindingPositions.call(server);

  assert.ok(replicatedPosition);
  assert.deepEqual(Array.from(replicatedPosition), [11, 25, 12, 0]);
});
