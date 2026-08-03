import test, { after } from "node:test";
import { ZoneServer2016 } from "./zoneserver";
import { scheduler } from "node:timers/promises";
import {
  createFakeCharacter,
  createFakeZoneClient
} from "../../utils/test.utils";
import assert from "node:assert";

process.env.FORCE_DISABLE_WS = "true";

const isMongoTests = process.env.MONGO_TESTS === "true";
test("ZoneServer2016", { timeout: 60000 }, async (t) => {
  const zone = new ZoneServer2016(0);
  await t.test("start", async () => {
    await zone.start();
  });
  await t.test("save", async () => {
    await zone.saveWorld();
  });
  await t.test("AI target map excludes saved and loading characters", () => {
    const savedCharacter = createFakeCharacter(zone);
    const rebuildAiTargetMap = () =>
      (
        zone as unknown as {
          _rebuildAiTargetMap(): void;
        }
      )._rebuildAiTargetMap();

    rebuildAiTargetMap();
    assert.equal(
      [...zone.aiTargetSpatialMap.values()].flat().length,
      0,
      "Saved character without a live client became an AI target"
    );

    const client = createFakeZoneClient(zone, savedCharacter);
    client.isLoading = false;
    client.character.isReady = true;
    rebuildAiTargetMap();
    assert.equal(
      [...zone.aiTargetSpatialMap.values()]
        .flat()
        .some((target) => target.id === savedCharacter.characterId),
      true,
      "Ready client was not added as an AI target"
    );

    client.isLoading = true;
    rebuildAiTargetMap();
    assert.equal(
      [...zone.aiTargetSpatialMap.values()].flat().length,
      0,
      "Loading client remained an AI target"
    );

    delete zone._clients[client.sessionId];
    delete zone._characters[savedCharacter.characterId];
  });
  await t.test("character deletion", async () => {
    const character = createFakeCharacter(zone);
    createFakeZoneClient(zone, character);
    assert.equal(
      Object.keys(zone._characters).length,
      1,
      "Character not created"
    );
    assert.equal(Object.keys(zone._clients).length, 1, "Client not created");
    const client = zone.getClientByCharId(character.characterId);
    if (client) {
      await zone.deleteClient(client);
      assert.equal(
        Object.keys(zone._characters).length,
        0,
        "Character not deleted"
      );
      assert.equal(Object.keys(zone._clients).length, 0, "Client not deleted");
    } else {
      throw "client undefined";
    }
  });
  await t.test("stop", async () => {
    await zone.stop();
  });
});

test(
  "ZoneServer2016-mongo",
  { timeout: 60000, skip: !isMongoTests },
  async (t) => {
    const zone = new ZoneServer2016(
      0,
      Buffer.from("fake"),
      "mongodb://localhost:27017"
    );
    await t.test("start", async () => {
      await zone.start();
    });
    await t.test("save", async () => {
      await zone.saveWorld();
    });
    await t.test("character deletion", async () => {
      const character = createFakeCharacter(zone);
      createFakeZoneClient(zone, character);
      assert.equal(
        Object.keys(zone._characters).length,
        1,
        "Character not created"
      );
      assert.equal(Object.keys(zone._clients).length, 1, "Client not created");
      const client = zone.getClientByCharId(character.characterId);
      if (client) {
        await zone.deleteClient(client);
        assert.equal(
          Object.keys(zone._characters).length,
          0,
          "Character not deleted"
        );
        assert.equal(
          Object.keys(zone._clients).length,
          0,
          "Client not deleted"
        );
      } else {
        throw "client undefined";
      }
    });
    await scheduler.wait(500);
    await t.test("stop", async () => {
      await zone.stop();
    });
  }
);

after(() => {
  setImmediate(() => {
    process.exit(0);
  });
});
