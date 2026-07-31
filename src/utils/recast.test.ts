import assert from "node:assert";
import test from "node:test";
import type { BoxObstacle } from "recast-navigation";
import {
  NavManager,
  selectNavigationTransitionsForTile,
  shouldRecycleStreamingCache,
  shouldUseStreamingNav,
  sortTileCacheParts
} from "./recast";

test("navigation transitions are owned by the tile layer containing their start", () => {
  const transition = {
    name: "stairs",
    startPosition: { x: 10, y: 5, z: 20 },
    endPosition: { x: 14, y: 7, z: 20 },
    radius: 0.8,
    bidirectional: true
  };
  assert.deepEqual(
    selectNavigationTransitionsForTile([transition], [0, 0, 0], [25, 10, 25]),
    [transition]
  );
  assert.deepEqual(
    selectNavigationTransitionsForTile([transition], [25, 0, 0], [50, 10, 25]),
    []
  );
  assert.deepEqual(
    selectNavigationTransitionsForTile([transition], [0, 8, 0], [25, 12, 25]),
    []
  );
});

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

test("streaming cache recycling starts only when new layers cross the safe watermark", () => {
  assert.equal(shouldRecycleStreamingCache(0, 4000), false);
  assert.equal(shouldRecycleStreamingCache(3000, 0), false);
  assert.equal(shouldRecycleStreamingCache(2000, 1072), false);
  assert.equal(shouldRecycleStreamingCache(2000, 1073), true);
});

