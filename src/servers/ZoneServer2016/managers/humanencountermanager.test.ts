import assert from "node:assert";
import test from "node:test";
import {
  compileHumanEncounterSlots,
  HumanEncounterManager
} from "./humanencountermanager";

test("encounter profiles compile to stable spawner slots", () => {
  const slots = compileHumanEncounterSlots("community", [
    {
      id: "police",
      label: "Police",
      disposition: "survivor",
      role: "police",
      spawnerBaseId: 2_100_000,
      positions: [
        [1, 2, 3, 1],
        [4, 5, 6, 1]
      ]
    }
  ]);
  assert.deepEqual(
    slots.map(({ spawnerId }) => spawnerId),
    [2_100_000, 2_100_001]
  );
});

test("encounter profiles reject colliding spawner slots", () => {
  assert.throws(
    () =>
      compileHumanEncounterSlots("community", [
        {
          id: "one",
          label: "One",
          disposition: "survivor",
          role: "police",
          spawnerBaseId: 10,
          positions: [
            [1, 2, 3, 1],
            [4, 5, 6, 1]
          ]
        },
        {
          id: "two",
          label: "Two",
          disposition: "bandit",
          role: "bandit",
          spawnerBaseId: 11,
          positions: [[7, 8, 9, 1]]
        }
      ]),
    /duplicate encounter spawnerId/
  );
});

test("encounter sync is idempotent and rejects a different nav floor", () => {
  const spawnedNpcs: Record<number, string> = {};
  const npcs: Record<string, { isAlive: boolean }> = {};
  const positions: number[][] = [];
  const server = {
    _npcs: npcs,
    worldObjectManager: {
      spawnedNpcs,
      createNpc: (_server: unknown, ...args: unknown[]) => {
        const position = args[1] as Float32Array;
        const spawnerId = args[3] as number;
        const characterId = `human-${spawnerId}`;
        positions.push(Array.from(position));
        spawnedNpcs[spawnerId] = characterId;
        npcs[characterId] = { isAlive: true };
      }
    },
    navManager: {
      getClosestNavPointVec3: (position: Float32Array) => ({
        x: position[0] + 1,
        y: position[1] + 10,
        z: position[2] + 1
      })
    },
    deleteEntity: () => true
  };
  const manager = new HumanEncounterManager(server as never);
  manager.registerSource("community", [
    {
      id: "military",
      label: "Military",
      disposition: "survivor",
      role: "military",
      spawnerBaseId: 2_000_000,
      positions: [[10, 20, 30, 1]]
    }
  ]);

  assert.deepEqual(manager.sync("community"), {
    created: 1,
    existing: 0,
    pendingCorpses: 0,
    failed: 0
  });
  assert.deepEqual(positions[0], [10, 20, 30, 1]);
  assert.equal(manager.sync("community").existing, 1);
  assert.equal(manager.getStatus("community")[0].alive, 1);
});
