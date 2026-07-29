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

import {
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync
} from "node:fs";
import {
  BoxObstacle,
  CrowdAgent,
  DetourTileCacheParams,
  getNavMeshPositionsAndIndices,
  importNavMesh,
  importTileCache,
  init as initRecast,
  NavMesh,
  NavMeshParams,
  Raw,
  statusSucceed,
  statusToReadableString,
  TileCache,
  UnsignedCharArray,
  Vector3
} from "recast-navigation";

export function sortTileCacheParts(parts: string[]): string[] {
  return parts.sort((a, b) => {
    const aPart = a.match(/^z1_cache_(\d+)\.bin$/);
    const bPart = b.match(/^z1_cache_(\d+)\.bin$/);
    if (!aPart || !bPart) {
      throw new Error("[NAV] invalid tilecache part filename");
    }
    return Number(aPart[1]) - Number(bPart[1]);
  });
}

export function shouldUseStreamingNav(
  requestedMode: string | undefined,
  cacheAvailable: boolean
): boolean {
  if (requestedMode === "0") return false;
  return requestedMode === "1" || cacheAvailable;
}
import { NavMeshQuery } from "recast-navigation";
import { Crowd } from "recast-navigation";
import { createDefaultTileCacheMeshProcess } from "recast-navigation/generators";
const debug = require("debug")("nav");
// dedicated namespace for tile streaming (enable with DEBUG=nav:stream)
const debugStream = require("debug")("nav:stream");

const MAX_OBSTACLE = 20000;
const MAX_PENDING_OBSTACLE = 50;
const MAX_ACTIVE_AGENT_VERTICAL_SNAP = 1.5;

// Streaming navmesh: a whole-map FINE navmesh stored as a compressed TileCache
// on disk (data/2016/collision/z1_cache_*.bin, format "TSET", built by the
// h1emu-recast pipeline compiled fine, cs=0.2). The whole compressed tilecache
// (~600 MB / ~108k layers) is preloaded into RAM at boot; only the tiles within
// STREAM_RADIUS of a player are materialised into the live navmesh
// (buildNavMeshTilesAt), the rest are removed, so the navmesh stays bounded and
// under the 32-bit polyref budget. Grid params (orig, tileWidth) come from the
// TSET header. Construction obstacles carve natively via the tilecache.
const STREAM_CACHE_DIR =
  process.env.NAV_CACHE_DIR ?? __dirname + "/../../data/2016/collision";
const STREAM_RADIUS = 300; // materialise tiles within this many meters of a player
const STREAM_INTERVAL = 1000; // ms between window updates

export class NavManager {
  navmesh!: NavMesh;
  tilecache!: TileCache;
  obstaclesRequestsPending: number = 0;
  crowd!: Crowd;
  navMeshQuery!: NavMeshQuery;
  lastTimeCall: number = Date.now();
  updateFrequency = 1 / 5;
  obstacleCount = 0;
  private readonly _activeObstacles = new Set<BoxObstacle>();
  // streaming state
  streaming = false;
  private _tcOrigX = 0;
  private _tcOrigZ = 0;
  private _tcTileWidth = 25.6;
  private _loadedCols = new Set<string>(); // materialised tile columns "tx,tz"
  private _lastStreamMs = 0;
  private _crowdMaxAgents = 2000;
  private _crowdMaxAgentRadius = 2.0;
  private _crowdHealthy = true;
  private _crowdFaultReported = false;
  private _successfulCrowdUpdates = 0;
  private _agentInvalidationHandler?: () => void;
  constructor() {}

  get crowdHealthy(): boolean {
    return this._crowdHealthy;
  }

  setAgentInvalidationHandler(handler: () => void): void {
    this._agentInvalidationHandler = handler;
  }

  private createCrowd(): void {
    this.crowd = new Crowd(this.navmesh, {
      maxAgents: this._crowdMaxAgents,
      maxAgentRadius: this._crowdMaxAgentRadius
    });
    this.lastTimeCall = Date.now();
    this._crowdHealthy = true;
    this._successfulCrowdUpdates = 0;
  }