test("removed tile-cache obstacles release their capacity exactly once", () => {
  const navManager = new NavManager();
  const obstacle = {} as BoxObstacle;
  let removeCalls = 0;
  navManager.tilecache = {
    addBoxObstacle: () => ({ success: true, obstacle }),
    removeObstacle: () => {
      removeCalls++;
      return { success: true };
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

test("streaming activates only obstacles intersecting the loaded window", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 10,
    _loadedCols: new Set(["0,0"])
  });
  let nextRef = 1;
  let addCalls = 0;
  let removeCalls = 0;
  navManager.tilecache = {
    obstacles: new Map(),
    addBoxObstacle: (
      position: { x: number; y: number; z: number },
      halfExtents: { x: number; y: number; z: number },
      angle: number
    ) => {
      addCalls++;
      return {
        success: true,
        obstacle: {
          type: "box",
          ref: nextRef++,
          position,
          halfExtents,
          angle
        }
      };
    },
    removeObstacle: () => {
      removeCalls++;
      return { success: true };
    }
  } as never;

  const near = navManager.addObstacle(new Float32Array([5, 0, 5, 1]), {
    x: 1,
    y: 1,
    z: 1
  });
  const far = navManager.addObstacle(new Float32Array([55, 0, 5, 1]), {
    x: 1,
    y: 1,
    z: 1
  });
  assert.ok(near);
  assert.ok(far);
  assert.equal(addCalls, 1);
  assert.equal(navManager.obstacleCount, 2);

  navManager.obstaclesRequestsPending = 0;
  Object.assign(navManager as object, { _loadedCols: new Set(["5,0"]) });
  (
    navManager as unknown as { syncStreamedObstacles(): void }
  ).syncStreamedObstacles();
  assert.equal(removeCalls, 1);
  assert.equal(addCalls, 1);

  navManager.obstaclesRequestsPending = 0;
  (
    navManager as unknown as { syncStreamedObstacles(): void }
  ).syncStreamedObstacles();
  assert.equal(addCalls, 2);
  assert.equal(far.ref, 2);
});

test("tile-cache rebuild work is bounded per server tick", () => {
  const navManager = new NavManager();
  let tileCacheUpdates = 0;
  let crowdUpdates = 0;
  navManager.navmesh = {} as never;
  navManager.obstaclesRequestsPending = 1;
  navManager.tilecache = {
    obstacles: new Set(),
    update: () => {
      tileCacheUpdates++;
      return { success: true, status: 0, upToDate: false };
    }
  } as never;
  navManager.crowd = {
    getAgents: () => [],
    removeAgent: () => undefined,
    update: () => {
      crowdUpdates++;
    }
  } as never;

  assert.doesNotThrow(() => navManager.updt());
  assert.equal(tileCacheUpdates, 5);
  assert.equal(navManager.obstaclesRequestsPending, 1);
  assert.equal(crowdUpdates, 1);
  assert.equal(navManager.obstacleUpdatesHealthy, true);
});

test("tile-cache rebuild clears pending work when it catches up", () => {
  const navManager = new NavManager();
  let tileCacheUpdates = 0;
  navManager.navmesh = {} as never;
  navManager.obstaclesRequestsPending = 4;
  navManager.tilecache = {
    obstacles: new Set(),
    update: () => ({
      success: true,
      status: 0,
      upToDate: ++tileCacheUpdates === 3
    })
  } as never;
  navManager.crowd = {
    getAgents: () => [],
    removeAgent: () => undefined,
    update: () => undefined
  } as never;

  navManager.updt();
  assert.equal(tileCacheUpdates, 3);
  assert.equal(navManager.obstaclesRequestsPending, 0);
  assert.equal(navManager.obstacleUpdatesHealthy, true);
});

test("a native tile-cache failure disables obstacle updates without stopping the crowd", () => {
  const navManager = new NavManager();
  let crowdUpdates = 0;
  navManager.navmesh = {} as never;
  navManager.obstaclesRequestsPending = 1;
  navManager.tilecache = {
    obstacles: new Set(),
    update: () => ({ success: false, status: 2147483656, upToDate: false })
  } as never;
  navManager.crowd = {
    getAgents: () => [],
    removeAgent: () => undefined,
    update: () => {
      crowdUpdates++;
    }
  } as never;

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    assert.doesNotThrow(() => navManager.updt());
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(navManager.obstacleUpdatesHealthy, false);
  assert.equal(navManager.obstaclesRequestsPending, 0);
  assert.equal(crowdUpdates, 1);
  assert.equal(
    navManager.addObstacle(new Float32Array([0, 0, 0, 1]), {
      x: 1,
      y: 1,
      z: 1
    }),
    null
  );
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

test("streamed positions accept an adjacent loaded walkable column", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 10,
    _loadedCols: new Set(["1,0"])
  });

  assert.equal(
    navManager.isPositionStreamed(new Float32Array([5, 5, 5, 1])),
    true
  );
  assert.equal(
    navManager.isPositionStreamed(new Float32Array([35, 5, 5, 1])),
    false
  );
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
    findNearestPoly: () => ({
      nearestRef: 1,
      nearestPoint: { x: 5, y: 12, z: 5 }
    }),
    findRandomPointAroundCircle: () => ({
      success: true,
      randomPoint: { x: 2.59e-41, y: 2.59e-41, z: 2.24e-44 }
    })
  } as never;
  assert.equal(
    navManager.findRandomNavPointAround(new Float32Array([5, 12, 5, 1]), 60),
    null
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

test("active agents stay on the authored spawn floor", () => {
  const navManager = new NavManager();
  let queryExtents: unknown;
  navManager.navMeshQuery = {
    findNearestPoly: (_position: unknown, options: unknown) => {
      queryExtents = options;
      return {
        nearestRef: 123,
        nearestPoint: { x: 4, y: 20, z: 6 }
      };
    }
  } as never;
  navManager.crowd = {
    addAgent: () => assert.fail("cross-floor agent must not enter crowd")
  } as never;

  assert.equal(
    navManager.createAgent(new Float32Array([4, 25, 6, 1])),
    undefined
  );
  assert.deepEqual(queryExtents, {
    halfExtents: { x: 10, y: 1.5, z: 10 }
  });

  let addedAt: unknown;
  const expectedAgent = { agentIndex: 1 };
  navManager.crowd = {
    addAgent: (position: unknown) => {
      addedAt = position;
      return expectedAgent;
    },
    agents: {}
  } as never;
  assert.equal(
    navManager.createAgent(new Float32Array([4, 20.5, 6, 1])),
    expectedAgent
  );
  assert.deepEqual(addedAt, { x: 4, y: 20, z: 6 });
});

test("non-finite agent coordinates never reach native nav queries", () => {
  const navManager = new NavManager();
  navManager.navMeshQuery = {
    findNearestPoly: () =>
      assert.fail("non-finite coordinates must not reach the navmesh")
  } as never;
  navManager.crowd = {
    addAgent: () => assert.fail("non-finite coordinates must not enter crowd")
  } as never;

  const invalidPosition = new Float32Array([5, Number.NaN, 5, 1]);
  assert.equal(navManager.createAgent(invalidPosition), undefined);
  assert.equal(navManager.createPassiveAgent(invalidPosition), undefined);
});

test("instrumented crowd agents reject non-finite move targets", () => {
  const navManager = new NavManager();
  navManager.navMeshQuery = {
    findNearestPoly: () => ({
      nearestRef: 123,
      nearestPoint: { x: 4, y: 20, z: 6 }
    })
  } as never;
  let nativeMoveRequests = 0;
  const agent = {
    agentIndex: 1,
    requestMoveTarget: () => {
      nativeMoveRequests++;
      return true;
    }
  };
  navManager.crowd = {
    addAgent: () => agent,
    agents: {}
  } as never;

  const created = navManager.createAgent(new Float32Array([4, 20, 6, 1]));
  assert.equal(
    created?.requestMoveTarget({ x: Number.NaN, y: 20, z: 6 }),
    false
  );
  assert.equal(nativeMoveRequests, 0);
  assert.equal(
    created?.requestMoveTarget({
      x: 2.59e-41,
      y: 2.59e-41,
      z: 2.24e-44
    }),
    false
  );
  assert.equal(nativeMoveRequests, 0);
  assert.equal(created?.requestMoveTarget({ x: 5, y: 20, z: 6 }), true);
  assert.equal(nativeMoveRequests, 1);
});

test("failed nearest-poly queries never expose uninitialized WASM points", () => {
  const navManager = new NavManager();
  navManager.navMeshQuery = {
    findNearestPoly: () => ({
      nearestRef: 0,
      nearestPoint: { x: 2.59e-41, y: 2.59e-41, z: 2.24e-44 }
    })
  } as never;

  assert.equal(
    navManager.getClosestNavPointVec3(new Float32Array([200, 31, -1272, 1])),
    null
  );
});

test("streaming removes agents before tiles change without reallocating the crowd", () => {
  const navManager = new NavManager();
  const events: string[] = [];
  let requestedTileCapacity = 0;
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _streamRuntimeMutationEnabled: true,
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 25.6,
    _lastStreamMs: 0,
    _loadedCols: new Set(["0,0"]),
    _cacheLoadedCols: new Set(["39,39"]),
    _streamCacheLayers: new Map([
      ["0,0", Array.from({ length: 12 }, () => ({ offset: 0, length: 1 }))],
      ["39,39", []]
    ])
  });
  navManager.navmesh = {
    getTilesAt: (_x: number, _z: number, maxTiles: number) => {
      requestedTileCapacity = maxTiles;
      events.push("remove-tiles");
      return { tileCount: () => 0 };
    }
  } as never;
  navManager.tilecache = {
    buildNavMeshTilesAt: () => {
      events.push("build-tiles");
      return 1 << 30;
    }
  } as never;
  navManager.crowd = {
    getAgents: () => [{ agentIndex: 7 }],
    removeAgent: () => events.push("remove-agent")
  } as never;
  navManager.setAgentInvalidationHandler(() =>
    events.push("invalidate-agents")
  );

  assert.equal(
    navManager.streamAround([new Float32Array([1000, 0, 1000, 1])]),
    true
  );
  assert.deepEqual(events.slice(0, 3), [
    "invalidate-agents",
    "remove-agent",
    "remove-tiles"
  ]);
  assert.equal(events.includes("build-tiles"), true);
  assert.equal(requestedTileCapacity, 12);
});

