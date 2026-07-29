import test from "node:test";
import assert from "node:assert";
import { buildNpcSpawnCandidates, getNpcModelsForRoll } from "./npcspawn";
import { ModelIds } from "../models/enums";

test("screamer rolls only affect zombie spawners", () => {
  assert.deepEqual(
    getNpcModelsForRoll("NPCSpawner_Deer001.adr", 1000, 1),
    [9002, 9253]
  );
  assert.deepEqual(
    getNpcModelsForRoll("NPCSpawner_ZombieWalker.adr", 1000, 1),
    [
      ModelIds.ZOMBIE_FEMALE_WALKER,
      ModelIds.ZOMBIE_MALE_WALKER,
      ModelIds.ZOMBIE_SCREAMER
    ]
  );
});

test("capped spawn candidates preserve every NPC category", () => {
  const instance = (id: number, count: number) => ({
    id,
    position: [id, 0, id, 1],
    rotation: [0, 0, 0, 1],
    count
  });
  const candidates = buildNpcSpawnCandidates([
    {
      actorDefinition: "NPCSpawner_ZombieWalker.adr",
      instances: [instance(1, 100)]
    },
    {
      actorDefinition: "NPCSpawner_Deer001.adr",
      instances: [instance(2, 10)]
    },
    {
      actorDefinition: "NPCSpawner_Wolf001.adr",
      instances: [instance(3, 5)]
    },
    {
      actorDefinition: "Bear_Brown.adr",
      instances: [instance(4, 2)]
    }
  ]);
  const firstTen = new Set(
    candidates.slice(0, 10).map((candidate) => candidate.actorDefinition)
  );

  assert.equal(candidates.length, 117);
  assert.equal(firstTen.has("NPCSpawner_ZombieWalker.adr"), true);
  assert.equal(firstTen.has("NPCSpawner_Deer001.adr"), true);
  assert.equal(firstTen.has("NPCSpawner_Wolf001.adr"), true);
  assert.equal(firstTen.has("Bear_Brown.adr"), true);
});