  private markCrowdFault(error: unknown, operation: string): void {
    this._crowdHealthy = false;
    this._successfulCrowdUpdates = 0;
    if (this._crowdFaultReported) return;
    this._crowdFaultReported = true;
    let activeAgents: number | string = "unavailable";
    let wrapperAgents: number | string = "unavailable";
    try {
      activeAgents = this.crowd.getActiveAgentCount();
      wrapperAgents = this.crowd.getAgents().length;
    } catch {
      // The native heap may already be poisoned; keep the fallback counts.
    }
    this._agentInvalidationHandler?.();
    console.error(
      `[NAV] crowd disabled after ${operation} ` +
        `(active=${activeAgents}, wrappers=${wrapperAgents}): ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`
    );
  }

  private mutateNavMesh(
    mutation: () => void,
    beforeMutation?: () => void
  ): boolean {
    (beforeMutation ?? this._agentInvalidationHandler)?.();
    if (!this._crowdHealthy) return false;
    try {
      for (const agent of this.crowd.getAgents()) {
        this.crowd.removeAgent(agent);
      }
    } catch (error) {
      this.markCrowdFault(error, "agent invalidation");
      return false;
    }
    try {
      mutation();
      this.lastTimeCall = Date.now();
      return true;
    } catch (error) {
      console.error(
        `[NAV] navmesh mutation failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`
      );
      return false;
    }
  }
  async loadNav() {
    const requestedMode = process.env.NAV_STREAMING;
    const storePath = STREAM_CACHE_DIR + "/z1_cache_0.bin";
    const cacheAvailable = existsSync(storePath);
    if (shouldUseStreamingNav(requestedMode, cacheAvailable)) {
      if (cacheAvailable) return this.loadNavStreaming();
    }
    if (requestedMode === "1") {
      console.warn(
        "[NAV] NAV_STREAMING=1 but data/2016/collision/z1_cache_*.bin is missing - falling back to the standard navmesh"
      );
    }
    console.time("[NAV] Navmesh loaded");
    const mesh_parts: Buffer[] = [];
    const tc_parts: Buffer[] = [];
    let part = 0;
    while (true) {
      const partPath = __dirname + `/../../data/2016/navData/z1_${part}.bin`;
      if (!existsSync(partPath)) break;
      mesh_parts.push(readFileSync(partPath));
      console.log(`[NAV] loaded nav part ${part}`);
      part++;
    }
    part = 0;

    while (true) {
      const partPath =
        __dirname + `/../../data/2016/navData/z1_cache_${part}.bin`;
      if (!existsSync(partPath)) break;
      tc_parts.push(readFileSync(partPath));
      console.log(`[NAV] loaded nav cache part ${part}`);
      part++;
    }
    await initRecast();

    const navData = new Uint8Array(Buffer.concat(mesh_parts));
    const { navMesh } = importNavMesh(navData);
    const tcData = new Uint8Array(Buffer.concat(tc_parts));
    const tileCacheMeshProcess = createDefaultTileCacheMeshProcess();
    const { tileCache } = importTileCache(tcData, tileCacheMeshProcess);
    this.navmesh = navMesh;
    this.tilecache = tileCache;
    this._crowdMaxAgents = 2000;
    this._crowdMaxAgentRadius = 2.0;
    this.navMeshQuery = new NavMeshQuery(this.navmesh);
    this.createCrowd();
    console.timeEnd("[NAV] Navmesh loaded");
  }

