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

test("streamed random-point queries skip unloaded NPC positions", () => {
  const navManager = new NavManager();
  let queryCalls = 0;
  navManager.streaming = true;
  navManager.navMeshQuery = {
    findNearestPoly: () => {
      queryCalls++;
      throw new Error("unloaded navmesh must not be queried");
    }
  } as never;

  assert.equal(
    navManager.findRandomNavPointAround(
      new Float32Array([100, 10, 100, 1]),
      60
    ),
    null
  );
  assert.equal(
    navManager.createAgent(new Float32Array([100, 10, 100, 1])),
    undefined
  );
  assert.equal(queryCalls, 0);
});

test("streamed random-point queries snap to a loaded floor and contain WASM errors", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 10
  });
  (navManager as unknown as { _loadedCols: Set<string> })._loadedCols.add(
    "0,0"
  );
  navManager.navMeshQuery = {
    findNearestPoly: () => ({
      nearestRef: 1,
      nearestPoint: { x: 5, y: 12, z: 5 }
    }),
    findRandomPointAroundCircle: () => ({
      success: true,
      randomPoint: { x: 7, y: 12, z: 8 }
    })
  } as never;

  assert.deepEqual(
    Array.from(
      navManager.findRandomNavPointAround(
        new Float32Array([5, 12, 5, 1]),
        60
      ) ?? []
    ),
    [7, 12, 8, 0]
  );

  navManager.navMeshQuery = {
    findNearestPoly: () => {
      throw new WebAssembly.RuntimeError("memory access out of bounds");
    }
  } as never;
  assert.equal(
    navManager.findRandomNavPointAround(new Float32Array([5, 12, 5, 1]), 60),
    null
  );
});

test("streaming invalidates agents before tiles change and recreates the crowd afterward", () => {
  const navManager = new NavManager();
  const events: string[] = [];
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 25.6,
    _lastStreamMs: 0,
    _loadedCols: new Set(["0,0"])
  });
  navManager.navmesh = {
    getTilesAt: () => {
      events.push("remove-tiles");
      return { tileCount: () => 0 };
    }
  } as never;
  navManager.tilecache = {
    buildNavMeshTilesAt: () => {
      events.push("build-tiles");
    }
  } as never;
  Object.assign(navManager as object, {
    destroyCrowd: () => events.push("destroy-crowd"),
    createCrowd: () => events.push("create-crowd")
  });
  navManager.setAgentInvalidationHandler(() =>
    events.push("invalidate-agents")
  );

  assert.equal(
    navManager.streamAround([new Float32Array([1000, 0, 1000, 1])]),
    true
  );
  assert.deepEqual(events.slice(0, 3), [
    "invalidate-agents",
    "destroy-crowd",
    "remove-tiles"
  ]);
  assert.equal(events.at(-1), "create-crowd");
});

test("crowd update faults are contained and latched", () => {
  const navManager = new NavManager();
  navManager.tilecache = { obstacles: new Set() } as never;
  navManager.crowd = {
    update: () => {
      throw new WebAssembly.RuntimeError("memory access out of bounds");
    }
  } as never;

  assert.doesNotThrow(() => navManager.updt());
  assert.equal(navManager.crowdHealthy, false);
});
