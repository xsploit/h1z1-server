import assert from "node:assert";
import test from "node:test";
import type { BoxObstacle } from "recast-navigation";
import { NavManager } from "./recast";

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
