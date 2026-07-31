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
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
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
import { runRuntimePhase } from "./runtimewatchdog";
const debug = require("debug")("nav");
// dedicated namespace for tile streaming (enable with DEBUG=nav:stream)
const debugStream = require("debug")("nav:stream");

const MAX_OBSTACLE = 20000;
const MAX_PENDING_OBSTACLE = 50;
const MAX_TILE_CACHE_UPDATES_PER_TICK = 5;
const TILE_CACHE_BACKLOG_WARNING_TICKS = 25;
const MAX_ACTIVE_AGENT_VERTICAL_SNAP = 1.5;

// Streaming navmesh: a whole-map FINE navmesh stored as a compressed TileCache
// on disk (data/2016/collision/z1_cache_*.bin, format "TSET", built by the
// h1emu-recast pipeline compiled fine, cs=0.2). The compressed tilecache
// (~600 MB / ~108k layers) stays disk-backed; only the tiles within
// STREAM_RADIUS of a player are loaded and materialised into the live navmesh
// (buildNavMeshTilesAt), the rest are removed, so the navmesh stays bounded and
// under the 32-bit polyref budget. Grid params (orig, tileWidth) come from the
// TSET header. Construction obstacles carve natively via the tilecache.
const STREAM_CACHE_DIR =
  process.env.NAV_CACHE_DIR ?? __dirname + "/../../data/2016/collision";
const STREAM_RADIUS = 300; // materialise tiles within this many meters of a player
const STREAM_INTERVAL = 1000; // ms between window updates
const STREAM_CACHE_RECYCLE_LAYERS = 3072;
// Keep compressed layers out of the WebAssembly heap until their columns are
// actually visited. The generated whole-map cache has ~110k layers / ~600 MB;
// preloading all of it leaves too little WASM address space for DetourCrowd and
// eventually corrupts the native heap. This budget covers many distinct player
// windows while keeping the cache bounded to a fraction of the old footprint.
const STREAM_RUNTIME_CACHE_LAYERS = 32768;

export function shouldRecycleStreamingCache(
  currentLayers: number,
  incomingLayers: number,
  recycleThreshold: number = STREAM_CACHE_RECYCLE_LAYERS
): boolean {
  return (
    currentLayers > 0 &&
    incomingLayers > 0 &&
    currentLayers + incomingLayers > recycleThreshold
  );
}

type StreamCachePart = {
  path: string;
  fd: number;
  start: number;
  length: number;
};

type StreamCacheLayer = {
  offset: number;
  length: number;
};

type CrowdOperationTrace = {
  sequence: number;
  operation: string;
  agentIndex?: number;
  position?: [number, number, number];
  detail?: string;
};

type CrowdAgentTrace = {
  kind: "active" | "passive";
  agentIndex: number;
  createdFrom: [number, number, number];
  createdAt: [number, number, number];
  lastMoveTarget?: [number, number, number];
};

export class NavManager {
  navmesh!: NavMesh;
  tilecache!: TileCache;
  obstaclesRequestsPending: number = 0;
  crowd!: Crowd;
  navMeshQuery!: NavMeshQuery;
  lastTimeCall: number = Date.now();
  updateFrequency = 1 / 5;
  obstacleCount = 0;
  private readonly _knownObstacles = new Set<BoxObstacle>();
  private readonly _activeObstacles = new Set<BoxObstacle>();
  // streaming state
  streaming = false;
  private _tcOrigX = 0;
  private _tcOrigZ = 0;
  private _tcTileWidth = 25.6;
  private _loadedCols = new Set<string>(); // materialised tile columns "tx,tz"
  private _cacheLoadedCols = new Set<string>();
  private _streamCacheLayers = new Map<string, StreamCacheLayer[]>();
  private _streamCacheParts: StreamCachePart[] = [];
  private _streamCacheLength = 0;
  private _streamCacheLayerCount = 0;
  private _streamCacheCapacity = STREAM_RUNTIME_CACHE_LAYERS;
  private _streamRuntimeRecycles = 0;
  private _streamMeshConfig?: Parameters<typeof NavMeshParams.create>[0];
  private _streamCacheConfig?: Parameters<
    typeof DetourTileCacheParams.create
  >[0];
  private _streamAllocator?: any;
  private _streamCompressor?: any;
  private _streamMeshProcess?: ReturnType<
    typeof createDefaultTileCacheMeshProcess
  >;
  private _lastStreamMs = 0;
  private _crowdMaxAgents = 2000;
  private _crowdMaxAgentRadius = 2.0;
  private _crowdHealthy = true;
  private _crowdFaultReported = false;
  private _successfulCrowdUpdates = 0;
  private _obstacleUpdatesHealthy = true;
  private _incompleteObstacleUpdateTicks = 0;
  private _obstacleBacklogWarningReported = false;
  private _agentInvalidationHandler?: () => void;
  private _crowdOperationSequence = 0;
  private readonly _recentCrowdOperations: CrowdOperationTrace[] = [];
  private readonly _crowdAgentTraces = new Map<number, CrowdAgentTrace>();
  constructor() {}

