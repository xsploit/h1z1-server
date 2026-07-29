import assert from "node:assert";
import test from "node:test";
import type { BoxObstacle } from "recast-navigation";
import {
  NavManager,
  shouldUseStreamingNav,
  sortTileCacheParts
} from "./recast";

test("tile-cache parts are sorted by their suffix", () => {
  assert.deepEqual(
    sortTileCacheParts([
      "z1_cache_10.bin",
      "z1_cache_2.bin",
      "z1_cache_1.bin",
      "z1_cache_0.bin"
    ]),
    ["z1_cache_0.bin", "z1_cache_1.bin", "z1_cache_2.bin", "z1_cache_10.bin"]
  );
});

test("a present streaming cache is used unless explicitly disabled", () => {
  assert.equal(shouldUseStreamingNav(undefined, true), true);
  assert.equal(shouldUseStreamingNav("1", true), true);
  assert.equal(shouldUseStreamingNav("0", true), false);
  assert.equal(shouldUseStreamingNav(undefined, false), false);
  assert.equal(shouldUseStreamingNav("1", false), true);
});

test("removed tile-cache obstacles release their capacity exactly once", () => {
  const navManager = new NavManager();
  const obstacle = {} as BoxObstacle;
  let removeCalls = 0;
  navManager.tilecache = {
    addBoxObstacle: () => ({ success: true, obstacle }),
    removeObstacle: () => {
      removeCalls++;
    }
  } as never;

  const added = navManager.addObstacle(new Float32Array([0, 0, 0, 1]), {
    x: 1,
    y: 1,
    z: 1
  });
  assert.equal(added, obstacle);
  assert.equal(navManager.obstacleCount, 1);

  navManager.removeObstacle(obstacle);
  assert.equal(navManager.obstacleCount, 0);
  assert.equal(removeCalls, 1);

  navManager.removeObstacle(obstacle);
  assert.equal(navManager.obstacleCount, 0);
  assert.equal(removeCalls, 1);
});