test("safe streaming only adds columns and never unloads the native runtime", () => {
  const navManager = new NavManager();
  const events: string[] = [];
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _streamRuntimeMutationEnabled: false,
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 25.6,
    _lastStreamMs: 0,
    _loadedCols: new Set(["0,0"]),
    _cacheLoadedCols: new Set(["39,39"]),
    _streamCacheLayers: new Map([
      ["0,0", []],
      ["39,39", []]
    ])
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
      return 1 << 30;
    }
  } as never;
  navManager.crowd = {
    getAgents: () => [],
    removeAgent: () => {}
  } as never;

  assert.equal(
    navManager.streamAround([new Float32Array([1000, 0, 1000, 1])]),
    true
  );
  assert.deepEqual(events, ["build-tiles"]);
});

test("crowd update faults are contained and latched", () => {
  const navManager = new NavManager();
  let faultReports = 0;
  let invalidations = 0;
  navManager.tilecache = { obstacles: new Set() } as never;
  navManager.crowd = {
    update: () => {
      throw new WebAssembly.RuntimeError("memory access out of bounds");
    }
  } as never;
  navManager.setAgentInvalidationHandler(() => {
    invalidations++;
  });

  const originalConsoleError = console.error;
  console.error = () => {
    faultReports++;
  };
  try {
    assert.doesNotThrow(() => navManager.updt());
    Object.assign(navManager as object, { _crowdHealthy: true });
    assert.doesNotThrow(() => navManager.updt());
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(navManager.crowdHealthy, false);
  assert.equal(faultReports, 1);
  assert.equal(invalidations, 1);
});

test("a poisoned crowd is never re-entered during navmesh mutation", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _crowdHealthy: false,
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 25.6,
    _lastStreamMs: 0,
    _loadedCols: new Set(["0,0"])
  });
  navManager.crowd = {
    getAgents: () => assert.fail("poisoned crowd must not be touched")
  } as never;
  navManager.navmesh = {
    getTilesAt: () => assert.fail("navmesh must not mutate after crowd fault")
  } as never;
  navManager.tilecache = {
    buildNavMeshTilesAt: () =>
      assert.fail("tile cache must not mutate after crowd fault")
  } as never;

  assert.equal(
    navManager.streamAround([new Float32Array([1000, 0, 1000, 1])]),
    false
  );
});