  // Streaming mode: preload the whole compressed TileCache (z1_cache_*.bin, TSET
  // format from h1emu-recast) into RAM, build an empty tiled navmesh, and add
  // every compressed layer to the tilecache. Tiles are materialised on demand
  // around players in streamAround() (buildNavMeshTilesAt).
  private async loadNavStreaming() {
    console.time("[NAV] streaming tilecache loaded");
    await initRecast();
    const dir = STREAM_CACHE_DIR;
    const parts = sortTileCacheParts(
      readdirSync(dir).filter((f) => /^z1_cache_\d+\.bin$/.test(f))
    );
    const buf = Buffer.concat(parts.map((p) => readFileSync(`${dir}/${p}`)));

    // parse TileCacheSetHeader (magic, version, numTiles, meshParams, cacheParams)
    let o = 0;
    const rI = () => {
      const v = buf.readInt32LE(o);
      o += 4;
      return v;
    };
    const rF = () => {
      const v = buf.readFloatLE(o);
      o += 4;
      return v;
    };
    const TSET =
      ("T".charCodeAt(0) << 24) |
      ("S".charCodeAt(0) << 16) |
      ("E".charCodeAt(0) << 8) |
      "T".charCodeAt(0);
    if (rI() !== TSET) throw new Error("[NAV] bad tilecache TSET magic");
    const version = rI();
    if (version !== 1) {
      throw new Error(`[NAV] unsupported tilecache TSET version ${version}`);
    }
    const numTiles = rI();
    if (numTiles <= 0) throw new Error("[NAV] tilecache contains no layers");
    const mesh = {
      orig: { x: rF(), y: rF(), z: rF() },
      tileWidth: rF(),
      tileHeight: rF(),
      maxTiles: rI(),
      maxPolys: rI()
    };
    const cache = {
      orig: [rF(), rF(), rF()],
      cs: rF(),
      ch: rF(),
      width: rI(),
      height: rI(),
      walkableHeight: rF(),
      walkableRadius: rF(),
      walkableClimb: rF(),
      maxSimplificationError: rF(),
      maxTiles: rI(),
      maxObstacles: rI()
    };
    this._tcOrigX = mesh.orig.x;
    this._tcOrigZ = mesh.orig.z;
    this._tcTileWidth = mesh.tileWidth;

    const meshProcess = createDefaultTileCacheMeshProcess();
    this.tilecache = new TileCache();
    if (
      !this.tilecache.init(
        DetourTileCacheParams.create(cache),
        new (Raw as any).RecastLinearAllocator(1 << 20),
        new (Raw as any).RecastFastLZCompressor(),
        meshProcess
      )
    ) {
      throw new Error("[NAV] failed to initialize streaming tilecache");
    }
    this.navmesh = new NavMesh();
    if (!this.navmesh.initTiled(NavMeshParams.create(mesh))) {
      throw new Error("[NAV] failed to initialize streaming navmesh");
    }

    const FREE = (Raw.Detour as any).DT_COMPRESSEDTILE_FREE_DATA ?? 1;
    for (let i = 0; i < numTiles; i++) {
      if (o + 8 > buf.length) {
        throw new Error(`[NAV] truncated tilecache before layer ${i}`);
      }
      o += 4; // tileRef (recomputed by addTile)
      const dataSize = buf.readInt32LE(o);
      o += 4;
      if (dataSize <= 0 || o + dataSize > buf.length) {
        throw new Error(
          `[NAV] invalid tilecache layer ${i} size ${dataSize} at offset ${o}`
        );
      }
      const arr = new UnsignedCharArray();
      arr.copy(buf.subarray(o, o + dataSize));
      o += dataSize;
      const result = this.tilecache.addTile(arr, FREE);
      if (!statusSucceed(result.status)) {
        throw new Error(
          `[NAV] failed to add tilecache layer ${i}: ${statusToReadableString(result.status)}`
        );
      }
    }
    if (o !== buf.length) {
      throw new Error(`[NAV] tilecache has ${buf.length - o} trailing bytes`);
    }

    this.navMeshQuery = new NavMeshQuery(this.navmesh);
    this._crowdMaxAgents = 1000;
    this._crowdMaxAgentRadius = 2.5;
    this.createCrowd();
    this.streaming = true;
    console.timeEnd("[NAV] streaming tilecache loaded");
    console.log(
      `[NAV] streaming tilecache ready (${numTiles} layers, ${(buf.length / 1048576) | 0} MB in RAM)`
    );
  }

