import assert from "node:assert";
import test from "node:test";
import { Items } from "../models/enums";
import { ProjectileEntity } from "./projectileentity";
import { ZoneServer2016 } from "../zoneserver";
import type { ItemDefinition } from "../../../types/zoneserver";

test("HE grenade explosion effect remains valid after projectile removal", () => {
  const calls: unknown[][] = [];
  const server = {
    charactersRenderDistance: 350,
    interactionDistance: 3,
    _modelsData: {},
    _throwableProjectiles: {},
    pushToGridCell() {},
    sendDataToAllWithSpawnedEntity(...args: unknown[]) {
      calls.push(args);
    },
    explosionManager: {
      queueExplosion() {
        calls.push(["queueExplosion"]);
      }
    },
    deleteEntity() {
      calls.push(["deleteEntity"]);
      return true;
    }
  } as unknown as ZoneServer2016;
  const projectile = new ProjectileEntity(
    "0x123",
    1,
    0,
    new Float32Array([10, 20, 30, 1]),
    new Float32Array([0, 0, 0, 1]),
    server,
    Items.GRENADE_HE,
    7,
    "0x456"
  );

  projectile.onTrigger(server);

  assert.equal(calls[0][1], projectile.characterId);
  assert.equal(calls[0][2], "Character.PlayWorldCompositeEffect");
  assert.equal((calls[0][3] as { characterId: string }).characterId, "");
  assert.deepEqual(calls.slice(1).map((call) => call[0]), [
    "queueExplosion",
    "deleteEntity"
  ]);
});

test("thrower does not receive a duplicate authoritative grenade", () => {
  const replicatedTo: unknown[] = [];
  const owner = {
    character: { characterId: "0x456" },
    spawnedEntities: new Set()
  };
  const observer = { spawnedEntities: new Set() };
  const server = {
    charactersRenderDistance: 350,
    interactionDistance: 3,
    _modelsData: {},
    _throwableProjectiles: {},
    generateGuid: () => "0x123",
    getTransientId: () => 0x1248,
    pushToGridCell() {},
    getClientsInRange: () => [owner, observer],
    addLightweightNpc(client: unknown) {
      replicatedTo.push(client);
    },
    deleteEntity() {
      return true;
    }
  } as unknown as ZoneServer2016;

  ZoneServer2016.prototype.createThrowableProjectile.call(
    server,
    owner as never,
    {
      packet: {
        position: new Float32Array([10, 20, 30, 1]),
        sessionProjectileCount: 3,
        projectileUniqueId: 7
      }
    },
    { ID: Items.GRENADE_HE } as ItemDefinition,
    true
  );

  assert.deepEqual(replicatedTo, [observer]);
  assert.equal(owner.spawnedEntities.size, 0);
  assert.equal(observer.spawnedEntities.size, 1);
  const projectile = Object.values(server._throwableProjectiles)[0];
  projectile.destroy(server);
});
