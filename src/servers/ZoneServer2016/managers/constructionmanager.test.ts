import assert from "node:assert";
import test from "node:test";
import { ConstructionManager } from "./constructionmanager";
import type { ZoneServer2016 } from "../zoneserver";

test("successful construction emits a bounded investigation sound", () => {
  const sounds: unknown[] = [];
  const server = {
    pushSound(sound: unknown) {
      sounds.push(sound);
    }
  } as ZoneServer2016;
  const position = new Float32Array([10, 20, 30, 1]);

  new ConstructionManager().emitPlacementNoise(server, position);
  position[0] = 999;

  assert.equal(sounds.length, 1);
  assert.deepEqual(sounds[0], {
    position: new Float32Array([10, 20, 30, 1]),
    radius: 100,
    agitation: 12
  });
});