test("passive agents are rejected when no nav polygon exists", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 10,
    _loadedCols: new Set(["0,0"])
  });
  navManager.navMeshQuery = {
    findNearestPoly: () => ({
      nearestRef: 0,
      nearestPoint: { x: 0, y: 0, z: 0 }
    })
  } as never;
  navManager.crowd = {
    addAgent: () => assert.fail("off-nav passive agent must not enter crowd")
  } as never;

  assert.equal(
    navManager.createPassiveAgent(new Float32Array([5, 5, 5, 1])),
    undefined
  );
});

test("passive-agent teleports stay within the entity's current floor", () => {
  const navManager = new NavManager();
  navManager.streaming = true;
  Object.assign(navManager as object, {
    _tcOrigX: 0,
    _tcOrigZ: 0,
    _tcTileWidth: 10,
    _loadedCols: new Set(["0,0"])
  });
  let queryExtents: unknown;
  navManager.navMeshQuery = {
    findNearestPoly: (_position: unknown, options: unknown) => {
      queryExtents = options;
      return {
        nearestRef: 123,
        nearestPoint: { x: 4, y: 7, z: 6 }
      };
    }
  } as never;
  let teleportedTo: unknown;
  const agent = {
    teleport: (position: unknown) => {
      teleportedTo = position;
    }
  };

  assert.equal(
    navManager.teleportAgent(agent as never, new Float32Array([5, 7, 5, 1])),
    true
  );
  assert.deepEqual(queryExtents, {
    halfExtents: { x: 10, y: 1.5, z: 10 }
  });
  assert.deepEqual(teleportedTo, { x: 4, y: 7, z: 6 });
});