  get crowdHealthy(): boolean {
    return this._crowdHealthy;
  }

  get obstacleUpdatesHealthy(): boolean {
    return this._obstacleUpdatesHealthy;
  }

  setAgentInvalidationHandler(handler: () => void): void {
    this._agentInvalidationHandler = handler;
  }

  private traceCrowdOperation(
    operation: string,
    agentIndex?: number,
    position?: Vector3 | Float32Array,
    detail?: string
  ): void {
    const trace: CrowdOperationTrace = {
      sequence: ++this._crowdOperationSequence,
      operation
    };
    if (agentIndex !== undefined) trace.agentIndex = agentIndex;
    if (position) {
      trace.position = [
        Number(position instanceof Float32Array ? position[0] : position.x),
        Number(position instanceof Float32Array ? position[1] : position.y),
        Number(position instanceof Float32Array ? position[2] : position.z)
      ];
    }
    if (detail) trace.detail = detail;
    this._recentCrowdOperations.push(trace);
    if (this._recentCrowdOperations.length > 128) {
      this._recentCrowdOperations.shift();
    }
  }

  private instrumentAgent(
    agent: CrowdAgent,
    kind: "active" | "passive",
    gamePosition: Float32Array,
    navPosition: Vector3
  ): CrowdAgent {
    const agentIndex = agent.agentIndex;
    this._crowdAgentTraces.set(agentIndex, {
      kind,
      agentIndex,
      createdFrom: [gamePosition[0], gamePosition[1], gamePosition[2]],
      createdAt: [navPosition.x, navPosition.y, navPosition.z]
    });
    this.traceCrowdOperation("agent-created", agentIndex, navPosition, kind);

    if (typeof agent.requestMoveTarget !== "function") return agent;
    const originalRequestMoveTarget = agent.requestMoveTarget.bind(agent);
    agent.requestMoveTarget = (position: Vector3): boolean => {
      const trace = this._crowdAgentTraces.get(agentIndex);
      if (trace) {
        trace.lastMoveTarget = [position.x, position.y, position.z];
      }
      this.traceCrowdOperation("move-request", agentIndex, position);
      if (
        !this._crowdHealthy ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(position.z)
      ) {
        this.traceCrowdOperation(
          "move-rejected",
          agentIndex,
          position,
          "unhealthy-or-non-finite"
        );
        return false;
      }
      try {
        return originalRequestMoveTarget(position);
      } catch (error) {
        this.markCrowdFault(error, "move request");
        return false;
      }
    };
    return agent;
  }

