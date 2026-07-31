// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2020 - 2021 Quentin Gruber
//   copyright (C) 2021 - 2026 H1emu community
//
//   https://github.com/QuentinGruber/h1z1-server
//   https://www.npmjs.com/package/h1z1-server
//
//   Based on https://github.com/psemu/soe-network
// ======================================================================

import test, { after } from "node:test";
import assert from "node:assert";
import { LootTableManager } from "./loottablemanager";
import {
  getHostileSurvivorChancePerThousand,
  HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND,
  WorldObjectManager
} from "./worldobjectmanager";

test("solo mode favors bandits without changing multiplayer defaults", () => {
  const previousChance = process.env.HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND;
  delete process.env.HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND;
  try {
    assert.equal(
      getHostileSurvivorChancePerThousand(true),
      HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND.solo
    );
    assert.equal(
      getHostileSurvivorChancePerThousand(false),
      HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND.multiplayer
    );
    assert.equal(HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND.solo, 200);
  } finally {
    if (previousChance === undefined) {
      delete process.env.HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND;
    } else {
      process.env.HOSTILE_SURVIVOR_CHANCE_PER_THOUSAND = previousChance;
    }
  }
});

test("lootbag registration indexes and spawns a corpse bag", () => {
  const manager = new WorldObjectManager();
  const lootbag = { characterId: "lootbag" };
  const spawnedEntities = new Set<object>();
  let indexed: object | undefined;
  let spawned: object | undefined;
  const server = {
    _lootbags: {} as Record<string, object>,
    pushToGridCell: (entity: object) => {
      indexed = entity;
    },
    executeFuncForAllReadyClientsInRange: (
      callback: (client: { spawnedEntities: Set<object> }) => void
    ) => callback({ spawnedEntities }),
    addLightweightNpc: (_client: object, entity: object) => {
      spawned = entity;
    }
  };

  manager.registerLootbag(server as never, lootbag as never);

  assert.equal(server._lootbags.lootbag, lootbag);
  assert.equal(indexed, lootbag);
  assert.equal(spawned, lootbag);
  assert.equal(spawnedEntities.has(lootbag), true);
});

test("NPC registration adds world spawns to the client visibility grid", () => {
  const manager = new WorldObjectManager();
  const npc = { characterId: "world-npc" };
  let indexed: object | undefined;
  const server = {
    _npcs: {} as Record<string, object>,
    pushToGridCell: (entity: object) => {
      indexed = entity;
    }
  };

  manager.registerNpc(server as never, npc as never, 42);

  assert.equal(server._npcs["world-npc"], npc);
  assert.equal(manager.spawnedNpcs[42], "world-npc");
  assert.equal(indexed, npc);
});

test("WorldObjectManager", { timeout: 10000 }, async (t) => {
  await t.test("containerLootSpawners", () => {
    const manager = new LootTableManager();
    manager.load();
    const containerTables = manager.getContainerTables();
    for (const key in containerTables) {
      const containerLootTable = containerTables[key];
      for (const pool of containerLootTable.pools) {
        if (!pool.rolls) continue;
        assert(
          pool.rolls.max <= pool.entries.length,
          `${key} pool rolls.max (${pool.rolls.max}) exceeds entry count (${pool.entries.length})`
        );
      }
    }
  });
});

after(() => {
  setImmediate(() => {
    process.exit(0);
  });
});