  // Materialise the navmesh tiles within STREAM_RADIUS of any player from the
  // in-RAM tilecache (buildNavMeshTilesAt) and remove the columns that left the
  // window. Throttled. No-op unless streaming.
  streamAround(
    positions: Float32Array[],
    beforeMutation?: () => void
  ): boolean {
    if (!this.streaming) return false;
    const now = Date.now();
    if (now - this._lastStreamMs < STREAM_INTERVAL) return false;
    this._lastStreamMs = now;
    const tw = this._tcTileWidth;
    const rad = Math.ceil(STREAM_RADIUS / tw);
    const want = new Set<string>();
    for (const p of positions) {
      const cx = Math.floor((p[0] - this._tcOrigX) / tw),
        cz = Math.floor((p[2] - this._tcOrigZ) / tw);
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          want.add(`${cx + dx},${cz + dz}`);
        }
      }
    }
    const toRemove = [...this._loadedCols].filter((k) => !want.has(k));
    const toAdd = [...want].filter((k) => !this._loadedCols.has(k));
    if (!toRemove.length && !toAdd.length) return false;
    let removed = 0;
    let added = 0;
    const success = this.mutateNavMesh(() => {
      // unload columns outside the window
      for (const k of toRemove) {
        const [tx, tz] = k.split(",").map(Number);
        const res = this.navmesh.getTilesAt(tx, tz, 8);
        for (let i = 0; i < res.tileCount(); i++) {
          const ref = this.navmesh.getTileRef(res.tiles(i));
          if (ref) this.navmesh.removeTile(ref);
        }
        this._loadedCols.delete(k);
        removed++;
      }
      // materialise columns entering the window; obstacles already registered
      // in the tilecache are carved in by buildNavMeshTilesAt
      for (const k of toAdd) {
        const [tx, tz] = k.split(",").map(Number);
        this.tilecache.buildNavMeshTilesAt(tx, tz, this.navmesh);
        this._loadedCols.add(k);
        added++;
      }
    }, beforeMutation);
    // only log when the window actually changed (no spam while standing still)
    if ((added || removed) && debugStream.enabled) {
      debugStream(
        `+${added} -${removed} columns (loaded: ${this._loadedCols.size}, players: ${positions.length})`
      );
    }
    return success;
  }

  isPositionStreamed(gamePos: Float32Array): boolean {
    if (!this.streaming) return true;
    if (
      !Number.isFinite(gamePos[0]) ||
      !Number.isFinite(gamePos[2]) ||
      this._tcTileWidth <= 0
    ) {
      return false;
    }
    const tx = Math.floor((gamePos[0] - this._tcOrigX) / this._tcTileWidth);
    const tz = Math.floor((gamePos[2] - this._tcOrigZ) / this._tcTileWidth);
    return this._loadedCols.has(`${tx},${tz}`);
  }

  removeAgent(agent: CrowdAgent): void {
    if (!this._crowdHealthy) return;
    try {
      this.crowd.removeAgent(agent);
    } catch (error) {
      debugStream(
        `failed to remove stale crowd agent: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  findRandomNavPointAround(
    gameCenter: Float32Array,
    radius: number
  ): Float32Array | null {
    if (
      radius <= 0 ||
      !Number.isFinite(radius) ||
      !Number.isFinite(gameCenter[0]) ||
      !Number.isFinite(gameCenter[1]) ||
      !Number.isFinite(gameCenter[2]) ||
      !this._crowdHealthy ||
      !this.isPositionStreamed(gameCenter)
    ) {
      return null;
    }
    try {
      const center = this.navMeshQuery.findNearestPoly(
        NavManager.gameToNav(gameCenter),
        { halfExtents: { x: 4, y: 8, z: 4 } }
      );
      if (!center.nearestRef) return null;
      const result = this.navMeshQuery.findRandomPointAroundCircle(
        center.nearestPoint,
        radius
      );
      if (!result.success) return null;
      return NavManager.navToGame(result.randomPoint);
    } catch (error) {
      debugStream(
        `random-point query rejected at [${gameCenter[0]}, ${gameCenter[1]}, ${gameCenter[2]}]: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  static gameToNav(f: Float32Array): Vector3 {
    return { x: f[0], y: f[1], z: f[2] };
  }
  static navToGame(v: Vector3): Float32Array {
    return new Float32Array([v.x, v.y, v.z, 0]);
  }

  removeObstacle(obstacle: BoxObstacle) {
    if (!this._activeObstacles.delete(obstacle)) return;
    this.tilecache.removeObstacle(obstacle);
    this.obstaclesRequestsPending++;
    this.obstacleCount--;
  }

  addObstacle(
    position: Float32Array,
    halfExtents: Vector3,
    yRotation: number = 0.0
  ) {
    if (this.obstacleCount >= MAX_OBSTACLE) {
      return null;
    }
    if (this.obstaclesRequestsPending >= MAX_PENDING_OBSTACLE) {
      const success = this.mutateNavMesh(() => {
        let upToDate = false;
        while (!upToDate) {
          ({ upToDate } = this.tilecache.update(this.navmesh));
        }
      });
      if (success) this.obstaclesRequestsPending = 0;
    }
    const { success, obstacle } = this.tilecache.addBoxObstacle(
      NavManager.gameToNav(position),
      halfExtents,
      yRotation
    );
    if (success) {
      this.obstaclesRequestsPending++;
      this.obstacleCount++;
      this._activeObstacles.add(obstacle);
      return obstacle;
    }
    return null;
  }

  getClosestNavPoint(gamePos: Float32Array): any {
    const navInput = NavManager.gameToNav(gamePos);
    const n = this.navMeshQuery.findClosestPoint(navInput);
    return n;
  }

  raycast(origin: Float32Array, target: Float32Array) {
    const origin_data = this.getClosestNavPoint(origin);

    const startPoly = origin_data.polyRef;
    const start = origin_data.point;
    const end = this.getClosestNavPointVec3(target);

    const result = this.navMeshQuery.raycast(startPoly, start, end);
    return result;
  }

  updt() {
    const now = Date.now();
    const timeSinceLastCalled = (now - this.lastTimeCall) / 1000;
    // tilecache carving runs in both modes now: in streaming the obstacles are
    // applied to the materialised window tiles, in normal mode to the whole mesh
    if (this.obstaclesRequestsPending) {
      const success = this.mutateNavMesh(() => {
        let upToDate = false;
        while (!upToDate) {
          ({ upToDate } = this.tilecache.update(this.navmesh));
        }
      });
      if (success) this.obstaclesRequestsPending = 0;
    }
    debug(
      `requests: ${this.obstaclesRequestsPending}, total: ${this.tilecache.obstacles.size}`
    );
    this.lastTimeCall = now;
    if (!this._crowdHealthy) return;
    try {
      this.crowd.update(this.updateFrequency, timeSinceLastCalled, 1);
      if (++this._successfulCrowdUpdates >= 25) {
        this._crowdFaultReported = false;
      }
    } catch (error) {
      this.markCrowdFault(error, "update");
    }
  }

  // Returns nearest navmesh point (in nav coords) to the given game position.
  // Uses large halfExtents so Y offset doesn't prevent finding a polygon.
  getClosestNavPointVec3(gamePos: Float32Array): Vector3 {
    const navInput = NavManager.gameToNav(gamePos);
    const n = this.navMeshQuery.findNearestPoly(navInput, {
      halfExtents: { x: 10, y: 10, z: 10 }
    });
    debug(
      `getClosestNavPoint gameIn=[${gamePos[0].toFixed(2)}, ${gamePos[1].toFixed(2)}, ${gamePos[2].toFixed(2)}] navOut=[${n.nearestPoint.x.toFixed(2)}, ${n.nearestPoint.y.toFixed(2)}, ${n.nearestPoint.z.toFixed(2)}] polyRef=${n.nearestRef}`
    );
    return n.nearestPoint;
  }

  // Nearest walkable floor Y (game coords) under the given position, or null if
  // no polygon is found. Last-resort fallback when neither the structure BVH
  // (CollisionManager.groundRaycast) nor the terrain heightmap yields a height.
  getFloorY(gamePos: Float32Array): number | null {
    const navInput = NavManager.gameToNav(gamePos);
    const { nearestRef, nearestPoint } = this.navMeshQuery.findNearestPoly(
      navInput,
      { halfExtents: { x: 2, y: 8, z: 2 } }
    );
    if (!nearestRef) return null;
    const res = this.navMeshQuery.getPolyHeight(nearestRef, nearestPoint);
    return res.success && Number.isFinite(res.height) ? res.height : null;
  }

  createAgent(gamePos: Float32Array): CrowdAgent | undefined {
    // In streaming mode the navmesh only exists around players; if no tile is
    // loaded under this spawn point yet, defer (caller retries when it loads)
    // instead of placing the agent at a garbage position.
    if (!this._crowdHealthy || !this.isPositionStreamed(gamePos)) {
      return undefined;
    }
    try {
      const { nearestRef, nearestPoint } = this.navMeshQuery.findNearestPoly(
        NavManager.gameToNav(gamePos),
        { halfExtents: { x: 10, y: 10, z: 10 } }
      );
      if (!nearestRef) return undefined;
      const navPosition = nearestPoint;
      if (
        !Number.isFinite(navPosition.y) ||
        Math.abs(navPosition.y - gamePos[1]) > MAX_ACTIVE_AGENT_VERTICAL_SNAP
      ) {
        debugStream(
          `create-agent rejected cross-floor snap at [${gamePos[0]}, ${gamePos[1]}, ${gamePos[2]}] -> navY=${navPosition.y}`
        );
        return undefined;
      }
      debug(
        `createAgent: navPos=[${navPosition.x.toFixed(2)}, ${navPosition.y.toFixed(2)}, ${navPosition.z.toFixed(2)}]`
      );

      // Preserve the exact nearest polygon selected from the authored spawn Y.
      // A random X/Z nudge can select another floor in vertically layered
      // buildings even though the points are only half a metre apart.
      const agent = this.crowd.addAgent(navPosition, {
        radius: 0.3,
        height: 2,
        maxAcceleration: 1.0,
        maxSpeed: 1.0,
        collisionQueryRange: 2.0,
        pathOptimizationRange: 4.0,
        separationWeight: 2.0
      });
      if (
        !Number.isInteger(agent.agentIndex) ||
        agent.agentIndex < 0 ||
        agent.agentIndex >= this._crowdMaxAgents
      ) {
        delete this.crowd.agents[String(agent.agentIndex)];
        return undefined;
      }
      debug(
        `createAgent: agentIdx=${agent.agentIndex} navPos=[${navPosition.x.toFixed(2)}, ${navPosition.y.toFixed(2)}, ${navPosition.z.toFixed(2)}]`
      );
      return agent;
    } catch (error) {
      debugStream(
        `create-agent query rejected at [${gamePos[0]}, ${gamePos[1]}, ${gamePos[2]}]: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  }

  createPassiveAgent(
    gamePos: Float32Array,
    radius: number = 0.5
  ): CrowdAgent | undefined {
    if (!this._crowdHealthy || !this.isPositionStreamed(gamePos)) {
      return undefined;
    }
    try {
      const { nearestRef, nearestPoint } = this.navMeshQuery.findNearestPoly(
        NavManager.gameToNav(gamePos),
        { halfExtents: { x: 10, y: 10, z: 10 } }
      );
      if (
        !nearestRef ||
        !Number.isFinite(nearestPoint.x) ||
        !Number.isFinite(nearestPoint.y) ||
        !Number.isFinite(nearestPoint.z)
      ) {
        return undefined;
      }
      const agent = this.crowd.addAgent(nearestPoint, {
        radius,
        height: 2,
        maxAcceleration: 0,
        maxSpeed: 0,
        collisionQueryRange: radius * 2,
        pathOptimizationRange: 0,
        separationWeight: 1,
        updateFlags: 0
      });
      if (
        !Number.isInteger(agent.agentIndex) ||
        agent.agentIndex < 0 ||
        agent.agentIndex >= this._crowdMaxAgents
      ) {
        delete this.crowd.agents[String(agent.agentIndex)];
        return undefined;
      }
      return agent;
    } catch (error) {
      debugStream(
        `create-passive-agent rejected at [${gamePos[0]}, ${gamePos[1]}, ${gamePos[2]}]: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return undefined;
    }
  }

  teleportAgent(agent: CrowdAgent, gamePos: Float32Array): boolean {
    if (!this._crowdHealthy || !this.isPositionStreamed(gamePos)) return false;
    try {
      const { nearestRef, nearestPoint } = this.navMeshQuery.findNearestPoly(
        NavManager.gameToNav(gamePos),
        { halfExtents: { x: 10, y: 10, z: 10 } }
      );
      if (
        !nearestRef ||
        !Number.isFinite(nearestPoint.x) ||
        !Number.isFinite(nearestPoint.y) ||
        !Number.isFinite(nearestPoint.z)
      ) {
        return false;
      }
      agent.teleport(nearestPoint);
      return true;
    } catch (error) {
      this.markCrowdFault(error, "agent teleport");
      return false;
    }
  }

  async dumpNavmesh() {
    const [positions, indices] = getNavMeshPositionsAndIndices(this.navmesh);
    const stream = createWriteStream("navMeshDump.obj");

    for (let i = 0; i < positions.length; i += 3) {
      stream.write(
        `v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}\n`
      );
    }

    for (let i = 0; i < indices.length; i += 3) {
      stream.write(
        `f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}\n`
      );
    }

    await new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.on("error", reject);
    });
  }
}