  private writeCrowdFaultReport(
    error: unknown,
    operation: string,
    activeAgents: number | string,
    wrapperAgents: number | string
  ): string | undefined {
    if (!this.streaming) return;
    try {
      const logDirectory = join(
        process.env.APPDATA ?? process.cwd(),
        "h1emu",
        "logs"
      );
      mkdirSync(logDirectory, { recursive: true });
      const reportPath = join(
        logDirectory,
        `nav-crowd-fault-${Date.now()}.json`
      );
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            operation,
            error:
              error instanceof Error ? (error.stack ?? error.message) : error,
            activeAgents,
            wrapperAgents,
            loadedColumns: this._loadedCols.size,
            indexedCacheColumns: this._streamCacheLayers.size,
            indexedCacheLayers: [...this._streamCacheLayers.values()].reduce(
              (total, layers) => total + layers.length,
              0
            ),
            runtimeCacheLayers: this._streamCacheLayerCount,
            runtimeCacheCapacity: this._streamCacheCapacity,
            obstacles: this.obstacleCount,
            pendingObstacles: this.obstaclesRequestsPending,
            recentOperations: this._recentCrowdOperations,
            agents: [...this._crowdAgentTraces.values()]
          },
          null,
          2
        )
      );
      return reportPath;
    } catch (reportError) {
      console.error(
        `[NAV] failed to write crowd fault report: ${
          reportError instanceof Error ? reportError.message : reportError
        }`
      );
      return;
    }
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
    const reportPath = this.writeCrowdFaultReport(
      error,
      operation,
      activeAgents,
      wrapperAgents
    );
    this._agentInvalidationHandler?.();
    console.error(
      `[NAV] crowd disabled after ${operation} ` +
        `(active=${activeAgents}, wrappers=${wrapperAgents}): ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }${reportPath ? `\n[NAV] crowd fault report: ${reportPath}` : ""}`
    );
  }

  private readStreamCacheRange(offset: number, length: number): Buffer {
    if (offset < 0 || length < 0 || offset + length > this._streamCacheLength) {
      throw new Error(
        `[NAV] streaming cache read outside store (${offset}+${length}/${this._streamCacheLength})`
      );
    }
    const output = Buffer.allocUnsafe(length);
    let outputOffset = 0;
    let sourceOffset = offset;
    while (outputOffset < length) {
      const part = this._streamCacheParts.find(
        (candidate) =>
          sourceOffset >= candidate.start &&
          sourceOffset < candidate.start + candidate.length
      );
      if (!part) {
        throw new Error(
          `[NAV] streaming cache has no part for offset ${sourceOffset}`
        );
      }
      const localOffset = sourceOffset - part.start;
      const bytesToRead = Math.min(
        length - outputOffset,
        part.length - localOffset
      );
      const bytesRead = readSync(
        part.fd,
        output,
        outputOffset,
        bytesToRead,
        localOffset
      );
      if (bytesRead !== bytesToRead) {
        throw new Error(
          `[NAV] short streaming cache read in ${part.path}: ${bytesRead}/${bytesToRead}`
        );
      }
      outputOffset += bytesRead;
      sourceOffset += bytesRead;
    }
    return output;
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
      this._crowdAgentTraces.clear();
      this.traceCrowdOperation("agents-invalidated");
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

  private processPendingObstacleRequests(): boolean {
    if (
      !this.obstaclesRequestsPending ||
      !this._obstacleUpdatesHealthy ||
      !this._crowdHealthy
    ) {
      return true;
    }

    let upToDate = false;
    let updateFailed = false;
    let updates = 0;
    const mutationSucceeded = this.mutateNavMesh(() => {
      while (!upToDate && updates < MAX_TILE_CACHE_UPDATES_PER_TICK) {
        const result = this.tilecache.update(this.navmesh);
        updates++;
        if (!result.success) {
          updateFailed = true;
          const unsignedStatus = result.status >>> 0;
          console.error(
            `[NAV] tilecache update failed: ${statusToReadableString(result.status)} ` +
              `(status=${result.status}, hex=0x${unsignedStatus.toString(16)}); ` +
              "dynamic obstacle updates disabled"
          );
          break;
        }
        upToDate = result.upToDate;
      }
    });

    this.traceCrowdOperation(
      "tilecache-update",
      undefined,
      undefined,
      `updates=${updates},upToDate=${upToDate},pending=${this.obstaclesRequestsPending}`
    );

    if (!mutationSucceeded || updateFailed) {
      this._obstacleUpdatesHealthy = false;
      this.obstaclesRequestsPending = 0;
      return true;
    }
    if (upToDate) {
      this.obstaclesRequestsPending = 0;
      this._incompleteObstacleUpdateTicks = 0;
      this._obstacleBacklogWarningReported = false;
      return true;
    }

    this._incompleteObstacleUpdateTicks++;
    if (
      !this._obstacleBacklogWarningReported &&
      this._incompleteObstacleUpdateTicks >= TILE_CACHE_BACKLOG_WARNING_TICKS
    ) {
      this._obstacleBacklogWarningReported = true;
      console.warn(
        `[NAV] tilecache rebuild remains pending after ${this._incompleteObstacleUpdateTicks} ticks; ` +
          `work is capped at ${MAX_TILE_CACHE_UPDATES_PER_TICK} updates per tick`
      );
    }
    return false;
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

  private initializeStreamingRuntime(): void {
    if (!this._streamMeshConfig || !this._streamCacheConfig) {
      throw new Error("[NAV] streaming runtime configuration is unavailable");
    }

    const allocator = new (Raw as any).RecastLinearAllocator(1 << 20);
    const compressor = new (Raw as any).RecastFastLZCompressor();
    const meshProcess = createDefaultTileCacheMeshProcess();
    const tilecache = new TileCache();
    if (
      !tilecache.init(
        DetourTileCacheParams.create(this._streamCacheConfig),
        allocator,
        compressor,
        meshProcess
      )
    ) {
      Raw.destroy(allocator);
      Raw.destroy(compressor);
      Raw.destroy(meshProcess.raw);
      throw new Error("[NAV] failed to initialize streaming tilecache");
    }

    const navmesh = new NavMesh();
    if (!navmesh.initTiled(NavMeshParams.create(this._streamMeshConfig))) {
      tilecache.destroy();
      Raw.destroy(allocator);
      Raw.destroy(compressor);
      Raw.destroy(meshProcess.raw);
      throw new Error("[NAV] failed to initialize streaming navmesh");
    }

    this.tilecache = tilecache;
    this.navmesh = navmesh;
    this.navMeshQuery = new NavMeshQuery(navmesh);
    this._streamAllocator = allocator;
    this._streamCompressor = compressor;
    this._streamMeshProcess = meshProcess;
    this.createCrowd();
  }

  private destroyStreamingRuntime(): void {
    this.crowd?.destroy();
    this.navMeshQuery?.destroy();
    this.navmesh?.destroy();
    this.tilecache?.destroy();
    if (this._streamAllocator) Raw.destroy(this._streamAllocator);
    if (this._streamCompressor) Raw.destroy(this._streamCompressor);
    if (this._streamMeshProcess) Raw.destroy(this._streamMeshProcess.raw);
    this._streamAllocator = undefined;
    this._streamCompressor = undefined;
    this._streamMeshProcess = undefined;
  }

  private recycleStreamingRuntime(): void {
    this.destroyStreamingRuntime();
    this._loadedCols.clear();
    this._cacheLoadedCols.clear();
    this._streamCacheLayerCount = 0;
    this.obstaclesRequestsPending = 0;
    this._activeObstacles.clear();
    this._obstacleUpdatesHealthy = true;
    this._incompleteObstacleUpdateTicks = 0;
    this._obstacleBacklogWarningReported = false;
    this.initializeStreamingRuntime();

    this._streamRuntimeRecycles++;
    this.traceCrowdOperation(
      "stream-runtime-recycled",
      undefined,
      undefined,
      `recycles=${this._streamRuntimeRecycles},knownObstacles=${this.obstacleCount}`
    );
    console.log(
      `[NAV] streaming runtime recycled (${this._streamRuntimeRecycles}); ` +
        `${this.obstacleCount} logical obstacles retained`
    );
  }

  // Streaming mode: index the disk-backed compressed TileCache
  // (z1_cache_*.bin, TSET format from h1emu-recast), build an empty tiled
  // navmesh, and load/materialise layers on demand around players.
  private async loadNavStreaming() {
    console.time("[NAV] streaming tilecache loaded");
    await initRecast();
    const dir = STREAM_CACHE_DIR;
    const parts = sortTileCacheParts(
      readdirSync(dir).filter((f) => /^z1_cache_\d+\.bin$/.test(f))
    );
    let storeLength = 0;
    this._streamCacheParts = parts.map((part) => {
      const path = `${dir}/${part}`;
      const length = statSync(path).size;
      const indexedPart = {
        path,
        fd: openSync(path, "r"),
        start: storeLength,
        length
      };
      storeLength += length;
      return indexedPart;
    });
    this._streamCacheLength = storeLength;

    // parse TileCacheSetHeader (magic, version, numTiles, meshParams, cacheParams)
    let o = 0;
    const header = this.readStreamCacheRange(0, 92);
    const rI = () => {
      const v = header.readInt32LE(o);
      o += 4;
      return v;
    };
    const rF = () => {
      const v = header.readFloatLE(o);
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
      maxTiles: Math.min(rI(), STREAM_RUNTIME_CACHE_LAYERS),
      maxObstacles: rI()
    };
    this._tcOrigX = mesh.orig.x;
    this._tcOrigZ = mesh.orig.z;
    this._tcTileWidth = mesh.tileWidth;
    this._streamCacheCapacity = cache.maxTiles;
    this._streamMeshConfig = mesh;
    this._streamCacheConfig = cache;

    // Build a compact JS index over the split TSET files. Only the 28-byte
    // entry/layer headers are inspected; compressed layer payloads remain on
    // disk until streamAround() requests their column.
    let cursor = 92;
    for (let i = 0; i < numTiles; i++) {
      if (cursor + 28 > storeLength) {
        throw new Error(`[NAV] truncated tilecache before layer ${i}`);
      }
      const entryHeader = this.readStreamCacheRange(cursor, 28);
      const dataSize = entryHeader.readInt32LE(4);
      if (dataSize < 20 || cursor + 8 + dataSize > storeLength) {
        throw new Error(
          `[NAV] invalid tilecache layer ${i} size ${dataSize} at offset ${cursor + 8}`
        );
      }
      const tx = entryHeader.readInt32LE(16);
      const tz = entryHeader.readInt32LE(20);
      const key = `${tx},${tz}`;
      const layers = this._streamCacheLayers.get(key) ?? [];
      layers.push({ offset: cursor + 8, length: dataSize });
      this._streamCacheLayers.set(key, layers);
      cursor += 8 + dataSize;
    }
    if (cursor !== storeLength) {
      throw new Error(
        `[NAV] tilecache has ${storeLength - cursor} trailing bytes`
      );
    }

    this._crowdMaxAgents = 1000;
    this._crowdMaxAgentRadius = 2.5;
    this.initializeStreamingRuntime();
    this.streaming = true;
    console.timeEnd("[NAV] streaming tilecache loaded");
    console.log(
      `[NAV] streaming tilecache ready (${numTiles} layers indexed, ` +
        `${(storeLength / 1048576) | 0} MB disk-backed, ` +
        `${this._streamCacheCapacity} layer runtime budget)`
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
    const validPositions = positions.filter(
      (position) => Number.isFinite(position[0]) && Number.isFinite(position[2])
    );
    if (positions.length && !validPositions.length) {
      this.traceCrowdOperation(
        "stream-rejected",
        undefined,
        undefined,
        "all player positions were non-finite"
      );
      return false;
    }
    for (const p of validPositions) {
      const cx = Math.floor((p[0] - this._tcOrigX) / tw),
        cz = Math.floor((p[2] - this._tcOrigZ) / tw);
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const key = `${cx + dx},${cz + dz}`;
          if (this._streamCacheLayers.has(key)) want.add(key);
        }
      }
    }
    let toRemove = [...this._loadedCols].filter((k) => !want.has(k));
    let toAdd = [...want].filter((k) => !this._loadedCols.has(k));
    if (!toRemove.length && !toAdd.length) return false;
    const incomingCacheLayers = toAdd.reduce(
      (total, key) =>
        total +
        (this._cacheLoadedCols.has(key)
          ? 0
          : (this._streamCacheLayers.get(key)?.length ?? 0)),
      0
    );
    const recycleRuntime = shouldRecycleStreamingCache(
      this._streamCacheLayerCount,
      incomingCacheLayers
    );
    if (recycleRuntime) {
      toRemove = [];
      toAdd = [...want];
    }
    this.traceCrowdOperation(
      "stream-mutation",
      undefined,
      undefined,
      `add=${toAdd.length},remove=${toRemove.length},players=${validPositions.length},recycle=${recycleRuntime}`
    );
    let removed = 0;
    let added = 0;
    const success = this.mutateNavMesh(() => {
      if (recycleRuntime) this.recycleStreamingRuntime();
      // unload columns outside the window
      for (const k of toRemove) {
        const [tx, tz] = k.split(",").map(Number);
          const authoredLayerCount = this._streamCacheLayers.get(k)?.length ?? 0;
          const res = this.navmesh.getTilesAt(
            tx,
            tz,
            Math.max(8, authoredLayerCount)
          );
          for (let i = 0; i < res.tileCount(); i++) {
            const ref = this.navmesh.getTileRef(res.tiles(i));
            if (ref) {
              runRuntimePhase("nav-mesh-remove-tile", () =>
                this.navmesh.removeTile(ref)
              );
            }
          }
        this._loadedCols.delete(k);
        removed++;
      }
      // materialise columns entering the window; obstacles already registered
      // in the tilecache are carved in by buildNavMeshTilesAt
      for (const k of toAdd) {
        const [tx, tz] = k.split(",").map(Number);
        if (!this._cacheLoadedCols.has(k)) {
          const layers = this._streamCacheLayers.get(k) ?? [];
          if (
            this._streamCacheLayerCount + layers.length >
            this._streamCacheCapacity
          ) {
            console.error(
              `[NAV] streaming cache layer budget exhausted at ${this._streamCacheLayerCount}/` +
                `${this._streamCacheCapacity}; refusing column ${k} instead of risking WASM corruption`
            );
            continue;
          }
          const FREE = (Raw.Detour as any).DT_COMPRESSEDTILE_FREE_DATA ?? 1;
          let columnLoaded = true;
          for (const layer of layers) {
            const bytes = this.readStreamCacheRange(layer.offset, layer.length);
            const arr = new UnsignedCharArray();
            arr.copy(bytes);
            const result = runRuntimePhase("nav-cache-add-layer", () =>
              this.tilecache.addTile(arr, FREE)
            );
            if (!statusSucceed(result.status)) {
              columnLoaded = false;
              console.error(
                `[NAV] failed to load streamed layer for ${k}: ` +
                  statusToReadableString(result.status)
              );
              break;
            }
            this._streamCacheLayerCount++;
          }
          if (!columnLoaded) continue;
          this._cacheLoadedCols.add(k);
        }
        runRuntimePhase("nav-cache-build-column", () =>
          this.tilecache.buildNavMeshTilesAt(tx, tz, this.navmesh)
        );
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
    if (success) this.syncStreamedObstacles();
    return success;
  }

  isPositionStreamed(
    gamePos: Float32Array,
    horizontalExtent: number = 10
  ): boolean {
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
    // A spawn may sit inside a solid prop/room column which has no compressed
    // nav layer of its own, while its nearest walkable polygon is in an
    // adjacent loaded column. Match the horizontal extent used by our
    // nearest-poly queries instead of deferring that agent forever.
    const columnRadius = Math.ceil(
      Math.max(0, horizontalExtent) / this._tcTileWidth
    );
    for (let dx = -columnRadius; dx <= columnRadius; dx++) {
      for (let dz = -columnRadius; dz <= columnRadius; dz++) {
        if (this._loadedCols.has(`${tx + dx},${tz + dz}`)) return true;
      }
    }
    return false;
  }

  removeAgent(agent: CrowdAgent): void {
    if (!this._crowdHealthy) return;
    try {
      this.traceCrowdOperation("agent-removed", agent.agentIndex);
      runRuntimePhase("nav-agent-remove", () =>
        this.crowd.removeAgent(agent)
      );
      this._crowdAgentTraces.delete(agent.agentIndex);
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

  private isObstacleInStreamWindow(obstacle: BoxObstacle): boolean {
    if (!this.streaming) return true;
    if (this._tcTileWidth <= 0) return false;
    const minTx = Math.floor(
      (obstacle.position.x - obstacle.halfExtents.x - this._tcOrigX) /
        this._tcTileWidth
    );
    const maxTx = Math.floor(
      (obstacle.position.x + obstacle.halfExtents.x - this._tcOrigX) /
        this._tcTileWidth
    );
    const minTz = Math.floor(
      (obstacle.position.z - obstacle.halfExtents.z - this._tcOrigZ) /
        this._tcTileWidth
    );
    const maxTz = Math.floor(
      (obstacle.position.z + obstacle.halfExtents.z - this._tcOrigZ) /
        this._tcTileWidth
    );
    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let tz = minTz; tz <= maxTz; tz++) {
        if (this._loadedCols.has(`${tx},${tz}`)) return true;
      }
    }
    return false;
  }

  private syncStreamedObstacles(): void {
    if (
      !this.streaming ||
      !this._obstacleUpdatesHealthy ||
      this.obstaclesRequestsPending ||
      !this._loadedCols.size
    ) {
      return;
    }

    let queued = 0;
    for (const obstacle of this._activeObstacles) {
      if (
        this._knownObstacles.has(obstacle) &&
        this.isObstacleInStreamWindow(obstacle)
      ) {
        continue;
      }
      const result = this.tilecache.removeObstacle(obstacle);
      if (!result.success) continue;
      this._activeObstacles.delete(obstacle);
      this.obstaclesRequestsPending++;
      if (++queued >= MAX_PENDING_OBSTACLE) return;
    }
    if (queued) return;

    for (const obstacle of this._knownObstacles) {
      if (
        this._activeObstacles.has(obstacle) ||
        !this.isObstacleInStreamWindow(obstacle)
      ) {
        continue;
      }
      const result = this.tilecache.addBoxObstacle(
        obstacle.position,
        obstacle.halfExtents,
        obstacle.angle
      );
      if (!result.success) return;
      Object.assign(obstacle, result.obstacle);
      this.tilecache.obstacles.set(obstacle.ref, obstacle);
      this._activeObstacles.add(obstacle);
      this.obstaclesRequestsPending++;
      if (++queued >= MAX_PENDING_OBSTACLE) return;
    }
  }

  removeObstacle(obstacle: BoxObstacle) {
    if (!this._knownObstacles.delete(obstacle)) return;
    this.obstacleCount--;
    if (this.streaming) {
      this.syncStreamedObstacles();
      return;
    }
    if (!this._activeObstacles.delete(obstacle)) return;
    if (this._obstacleUpdatesHealthy) {
      const result = this.tilecache.removeObstacle(obstacle);
      if (result.success) this.obstaclesRequestsPending++;
    }
  }

  addObstacle(
    position: Float32Array,
    halfExtents: Vector3,
    yRotation: number = 0.0
  ) {
    if (this.obstacleCount >= MAX_OBSTACLE) {
      return null;
    }
    if (!this._obstacleUpdatesHealthy) return null;
    const navPosition = NavManager.gameToNav(position);
    if (this.streaming) {
      const obstacle: BoxObstacle = {
        type: "box",
        ref: 0,
        position: navPosition,
        halfExtents,
        angle: yRotation
      };
      this._knownObstacles.add(obstacle);
      this.obstacleCount++;
      this.syncStreamedObstacles();
      return obstacle;
    }
    if (this.obstaclesRequestsPending >= MAX_PENDING_OBSTACLE) {
      if (!this.processPendingObstacleRequests()) return null;
    }
    const { success, obstacle } = this.tilecache.addBoxObstacle(
      navPosition,
      halfExtents,
      yRotation
    );
    if (success) {
      this.obstaclesRequestsPending++;
      this.obstacleCount++;
      this._knownObstacles.add(obstacle);
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

  private findNearestPolyOnFloor(
    gamePos: Float32Array,
    horizontalExtent: number = 10
  ) {
    return runRuntimePhase("nav-nearest-poly", () =>
      this.navMeshQuery.findNearestPoly(NavManager.gameToNav(gamePos), {
        halfExtents: {
          x: horizontalExtent,
          y: MAX_ACTIVE_AGENT_VERTICAL_SNAP,
          z: horizontalExtent
        }
      })
    );
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
      runRuntimePhase("nav-obstacle-update", () =>
        this.processPendingObstacleRequests()
      );
    }
    runRuntimePhase("nav-streamed-obstacles", () =>
      this.syncStreamedObstacles()
    );
    debug(
      `requests: ${this.obstaclesRequestsPending}, total: ${this.tilecache.obstacles.size}`
    );
    this.lastTimeCall = now;
    if (!this._crowdHealthy) return;
    try {
      runRuntimePhase("nav-crowd-update", () =>
        this.crowd.update(this.updateFrequency, timeSinceLastCalled, 1)
      );
      if (++this._successfulCrowdUpdates >= 25) {
        this._crowdFaultReported = false;
      }
    } catch (error) {
      this.markCrowdFault(error, "update");
    }
  }

  // Returns the nearest navmesh point on the entity's current floor. Interiors
  // such as PV PD have floors only ~3.2m apart, so a tall nearest-poly search
  // can silently select the story above or below.
  getClosestNavPointVec3(gamePos: Float32Array): Vector3 {
    const n = this.findNearestPolyOnFloor(gamePos);
    debug(
      `getClosestNavPoint gameIn=[${gamePos[0].toFixed(2)}, ${gamePos[1].toFixed(2)}, ${gamePos[2].toFixed(2)}] navOut=[${n.nearestPoint.x.toFixed(2)}, ${n.nearestPoint.y.toFixed(2)}, ${n.nearestPoint.z.toFixed(2)}] polyRef=${n.nearestRef}`
    );
    return n.nearestPoint;
  }

  // Nearest walkable floor Y (game coords) under the given position, or null if
  // no polygon is found. Last-resort fallback when neither the structure BVH
  // (CollisionManager.groundRaycast) nor the terrain heightmap yields a height.
  getFloorY(gamePos: Float32Array): number | null {
    const { nearestRef, nearestPoint } = this.findNearestPolyOnFloor(
      gamePos,
      2
    );
    if (!nearestRef) return null;
    const res = this.navMeshQuery.getPolyHeight(nearestRef, nearestPoint);
    return res.success && Number.isFinite(res.height) ? res.height : null;
  }

  createAgent(gamePos: Float32Array): CrowdAgent | undefined {
    // In streaming mode the navmesh only exists around players; if no tile is
    // loaded under this spawn point yet, defer (caller retries when it loads)
    // instead of placing the agent at a garbage position.
    if (
      !this._crowdHealthy ||
      !Number.isFinite(gamePos[0]) ||
      !Number.isFinite(gamePos[1]) ||
      !Number.isFinite(gamePos[2]) ||
      !this.isPositionStreamed(gamePos)
    ) {
      return undefined;
    }
    try {
      const { nearestRef, nearestPoint } = this.findNearestPolyOnFloor(gamePos);
      if (!nearestRef) return undefined;
      const navPosition = nearestPoint;
      if (
        !Number.isFinite(navPosition.x) ||
        !Number.isFinite(navPosition.y) ||
        !Number.isFinite(navPosition.z) ||
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
      const agent = runRuntimePhase("nav-agent-add", () =>
        this.crowd.addAgent(navPosition, {
          radius: 0.3,
          height: 2,
          maxAcceleration: 1.0,
          maxSpeed: 1.0,
          collisionQueryRange: 2.0,
          pathOptimizationRange: 4.0,
          separationWeight: 2.0
        })
      );
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
      return this.instrumentAgent(agent, "active", gamePos, navPosition);
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
    if (
      !this._crowdHealthy ||
      !Number.isFinite(gamePos[0]) ||
      !Number.isFinite(gamePos[1]) ||
      !Number.isFinite(gamePos[2]) ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      !this.isPositionStreamed(gamePos)
    ) {
      return undefined;
    }
    try {
      const { nearestRef, nearestPoint } = this.findNearestPolyOnFloor(gamePos);
      if (
        !nearestRef ||
        !Number.isFinite(nearestPoint.x) ||
        !Number.isFinite(nearestPoint.y) ||
        !Number.isFinite(nearestPoint.z)
      ) {
        return undefined;
      }
      const agent = runRuntimePhase("nav-agent-add", () =>
        this.crowd.addAgent(nearestPoint, {
          radius,
          height: 2,
          maxAcceleration: 0,
          maxSpeed: 0,
          collisionQueryRange: radius * 2,
          pathOptimizationRange: 0,
          separationWeight: 1,
          updateFlags: 0
        })
      );
      if (
        !Number.isInteger(agent.agentIndex) ||
        agent.agentIndex < 0 ||
        agent.agentIndex >= this._crowdMaxAgents
      ) {
        delete this.crowd.agents[String(agent.agentIndex)];
        return undefined;
      }
      return this.instrumentAgent(agent, "passive", gamePos, nearestPoint);
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
    if (
      !this._crowdHealthy ||
      !Number.isFinite(gamePos[0]) ||
      !Number.isFinite(gamePos[1]) ||
      !Number.isFinite(gamePos[2]) ||
      !this.isPositionStreamed(gamePos)
    ) {
      return false;
    }
    try {
      const { nearestRef, nearestPoint } = this.findNearestPolyOnFloor(gamePos);
      if (
        !nearestRef ||
        !Number.isFinite(nearestPoint.x) ||
        !Number.isFinite(nearestPoint.y) ||
        !Number.isFinite(nearestPoint.z)
      ) {
        return false;
      }
      this.traceCrowdOperation(
        "agent-teleport",
        agent.agentIndex,
        nearestPoint
      );
      runRuntimePhase("nav-agent-teleport", () =>
        agent.teleport(nearestPoint)
      );
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
