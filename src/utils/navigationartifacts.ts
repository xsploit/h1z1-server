// ======================================================================
//
//   GNU GENERAL PUBLIC LICENSE
//   Version 3, 29 June 2007
//   copyright (C) 2021 - 2026 H1emu community
//
// ======================================================================

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const NAVIGATION_ARTIFACT_SCHEMA_VERSION = 1;
export const NAVIGATION_ARTIFACT_MANIFEST = "navigation-artifact-manifest.json";

export interface NavigationArtifactFile {
  path: string;
  size: number;
  sha256: string;
}

export interface NavigationArtifactSourceFile {
  name: string;
  size: number;
  sha256: string;
}

export type NavigationCacheCoverage =
  | { kind: "full" }
  | {
      kind: "regional";
      bounds: {
        minX: number;
        minZ: number;
        maxX: number;
        maxZ: number;
      };
    };

export interface NavigationCacheMergeReportSnapshot {
  schema: "h1emu-navigation-cache-merge-v1";
  schemaVersion: 1;
  mode: "regional-overlay";
  tool: {
    name: string;
    version: string;
    commit: string;
  };
  base: {
    artifactId: string;
    manifestSha256: string;
    cacheParts: NavigationArtifactFile[];
  };
  regional: {
    artifactId: string;
    manifestSha256: string;
    cacheParts: NavigationArtifactFile[];
  };
  output: {
    cacheParts: NavigationArtifactFile[];
    collision: NavigationArtifactFile;
    heightmap: NavigationArtifactFile;
    navigationMetadata: NavigationArtifactFile;
    semantics: NavigationArtifactFile | null;
    transitions: NavigationArtifactFile;
  };
}

export interface NavigationCacheCompositionProvenance {
  schema: "h1emu-navigation-cache-composition-v1";
  base: {
    manifest: NavigationArtifactFile;
    snapshot: NavigationArtifactManifest;
  };
  regional: {
    manifest: NavigationArtifactFile;
    snapshot: NavigationArtifactManifest;
  };
  mergeReport: NavigationArtifactFile & NavigationCacheMergeReportSnapshot;
}

export interface CollisionSemanticSourceInput {
  file: string;
  sha256: string;
}

export interface CollisionSemanticSourceReport {
  file: NavigationArtifactFile;
  schema: "h1emu-collision-semantic-obj-v1";
  semanticContract: "h1emu-nav-semantics-v1";
  /** Optional only for legacy runtime-only source reports. */
  semanticMode?: "per-triangle-h1sem1" | "legacy-actor-diagnostic";
  coordinateSpace: "h1z1-world-y-up-meters";
  sourceStrategy: string;
  renderGeometryMerged: boolean;
  bounds: {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
  };
  terrainStep: number;
  output: CollisionSemanticSourceInput;
  inputs: {
    heightmap: CollisionSemanticSourceInput;
    collision: CollisionSemanticSourceInput;
    collisionMetadata:
      | (CollisionSemanticSourceInput & {
          matched: boolean;
        })
      | null;
    collisionInstanceIds?:
      | (CollisionSemanticSourceInput & {
          matched: boolean;
        })
      | null;
    collisionTriangleSemantics?:
      | (CollisionSemanticSourceInput & {
          matched: boolean;
          format: "H1SEM1-u8le-v1";
        })
      | null;
    collisionSemanticPolicy?:
      | (CollisionSemanticSourceInput & {
          matched: boolean;
          schema: "h1emu-h1col2-semantic-policy-v1";
          canonical: boolean;
        })
      | null;
  };
  collisionMetadataMatched: boolean;
  limitations: string[];
}

export interface NavigationSemanticBakeReport {
  schemaVersion: number;
  /** Artifact-bound source/output evidence, mandatory in schema v2. */
  inputName?: string;
  inputBytes?: number;
  inputSha256?: string;
  artifacts?: NavigationSemanticBakeArtifact[];
  semanticContract: "h1emu-nav-semantics-v1";
  semanticInput: boolean;
  legacyObjectFallback: boolean;
  /** Present in current strict reports; optional only for legacy runtime-only bundles. */
  dynamicDoorObstaclesAcknowledged?: boolean;
  /** True only when both direct and TileCache baked-semantic inspection passed. */
  bakedSemanticsVerified?: boolean;
  sourceTriangles: number;
  keptTriangles: number;
  excludedTriangles: number;
  fallbackTriangles: number;
  ordinaryMaterialTriangles: number;
  materials: Record<string, number>;
  warnings: string[];
}

export interface NavigationSemanticBakeArtifact {
  role: "navmesh" | "tilecache";
  file: string;
  bytes: number;
  sha256: string;
  /** Legacy FNV identity retained as diagnostic evidence when emitted. */
  identity?: string;
}

export interface NavigationTsetHeader {
  version: number;
  layers: number;
  meshOrigin: [number, number, number];
  tileWidth: number;
  tileHeight: number;
  meshMaxTiles: number;
  meshMaxPolys: number;
  cacheOrigin: [number, number, number];
  cellSize: number;
  cellHeight: number;
  tileVoxels: [number, number];
  walkableHeight: number;
  walkableRadius: number;
  walkableClimb: number;
  maxSimplificationError: number;
  cacheMaxTiles: number;
  cacheMaxObstacles: number;
}

export interface NavigationArtifactManifest {
  schemaVersion: 1;
  artifactId: string;
  provenance: {
    status: "complete" | "runtime-only";
    extractorCommit: string | null;
    recastCommit: string | null;
    recastNavigationCommit: string | null;
    sourceWorld: NavigationArtifactSourceFile | null;
    classifierConfig: NavigationArtifactSourceFile | null;
    /** Direct Recast navmesh outputs retained as verified bake evidence. */
    bakeNavmeshParts?: NavigationArtifactFile[] | null;
    /** Optional for backward-compatible runtime-only manifests; mandatory for complete provenance. */
    sourceReport?: CollisionSemanticSourceReport | null;
    /** Complete provenance for a full cache assembled from verified full and regional artifacts. */
    composition?: NavigationCacheCompositionProvenance | null;
  };
  runtime: {
    cache: {
      format: "TSET";
      parts: NavigationArtifactFile[];
      header: NavigationTsetHeader;
      /** Required for artifacts used as inputs to a cache composition. */
      coverage?: NavigationCacheCoverage;
    };
    collision: {
      file: NavigationArtifactFile;
      format: "H1COL2";
      version: number;
      meshCount: number;
      instanceCount: number;
    } | null;
    heightmap: {
      file: NavigationArtifactFile;
      format: "PNG";
      width: number;
      height: number;
    } | null;
    navigationMetadata: {
      file: NavigationArtifactFile;
      schemaVersion: number;
      instanceCount: number;
      kinds: Record<string, number>;
      semanticMode?: "strict" | "legacy";
      bakedDoorGeometryExcluded?: boolean;
    } | null;
    semantics:
      | (NavigationSemanticBakeReport & {
          file: NavigationArtifactFile;
        })
      | null;
    transitions: {
      file: NavigationArtifactFile;
      count: number;
    } | null;
  };
}

export interface VerifiedNavigationArtifact {
  manifest: NavigationArtifactManifest;
  manifestPath: string;
  filesVerified: number;
  bytesVerified: number;
}

export function assertNavigationRuntimeConfiguration(
  manifest: NavigationArtifactManifest,
  dynamicDoorObstacles = process.env.H1EMU_DYNAMIC_DOOR_OBSTACLES
): void {
  if (
    manifest.provenance.status === "complete" &&
    manifest.runtime.navigationMetadata?.bakedDoorGeometryExcluded === true &&
    dynamicDoorObstacles !== "1"
  ) {
    throw new Error(
      "[NAV] complete artifact excludes door panels but H1EMU_DYNAMIC_DOOR_OBSTACLES=1 is not set"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseArtifactFileRecord(
  value: unknown,
  label: string
): NavigationArtifactFile {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`[NAV] ${label} contains an invalid file record`);
  }
  return {
    path: value.path,
    size: value.size as number,
    sha256: value.sha256
  };
}

function parseArtifactSourceFile(
  value: unknown,
  label: string
): NavigationArtifactSourceFile {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`[NAV] ${label} contains an invalid source file record`);
  }
  return {
    name: value.name,
    size: value.size as number,
    sha256: value.sha256
  };
}

function parseCacheCoverage(value: unknown): NavigationCacheCoverage {
  if (
    !isRecord(value) ||
    (value.kind !== "full" && value.kind !== "regional")
  ) {
    throw new Error("[NAV] artifact cache has invalid coverage provenance");
  }
  if (value.kind === "full") return { kind: "full" };
  const bounds = value.bounds;
  if (
    !isRecord(bounds) ||
    !["minX", "minZ", "maxX", "maxZ"].every(
      (field) =>
        typeof bounds[field] === "number" && Number.isFinite(bounds[field])
    ) ||
    (bounds.minX as number) >= (bounds.maxX as number) ||
    (bounds.minZ as number) >= (bounds.maxZ as number)
  ) {
    throw new Error("[NAV] regional cache coverage has invalid bounds");
  }
  return {
    kind: "regional",
    bounds: {
      minX: bounds.minX as number,
      minZ: bounds.minZ as number,
      maxX: bounds.maxX as number,
      maxZ: bounds.maxZ as number
    }
  };
}

function parseMergeInput(
  value: unknown,
  label: string
): NavigationCacheMergeReportSnapshot["base"] {
  if (
    !isRecord(value) ||
    !isSha256(value.artifactId) ||
    !isSha256(value.manifestSha256) ||
    !Array.isArray(value.cacheParts) ||
    value.cacheParts.length === 0
  ) {
    throw new Error(`[NAV] cache merge report has invalid ${label} input`);
  }
  return {
    artifactId: value.artifactId,
    manifestSha256: value.manifestSha256,
    cacheParts: value.cacheParts.map((entry, index) =>
      parseArtifactFileRecord(entry, `${label} cache part ${index}`)
    )
  };
}

export function parseNavigationCacheMergeReport(
  value: unknown
): NavigationCacheMergeReportSnapshot {
  if (!isRecord(value)) {
    throw new Error("[NAV] navigation cache merge report must be an object");
  }
  if (
    value.schema !== "h1emu-navigation-cache-merge-v1" ||
    value.schemaVersion !== 1 ||
    value.mode !== "regional-overlay"
  ) {
    throw new Error(
      `[NAV] unsupported navigation cache merge report ${String(value.schema)}`
    );
  }
  if (
    !isRecord(value.tool) ||
    typeof value.tool.name !== "string" ||
    value.tool.name.length === 0 ||
    typeof value.tool.version !== "string" ||
    value.tool.version.length === 0 ||
    typeof value.tool.commit !== "string" ||
    !/^[a-f0-9]{7,64}$/.test(value.tool.commit)
  ) {
    throw new Error("[NAV] cache merge report has invalid tool provenance");
  }
  if (!isRecord(value.output) || !Array.isArray(value.output.cacheParts)) {
    throw new Error("[NAV] cache merge report has invalid output");
  }
  const outputCacheParts = value.output.cacheParts.map((entry, index) =>
    parseArtifactFileRecord(entry, `output cache part ${index}`)
  );
  if (!outputCacheParts.length) {
    throw new Error("[NAV] cache merge report output contains no cache parts");
  }
  return {
    schema: "h1emu-navigation-cache-merge-v1",
    schemaVersion: 1,
    mode: "regional-overlay",
    tool: {
      name: value.tool.name,
      version: value.tool.version,
      commit: value.tool.commit
    },
    base: parseMergeInput(value.base, "base"),
    regional: parseMergeInput(value.regional, "regional"),
    output: {
      cacheParts: outputCacheParts,
      collision: parseArtifactFileRecord(
        value.output.collision,
        "output collision"
      ),
      heightmap: parseArtifactFileRecord(
        value.output.heightmap,
        "output heightmap"
      ),
      navigationMetadata: parseArtifactFileRecord(
        value.output.navigationMetadata,
        "output navigation metadata"
      ),
      semantics:
        value.output.semantics === null
          ? null
          : parseArtifactFileRecord(
              value.output.semantics,
              "output semantic report"
            ),
      transitions: parseArtifactFileRecord(
        value.output.transitions,
        "output transitions"
      )
    }
  };
}

function parseSourceInput(
  value: unknown,
  label: string
): CollisionSemanticSourceInput {
  if (
    !isRecord(value) ||
    typeof value.file !== "string" ||
    value.file.length === 0 ||
    !isSha256(value.sha256)
  ) {
    throw new Error(`[NAV] source report has invalid ${label} input`);
  }
  return { file: value.file, sha256: value.sha256 };
}

export function parseCollisionSemanticSourceReport(
  value: unknown
): Omit<CollisionSemanticSourceReport, "file"> {
  if (!isRecord(value)) {
    throw new Error("[NAV] collision semantic source report must be an object");
  }
  if (value.schema !== "h1emu-collision-semantic-obj-v1") {
    throw new Error(
      `[NAV] unsupported collision semantic source report ${String(value.schema)}`
    );
  }
  const bounds = value.bounds;
  const inputs = value.inputs;
  if (
    value.semanticContract !== "h1emu-nav-semantics-v1" ||
    (value.semanticMode !== undefined &&
      value.semanticMode !== "per-triangle-h1sem1" &&
      value.semanticMode !== "legacy-actor-diagnostic") ||
    value.coordinateSpace !== "h1z1-world-y-up-meters" ||
    typeof value.sourceStrategy !== "string" ||
    value.sourceStrategy.length === 0 ||
    typeof value.renderGeometryMerged !== "boolean" ||
    !isRecord(bounds) ||
    !["minX", "minZ", "maxX", "maxZ"].every(
      (field) =>
        typeof bounds[field] === "number" && Number.isFinite(bounds[field])
    ) ||
    (bounds.minX as number) >= (bounds.maxX as number) ||
    (bounds.minZ as number) >= (bounds.maxZ as number) ||
    typeof value.terrainStep !== "number" ||
    !Number.isFinite(value.terrainStep) ||
    value.terrainStep <= 0 ||
    !isRecord(inputs) ||
    !Array.isArray(value.limitations) ||
    !value.limitations.every(
      (limitation) => typeof limitation === "string" && limitation.length > 0
    )
  ) {
    throw new Error("[NAV] collision semantic source report is invalid");
  }
  const heightmap = parseSourceInput(inputs.heightmap, "heightmap");
  const collision = parseSourceInput(inputs.collision, "collision");
  const output = parseSourceInput(value.output, "output");
  let collisionMetadata: CollisionSemanticSourceReport["inputs"]["collisionMetadata"] =
    null;
  if (inputs.collisionMetadata !== null) {
    const input = parseSourceInput(
      inputs.collisionMetadata,
      "collisionMetadata"
    );
    if (
      !isRecord(inputs.collisionMetadata) ||
      typeof inputs.collisionMetadata.matched !== "boolean"
    ) {
      throw new Error(
        "[NAV] source report has invalid collisionMetadata matched state"
      );
    }
    collisionMetadata = {
      ...input,
      matched: inputs.collisionMetadata.matched
    };
  }
  const collisionMetadataMatched = collisionMetadata?.matched === true;
  if (
    value.collisionMetadataMatched !== undefined &&
    value.collisionMetadataMatched !== collisionMetadataMatched
  ) {
    throw new Error(
      "[NAV] source report collisionMetadata matched state is inconsistent"
    );
  }
  const parseMatchedSource = (
    raw: unknown,
    label: string
  ): (CollisionSemanticSourceInput & { matched: boolean }) | null => {
    if (raw === null || raw === undefined) return null;
    const input = parseSourceInput(raw, label);
    if (!isRecord(raw) || typeof raw.matched !== "boolean") {
      throw new Error(`[NAV] source report has invalid ${label} matched state`);
    }
    return { ...input, matched: raw.matched };
  };
  const collisionInstanceIds = parseMatchedSource(
    inputs.collisionInstanceIds,
    "collisionInstanceIds"
  );
  const triangleInput = parseMatchedSource(
    inputs.collisionTriangleSemantics,
    "collisionTriangleSemantics"
  );
  let collisionTriangleSemantics: CollisionSemanticSourceReport["inputs"]["collisionTriangleSemantics"] =
    null;
  if (triangleInput) {
    if (
      !isRecord(inputs.collisionTriangleSemantics) ||
      inputs.collisionTriangleSemantics.format !== "H1SEM1-u8le-v1"
    ) {
      throw new Error(
        "[NAV] source report has invalid collisionTriangleSemantics format"
      );
    }
    collisionTriangleSemantics = {
      ...triangleInput,
      format: "H1SEM1-u8le-v1"
    };
  }
  const policyInput = parseMatchedSource(
    inputs.collisionSemanticPolicy,
    "collisionSemanticPolicy"
  );
  let collisionSemanticPolicy: CollisionSemanticSourceReport["inputs"]["collisionSemanticPolicy"] =
    null;
  if (policyInput) {
    if (
      !isRecord(inputs.collisionSemanticPolicy) ||
      inputs.collisionSemanticPolicy.schema !==
        "h1emu-h1col2-semantic-policy-v1" ||
      typeof inputs.collisionSemanticPolicy.canonical !== "boolean"
    ) {
      throw new Error(
        "[NAV] source report has invalid collisionSemanticPolicy contract"
      );
    }
    collisionSemanticPolicy = {
      ...policyInput,
      schema: "h1emu-h1col2-semantic-policy-v1",
      canonical: inputs.collisionSemanticPolicy.canonical
    };
  }
  const parsedInputs: CollisionSemanticSourceReport["inputs"] = {
    heightmap,
    collision,
    collisionMetadata
  };
  if (Object.hasOwn(inputs, "collisionInstanceIds")) {
    parsedInputs.collisionInstanceIds = collisionInstanceIds;
  }
  if (Object.hasOwn(inputs, "collisionTriangleSemantics")) {
    parsedInputs.collisionTriangleSemantics = collisionTriangleSemantics;
  }
  if (Object.hasOwn(inputs, "collisionSemanticPolicy")) {
    parsedInputs.collisionSemanticPolicy = collisionSemanticPolicy;
  }
  return {
    schema: "h1emu-collision-semantic-obj-v1",
    semanticContract: "h1emu-nav-semantics-v1",
    semanticMode: value.semanticMode,
    coordinateSpace: "h1z1-world-y-up-meters",
    sourceStrategy: value.sourceStrategy,
    renderGeometryMerged: value.renderGeometryMerged,
    bounds: {
      minX: bounds.minX as number,
      minZ: bounds.minZ as number,
      maxX: bounds.maxX as number,
      maxZ: bounds.maxZ as number
    },
    terrainStep: value.terrainStep,
    output,
    inputs: parsedInputs,
    collisionMetadataMatched,
    limitations: [...value.limitations]
  };
}

export function parseNavigationSemanticBakeReport(
  value: unknown
): NavigationSemanticBakeReport {
  if (!isRecord(value)) {
    throw new Error("[NAV] semantic bake report must be an object");
  }
  const integerFields = [
    "schemaVersion",
    "sourceTriangles",
    "keptTriangles",
    "excludedTriangles",
    "fallbackTriangles",
    "ordinaryMaterialTriangles"
  ] as const;
  if (
    value.semanticContract !== "h1emu-nav-semantics-v1" ||
    typeof value.semanticInput !== "boolean" ||
    typeof value.legacyObjectFallback !== "boolean" ||
    !integerFields.every(
      (field) =>
        Number.isSafeInteger(value[field]) && (value[field] as number) >= 0
    ) ||
    !isRecord(value.materials) ||
    !Object.values(value.materials).every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0
    ) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string") ||
    (value.dynamicDoorObstaclesAcknowledged !== undefined &&
      typeof value.dynamicDoorObstaclesAcknowledged !== "boolean") ||
    (value.bakedSemanticsVerified !== undefined &&
      typeof value.bakedSemanticsVerified !== "boolean")
  ) {
    throw new Error("[NAV] semantic bake report is invalid");
  }
  let artifactEvidence:
    | Pick<
        NavigationSemanticBakeReport,
        "inputName" | "inputBytes" | "inputSha256" | "artifacts"
      >
    | undefined;
  if (value.schemaVersion === 2) {
    if (
      typeof value.inputName !== "string" ||
      value.inputName.length === 0 ||
      /[\\/]/.test(value.inputName) ||
      !Number.isSafeInteger(value.inputBytes) ||
      (value.inputBytes as number) < 0 ||
      !isSha256(value.inputSha256) ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length === 0
    ) {
      throw new Error(
        "[NAV] schema-v2 semantic bake report has invalid artifact evidence"
      );
    }
    const seenFiles = new Set<string>();
    const artifacts = value.artifacts.map((entry, index) => {
      if (
        !isRecord(entry) ||
        (entry.role !== "navmesh" && entry.role !== "tilecache") ||
        typeof entry.file !== "string" ||
        entry.file.length === 0 ||
        /[\\/]/.test(entry.file) ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 0 ||
        !isSha256(entry.sha256) ||
        (entry.identity !== undefined &&
          (typeof entry.identity !== "string" ||
            !/^fnv1a64:[a-f0-9]{16}$/.test(entry.identity)))
      ) {
        throw new Error(
          `[NAV] schema-v2 semantic bake report artifact ${index} is invalid`
        );
      }
      const foldedFile = entry.file.toLowerCase();
      if (seenFiles.has(foldedFile)) {
        throw new Error(
          `[NAV] schema-v2 semantic bake report has duplicate artifact ${entry.file}`
        );
      }
      seenFiles.add(foldedFile);
      return {
        role: entry.role as NavigationSemanticBakeArtifact["role"],
        file: entry.file,
        bytes: entry.bytes as number,
        sha256: entry.sha256,
        ...(entry.identity === undefined ? {} : { identity: entry.identity })
      };
    });
    artifactEvidence = {
      inputName: value.inputName,
      inputBytes: value.inputBytes as number,
      inputSha256: value.inputSha256,
      artifacts
    };
  } else if (value.schemaVersion !== 1) {
    throw new Error(
      `[NAV] unsupported semantic bake report schema ${String(value.schemaVersion)}`
    );
  } else if (
    ["inputName", "inputBytes", "inputSha256", "artifacts"].some((field) =>
      Object.hasOwn(value, field)
    )
  ) {
    throw new Error(
      "[NAV] schema-v1 semantic bake report cannot contain schema-v2 artifact evidence"
    );
  }
  return {
    schemaVersion: value.schemaVersion as number,
    ...artifactEvidence,
    semanticContract: "h1emu-nav-semantics-v1",
    semanticInput: value.semanticInput,
    legacyObjectFallback: value.legacyObjectFallback,
    dynamicDoorObstaclesAcknowledged: value.dynamicDoorObstaclesAcknowledged,
    bakedSemanticsVerified: value.bakedSemanticsVerified,
    sourceTriangles: value.sourceTriangles as number,
    keptTriangles: value.keptTriangles as number,
    excludedTriangles: value.excludedTriangles as number,
    fallbackTriangles: value.fallbackTriangles as number,
    ordinaryMaterialTriangles: value.ordinaryMaterialTriangles as number,
    materials: { ...(value.materials as Record<string, number>) },
    warnings: [...value.warnings]
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function calculateNavigationArtifactId(
  manifest:
    | Omit<NavigationArtifactManifest, "artifactId">
    | NavigationArtifactManifest
): string {
  const payload = { ...manifest } as Partial<NavigationArtifactManifest>;
  delete payload.artifactId;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function parseTsetHeader(buffer: Buffer): NavigationTsetHeader {
  if (buffer.length < 92) {
    throw new Error("[NAV] tilecache header is truncated");
  }
  let offset = 0;
  const readInt = () => {
    const value = buffer.readInt32LE(offset);
    offset += 4;
    return value;
  };
  const readFloat = () => {
    const value = buffer.readFloatLE(offset);
    offset += 4;
    return value;
  };
  const expectedMagic =
    ("T".charCodeAt(0) << 24) |
    ("S".charCodeAt(0) << 16) |
    ("E".charCodeAt(0) << 8) |
    "T".charCodeAt(0);
  if (readInt() !== expectedMagic) {
    throw new Error("[NAV] artifact cache has invalid TSET magic");
  }
  const version = readInt();
  if (version !== 1) {
    throw new Error(
      `[NAV] artifact cache has unsupported TSET version ${version}`
    );
  }
  const layers = readInt();
  if (layers <= 0) {
    throw new Error("[NAV] artifact cache contains no layers");
  }
  return {
    version,
    layers,
    meshOrigin: [readFloat(), readFloat(), readFloat()],
    tileWidth: readFloat(),
    tileHeight: readFloat(),
    meshMaxTiles: readInt(),
    meshMaxPolys: readInt(),
    cacheOrigin: [readFloat(), readFloat(), readFloat()],
    cellSize: readFloat(),
    cellHeight: readFloat(),
    tileVoxels: [readInt(), readInt()],
    walkableHeight: readFloat(),
    walkableRadius: readFloat(),
    walkableClimb: readFloat(),
    maxSimplificationError: readFloat(),
    cacheMaxTiles: readInt(),
    cacheMaxObstacles: readInt()
  };
}

export function parseNavigationArtifactManifest(
  value: unknown
): NavigationArtifactManifest {
  if (!isRecord(value)) {
    throw new Error("[NAV] artifact manifest must be an object");
  }
  if (value.schemaVersion !== NAVIGATION_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `[NAV] unsupported artifact manifest schema ${String(value.schemaVersion)}`
    );
  }
  if (
    typeof value.artifactId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.artifactId)
  ) {
    throw new Error("[NAV] artifact manifest has an invalid artifactId");
  }
  if (!isRecord(value.provenance) || !isRecord(value.runtime)) {
    throw new Error(
      "[NAV] artifact manifest is missing provenance or runtime data"
    );
  }
  if (
    value.provenance.status !== "complete" &&
    value.provenance.status !== "runtime-only"
  ) {
    throw new Error("[NAV] artifact manifest has an invalid provenance status");
  }
  if (
    value.provenance.sourceWorld !== null &&
    value.provenance.sourceWorld !== undefined
  ) {
    parseArtifactSourceFile(value.provenance.sourceWorld, "source world");
  }
  if (
    value.provenance.classifierConfig !== null &&
    value.provenance.classifierConfig !== undefined
  ) {
    parseArtifactSourceFile(
      value.provenance.classifierConfig,
      "classifier config"
    );
  }
  if (
    value.provenance.bakeNavmeshParts !== null &&
    value.provenance.bakeNavmeshParts !== undefined
  ) {
    if (
      !Array.isArray(value.provenance.bakeNavmeshParts) ||
      value.provenance.bakeNavmeshParts.length === 0
    ) {
      throw new Error("[NAV] artifact manifest has invalid bake navmesh parts");
    }
    value.provenance.bakeNavmeshParts.forEach((part, index) =>
      parseArtifactFileRecord(part, `bake navmesh part ${index}`)
    );
  }
  const runtime = value.runtime;
  if (!isRecord(runtime.cache) || !Array.isArray(runtime.cache.parts)) {
    throw new Error("[NAV] artifact manifest is missing cache parts");
  }
  if (runtime.cache.coverage !== undefined) {
    parseCacheCoverage(runtime.cache.coverage);
  }
  runtime.cache.parts.forEach((part, index) =>
    parseArtifactFileRecord(part, `cache part ${index}`)
  );
  const parsed = value as unknown as NavigationArtifactManifest;
  const expectedId = calculateNavigationArtifactId(parsed);
  if (parsed.artifactId !== expectedId) {
    throw new Error(
      `[NAV] artifactId mismatch: manifest=${parsed.artifactId} calculated=${expectedId}`
    );
  }
  return parsed;
}

export function resolveArtifactFile(
  bundleRoot: string,
  record: NavigationArtifactFile
): string {
  if (
    typeof record.path !== "string" ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    throw new Error("[NAV] artifact manifest contains an invalid file record");
  }
  if (isAbsolute(record.path)) {
    throw new Error(`[NAV] artifact path must be relative: ${record.path}`);
  }
  const resolvedRoot = resolve(bundleRoot);
  const resolvedPath = resolve(resolvedRoot, record.path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[NAV] artifact path escapes bundle root: ${record.path}`);
  }
  return resolvedPath;
}

function collectManifestFiles(
  manifest: NavigationArtifactManifest
): NavigationArtifactFile[] {
  const files = [...manifest.runtime.cache.parts];
  if (manifest.provenance.bakeNavmeshParts) {
    files.push(...manifest.provenance.bakeNavmeshParts);
  }
  if (manifest.provenance.sourceReport) {
    files.push(manifest.provenance.sourceReport.file);
  }
  for (const entry of [
    manifest.runtime.collision,
    manifest.runtime.heightmap,
    manifest.runtime.navigationMetadata,
    manifest.runtime.semantics,
    manifest.runtime.transitions
  ]) {
    if (entry) files.push(entry.file);
  }
  if (manifest.provenance.composition) {
    files.push(
      manifest.provenance.composition.base.manifest,
      manifest.provenance.composition.regional.manifest,
      manifest.provenance.composition.mergeReport
    );
  }
  return files;
}

function assertSame(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`[NAV] cache composition ${label} mismatch`);
  }
}

function assertContiguousCacheParts(
  parts: NavigationArtifactFile[],
  label: string
): void {
  const orderedParts = [...parts].sort(
    (left, right) => cachePartIndex(left.path) - cachePartIndex(right.path)
  );
  orderedParts.forEach((part, index) => {
    if (cachePartIndex(part.path) !== index) {
      throw new Error(
        `[NAV] ${label} cache parts are not contiguous at index ${index}`
      );
    }
  });
}

function parseCompositionComponent(
  value: unknown,
  label: "base" | "regional"
): NavigationCacheCompositionProvenance["base"] {
  if (!isRecord(value)) {
    throw new Error(`[NAV] cache composition is missing ${label} provenance`);
  }
  const manifest = parseArtifactFileRecord(value.manifest, `${label} manifest`);
  const snapshot = parseNavigationArtifactManifest(value.snapshot);
  return { manifest, snapshot };
}

function parseCacheComposition(
  value: unknown
): NavigationCacheCompositionProvenance {
  if (
    !isRecord(value) ||
    value.schema !== "h1emu-navigation-cache-composition-v1" ||
    !isRecord(value.mergeReport)
  ) {
    throw new Error(
      "[NAV] complete artifact has invalid cache composition provenance"
    );
  }
  const mergeReportFile = parseArtifactFileRecord(
    value.mergeReport,
    "cache merge report"
  );
  const mergeReport = parseNavigationCacheMergeReport(value.mergeReport);
  return {
    schema: "h1emu-navigation-cache-composition-v1",
    base: parseCompositionComponent(value.base, "base"),
    regional: parseCompositionComponent(value.regional, "regional"),
    mergeReport: { ...mergeReportFile, ...mergeReport }
  };
}

function assertCacheComposition(
  manifest: NavigationArtifactManifest,
  rawComposition: NavigationCacheCompositionProvenance
): void {
  const composition = parseCacheComposition(rawComposition);
  if (canonicalJson(composition) !== canonicalJson(rawComposition)) {
    throw new Error(
      "[NAV] complete artifact cache composition contains invalid fields"
    );
  }

  const { base, regional, mergeReport } = composition;
  for (const [label, component] of [
    ["base", base],
    ["regional", regional]
  ] as const) {
    if (component.snapshot.provenance.composition) {
      throw new Error(
        `[NAV] cache composition ${label} artifact cannot be composed`
      );
    }
    if (component.snapshot.provenance.status !== "complete") {
      throw new Error(
        `[NAV] cache composition ${label} artifact requires complete provenance`
      );
    }
    assertCompleteNavigationArtifactProvenance(component.snapshot);
    assertContiguousCacheParts(
      component.snapshot.runtime.cache.parts,
      `${label} artifact`
    );
  }

  if (base.snapshot.runtime.cache.coverage?.kind !== "full") {
    throw new Error(
      "[NAV] cache composition base artifact must have full coverage"
    );
  }
  if (regional.snapshot.runtime.cache.coverage?.kind !== "regional") {
    throw new Error(
      "[NAV] cache composition regional artifact must have regional coverage"
    );
  }
  if (manifest.runtime.cache.coverage?.kind !== "full") {
    throw new Error("[NAV] composed artifact must have full cache coverage");
  }

  assertSame(
    "base artifactId",
    mergeReport.base.artifactId,
    base.snapshot.artifactId
  );
  assertSame(
    "base manifest hash",
    mergeReport.base.manifestSha256,
    base.manifest.sha256
  );
  assertSame(
    "base cache parts",
    mergeReport.base.cacheParts,
    base.snapshot.runtime.cache.parts
  );
  assertSame(
    "regional artifactId",
    mergeReport.regional.artifactId,
    regional.snapshot.artifactId
  );
  assertSame(
    "regional manifest hash",
    mergeReport.regional.manifestSha256,
    regional.manifest.sha256
  );
  assertSame(
    "regional cache parts",
    mergeReport.regional.cacheParts,
    regional.snapshot.runtime.cache.parts
  );
  assertSame(
    "output cache parts",
    mergeReport.output.cacheParts,
    manifest.runtime.cache.parts
  );
  assertSame(
    "output collision",
    mergeReport.output.collision,
    manifest.runtime.collision?.file
  );
  assertSame(
    "output heightmap",
    mergeReport.output.heightmap,
    manifest.runtime.heightmap?.file
  );
  assertSame(
    "output navigation metadata",
    mergeReport.output.navigationMetadata,
    manifest.runtime.navigationMetadata?.file
  );
  assertSame(
    "output semantics",
    mergeReport.output.semantics,
    manifest.runtime.semantics?.file ?? null
  );
  assertSame(
    "output transitions",
    mergeReport.output.transitions,
    manifest.runtime.transitions?.file
  );

  for (const [label, component] of [
    ["base", base.snapshot],
    ["regional", regional.snapshot]
  ] as const) {
    for (const dependency of [
      "collision",
      "heightmap",
      "navigationMetadata",
      "transitions"
    ] as const) {
      assertSame(
        `${label} ${dependency}`,
        component.runtime[dependency],
        manifest.runtime[dependency]
      );
    }
  }
}

function assertCompleteSemanticBakeProvenance(
  manifest: NavigationArtifactManifest
): void {
  const semantics = manifest.runtime.semantics;
  const metadata = manifest.runtime.navigationMetadata;
  if (!semantics) {
    throw new Error("[NAV] complete artifact provenance is missing semantics");
  }
  if (!metadata) {
    throw new Error(
      "[NAV] complete artifact provenance is missing navigationMetadata"
    );
  }
  const { file: _file, ...semanticSnapshot } = semantics;
  if (
    canonicalJson(parseNavigationSemanticBakeReport(semanticSnapshot)) !==
    canonicalJson(semanticSnapshot)
  ) {
    throw new Error(
      "[NAV] complete artifact contains invalid semantic bake provenance"
    );
  }
  if (
    semantics.semanticContract !== "h1emu-nav-semantics-v1" ||
    !semantics.semanticInput ||
    semantics.legacyObjectFallback ||
    semantics.bakedSemanticsVerified !== true ||
    semantics.fallbackTriangles !== 0 ||
    semantics.ordinaryMaterialTriangles !== 0 ||
    semantics.warnings.length !== 0
  ) {
    throw new Error(
      "[NAV] complete artifact contains incomplete or legacy semantic provenance"
    );
  }
  if (
    semantics.schemaVersion !== 2 ||
    !semantics.inputName ||
    semantics.inputBytes === undefined ||
    !semantics.inputSha256 ||
    !semantics.artifacts
  ) {
    throw new Error(
      "[NAV] complete artifact requires schema-v2 semantic artifact evidence"
    );
  }
  const directArtifacts = semantics.artifacts.filter(
    (artifact) => artifact.role === "navmesh"
  );
  const cacheArtifacts = semantics.artifacts.filter(
    (artifact) => artifact.role === "tilecache"
  );
  if (directArtifacts.length === 0 || cacheArtifacts.length === 0) {
    throw new Error(
      "[NAV] complete artifact requires verified navmesh and TileCache outputs"
    );
  }
  if (
    semantics.inputBytes <= 0 ||
    semantics.artifacts.some((artifact) => artifact.bytes <= 0)
  ) {
    throw new Error(
      "[NAV] complete artifact semantic evidence contains empty inputs or outputs"
    );
  }
  const sourceWorld = manifest.provenance.sourceWorld;
  if (
    !sourceWorld ||
    semantics.inputName !== sourceWorld.name ||
    semantics.inputBytes !== sourceWorld.size ||
    semantics.inputSha256 !== sourceWorld.sha256
  ) {
    throw new Error(
      "[NAV] semantic bake input does not match complete artifact sourceWorld"
    );
  }
  const bakeNavmeshParts = manifest.provenance.bakeNavmeshParts;
  if (!bakeNavmeshParts?.length) {
    throw new Error(
      "[NAV] complete artifact is missing manifested bake navmesh parts"
    );
  }
  assertContiguousNavmeshParts(bakeNavmeshParts, "complete artifact");
  const reportBinding = (artifacts: NavigationSemanticBakeArtifact[]) =>
    artifacts
      .map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))
      .sort((left, right) => left.file.localeCompare(right.file));
  const manifestBinding = (parts: NavigationArtifactFile[]) =>
    parts
      .map((part) => ({
        file: part.path.split(/[\\/]/).at(-1)!,
        bytes: part.size,
        sha256: part.sha256
      }))
      .sort((left, right) => left.file.localeCompare(right.file));
  if (
    canonicalJson(reportBinding(cacheArtifacts)) !==
    canonicalJson(manifestBinding(manifest.runtime.cache.parts))
  ) {
    throw new Error(
      "[NAV] semantic bake TileCache artifacts do not match runtime cache parts"
    );
  }
  if (
    canonicalJson(reportBinding(directArtifacts)) !==
    canonicalJson(manifestBinding(bakeNavmeshParts))
  ) {
    throw new Error(
      "[NAV] semantic bake navmesh artifacts do not match manifested bake outputs"
    );
  }
  if (metadata.schemaVersion !== 2 || metadata.semanticMode !== "strict") {
    throw new Error(
      "[NAV] complete artifact requires strict semantic navigation metadata"
    );
  }
  if (
    typeof metadata.bakedDoorGeometryExcluded !== "boolean" ||
    typeof semantics.dynamicDoorObstaclesAcknowledged !== "boolean"
  ) {
    throw new Error(
      "[NAV] complete artifact is missing dynamic door semantic provenance"
    );
  }
  if (
    metadata.bakedDoorGeometryExcluded === true &&
    semantics.dynamicDoorObstaclesAcknowledged !== true
  ) {
    throw new Error(
      "[NAV] complete artifact excludes door geometry without acknowledged dynamic door obstacles"
    );
  }
}

export function assertCompleteNavigationArtifactProvenance(
  manifest: NavigationArtifactManifest
): void {
  if (manifest.provenance.status !== "complete") return;
  if (manifest.provenance.composition) {
    for (const [name, value] of Object.entries({
      extractorCommit: manifest.provenance.extractorCommit,
      recastCommit: manifest.provenance.recastCommit,
      recastNavigationCommit: manifest.provenance.recastNavigationCommit,
      sourceWorld: manifest.provenance.sourceWorld,
      classifierConfig: manifest.provenance.classifierConfig,
      sourceReport: manifest.provenance.sourceReport,
      bakeNavmeshParts: manifest.provenance.bakeNavmeshParts
    })) {
      if (value !== null && value !== undefined) {
        throw new Error(
          `[NAV] composed complete artifact cannot claim direct ${name} provenance`
        );
      }
    }
    for (const [name, value] of Object.entries({
      collision: manifest.runtime.collision,
      heightmap: manifest.runtime.heightmap,
      navigationMetadata: manifest.runtime.navigationMetadata,
      transitions: manifest.runtime.transitions
    })) {
      if (!value) {
        throw new Error(`[NAV] composed complete artifact is missing ${name}`);
      }
    }
    if (manifest.runtime.semantics) {
      throw new Error(
        "[NAV] composed complete artifact cannot claim a direct semantic bake report"
      );
    }
    assertContiguousCacheParts(
      manifest.runtime.cache.parts,
      "composed artifact"
    );
    assertCacheComposition(manifest, manifest.provenance.composition);
    return;
  }
  for (const [name, value] of Object.entries({
    extractorCommit: manifest.provenance.extractorCommit,
    recastCommit: manifest.provenance.recastCommit,
    recastNavigationCommit: manifest.provenance.recastNavigationCommit,
    sourceWorld: manifest.provenance.sourceWorld,
    classifierConfig: manifest.provenance.classifierConfig,
    bakeNavmeshParts: manifest.provenance.bakeNavmeshParts,
    sourceReport: manifest.provenance.sourceReport,
    collision: manifest.runtime.collision,
    heightmap: manifest.runtime.heightmap,
    navigationMetadata: manifest.runtime.navigationMetadata,
    semantics: manifest.runtime.semantics,
    transitions: manifest.runtime.transitions
  })) {
    if (!value) {
      throw new Error(`[NAV] complete artifact provenance is missing ${name}`);
    }
  }
  assertCompleteSemanticBakeProvenance(manifest);
  const sourceReport = manifest.provenance.sourceReport!;
  const { file: _file, ...sourceReportSnapshot } = sourceReport;
  if (
    canonicalJson(parseCollisionSemanticSourceReport(sourceReportSnapshot)) !==
    canonicalJson(sourceReportSnapshot)
  ) {
    throw new Error(
      "[NAV] complete artifact contains invalid source report provenance"
    );
  }
  if (
    !sourceReport.collisionMetadataMatched ||
    sourceReport.inputs.collision.sha256 !==
      manifest.runtime.collision!.file.sha256 ||
    sourceReport.inputs.heightmap.sha256 !==
      manifest.runtime.heightmap!.file.sha256 ||
    sourceReport.output.file !== manifest.provenance.sourceWorld!.name ||
    sourceReport.output.sha256 !== manifest.provenance.sourceWorld!.sha256
  ) {
    throw new Error(
      "[NAV] complete artifact source report does not match its sidecar, source world, or runtime inputs"
    );
  }
  if (
    sourceReport.sourceStrategy.includes(
      "actor_default_pending_per_triangle_table"
    ) ||
    sourceReport.limitations.some((limitation) =>
      limitation.includes("actor_default_pending_per_triangle_table")
    )
  ) {
    throw new Error(
      "[NAV] complete artifact cannot use actor-default pending per-triangle semantics"
    );
  }
  if (sourceReport.semanticMode === "legacy-actor-diagnostic") {
    throw new Error(
      "[NAV] complete artifact cannot use diagnostic actor-default semantics"
    );
  }
  if (
    sourceReport.semanticMode !== "per-triangle-h1sem1" ||
    sourceReport.inputs.collisionTriangleSemantics?.matched !== true ||
    sourceReport.inputs.collisionTriangleSemantics.format !== "H1SEM1-u8le-v1"
  ) {
    throw new Error(
      "[NAV] complete artifact requires matched per-triangle H1SEM1 source provenance"
    );
  }
  if (
    sourceReport.inputs.collisionSemanticPolicy?.matched !== true ||
    sourceReport.inputs.collisionSemanticPolicy.schema !==
      "h1emu-h1col2-semantic-policy-v1" ||
    sourceReport.inputs.collisionSemanticPolicy.canonical !== true
  ) {
    throw new Error(
      "[NAV] complete artifact requires a matched canonical semantic policy"
    );
  }
  if (sourceReport.limitations.length !== 0) {
    throw new Error(
      "[NAV] complete artifact source report contains unresolved semantic limitations"
    );
  }
}

function cachePartIndex(path: string): number {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const match = name.match(/^z1_cache_(\d+)\.bin$/);
  if (!match) throw new Error(`[NAV] invalid artifact cache part ${path}`);
  return Number(match[1]);
}

function navmeshPartIndex(path: string): number {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const match = name.match(/^z1_(\d+)\.bin$/);
  if (!match) throw new Error(`[NAV] invalid bake navmesh part ${path}`);
  return Number(match[1]);
}

function assertContiguousNavmeshParts(
  parts: NavigationArtifactFile[],
  label: string
): void {
  const orderedParts = [...parts].sort(
    (left, right) => navmeshPartIndex(left.path) - navmeshPartIndex(right.path)
  );
  orderedParts.forEach((part, index) => {
    if (navmeshPartIndex(part.path) !== index) {
      throw new Error(
        `[NAV] ${label} bake navmesh parts are not contiguous at index ${index}`
      );
    }
  });
}

export async function verifyNavigationArtifact(options: {
  manifestPath: string;
  cacheDirectory: string;
  requireRuntimeDependencies?: boolean;
}): Promise<VerifiedNavigationArtifact> {
  const manifestPath = resolve(options.manifestPath);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `[NAV] required artifact manifest is missing: ${manifestPath}`
    );
  }
  const manifest = parseNavigationArtifactManifest(
    JSON.parse(readFileSync(manifestPath, "utf8"))
  );
  assertCompleteNavigationArtifactProvenance(manifest);
  const bundleRoot = dirname(manifestPath);
  if (options.requireRuntimeDependencies) {
    const required = [
      [
        manifest.runtime.collision,
        resolve(bundleRoot, "collision/z1_collision.bin")
      ],
      [
        manifest.runtime.heightmap,
        resolve(bundleRoot, "zoneData/heightmap.png")
      ],
      [
        manifest.runtime.transitions,
        resolve(bundleRoot, "navigationTransitions.json")
      ]
    ] as const;
    for (const [entry, expectedPath] of required) {
      if (!entry) {
        throw new Error(
          `[NAV] runtime artifact dependency is not manifested: ${relative(
            bundleRoot,
            expectedPath
          )}`
        );
      }
      const actualPath = resolveArtifactFile(bundleRoot, entry.file);
      if (actualPath !== expectedPath) {
        throw new Error(
          `[NAV] runtime artifact dependency has an unexpected path: ${entry.file.path}`
        );
      }
    }
    const metadataPath = resolve(bundleRoot, "navigation_metadata.json");
    if (manifest.runtime.navigationMetadata) {
      const actualPath = resolveArtifactFile(
        bundleRoot,
        manifest.runtime.navigationMetadata.file
      );
      if (actualPath !== metadataPath) {
        throw new Error(
          `[NAV] navigation metadata has an unexpected path: ${manifest.runtime.navigationMetadata.file.path}`
        );
      }
    } else if (existsSync(metadataPath)) {
      throw new Error(
        "[NAV] navigation metadata exists but is not bound by the artifact manifest"
      );
    }
  }
  const orderedParts = [...manifest.runtime.cache.parts].sort(
    (left, right) => cachePartIndex(left.path) - cachePartIndex(right.path)
  );
  assertContiguousCacheParts(orderedParts, "artifact");

  const expectedCachePaths = new Set(
    orderedParts.map((part) => resolveArtifactFile(bundleRoot, part))
  );
  const discoveredCachePaths = readdirSync(options.cacheDirectory)
    .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
    .map((name) => resolve(options.cacheDirectory, name));
  const unexpected = discoveredCachePaths.filter(
    (path) => !expectedCachePaths.has(path)
  );
  if (unexpected.length) {
    throw new Error(
      `[NAV] artifact cache contains unmanifested part(s): ${unexpected.join(", ")}`
    );
  }
  if (discoveredCachePaths.length !== expectedCachePaths.size) {
    throw new Error(
      `[NAV] artifact cache part count mismatch: manifest=${expectedCachePaths.size} disk=${discoveredCachePaths.length}`
    );
  }

  if (manifest.provenance.bakeNavmeshParts?.length) {
    const expectedNavmeshPaths = new Set(
      manifest.provenance.bakeNavmeshParts.map((part) =>
        resolveArtifactFile(bundleRoot, part)
      )
    );
    const navmeshDirectories = new Set(
      [...expectedNavmeshPaths].map((path) => dirname(path))
    );
    if (navmeshDirectories.size !== 1) {
      throw new Error(
        "[NAV] manifested bake navmesh parts must share one directory"
      );
    }
    const navmeshDirectory = [...navmeshDirectories][0];
    const discoveredNavmeshPaths = readdirSync(navmeshDirectory)
      .filter((name) => /^z1_\d+\.bin$/.test(name))
      .map((name) => resolve(navmeshDirectory, name));
    const unexpectedNavmesh = discoveredNavmeshPaths.filter(
      (path) => !expectedNavmeshPaths.has(path)
    );
    if (unexpectedNavmesh.length) {
      throw new Error(
        `[NAV] artifact contains unmanifested bake navmesh part(s): ${unexpectedNavmesh.join(", ")}`
      );
    }
    if (discoveredNavmeshPaths.length !== expectedNavmeshPaths.size) {
      throw new Error(
        `[NAV] bake navmesh part count mismatch: manifest=${expectedNavmeshPaths.size} disk=${discoveredNavmeshPaths.length}`
      );
    }
  }

  let filesVerified = 0;
  let bytesVerified = 0;
  for (const record of collectManifestFiles(manifest)) {
    const path = resolveArtifactFile(bundleRoot, record);
    if (!existsSync(path)) {
      throw new Error(`[NAV] artifact file is missing: ${record.path}`);
    }
    const size = statSync(path).size;
    if (size !== record.size) {
      throw new Error(
        `[NAV] artifact size mismatch for ${record.path}: manifest=${record.size} disk=${size}`
      );
    }
    const sha256 = await sha256File(path);
    if (sha256 !== record.sha256) {
      throw new Error(
        `[NAV] artifact SHA-256 mismatch for ${record.path}: manifest=${record.sha256} disk=${sha256}`
      );
    }
    filesVerified++;
    bytesVerified += size;
  }

  if (manifest.provenance.sourceReport) {
    const report = manifest.provenance.sourceReport;
    const { file: _file, ...manifestSnapshot } = report;
    const reportPath = resolveArtifactFile(bundleRoot, report.file);
    const diskSnapshot = parseCollisionSemanticSourceReport(
      JSON.parse(readFileSync(reportPath, "utf8"))
    );
    const comparableDiskSnapshot = structuredClone(diskSnapshot);
    if (manifest.provenance.status === "runtime-only") {
      if (!Object.hasOwn(manifestSnapshot, "semanticMode")) {
        delete comparableDiskSnapshot.semanticMode;
      }
      for (const field of [
        "collisionInstanceIds",
        "collisionTriangleSemantics",
        "collisionSemanticPolicy"
      ] as const) {
        if (!Object.hasOwn(manifestSnapshot.inputs, field)) {
          delete comparableDiskSnapshot.inputs[field];
        }
      }
    }
    if (
      canonicalJson(comparableDiskSnapshot) !== canonicalJson(manifestSnapshot)
    ) {
      throw new Error(
        "[NAV] collision semantic source report does not match manifested provenance"
      );
    }
    if (
      manifest.runtime.collision &&
      diskSnapshot.inputs.collision.sha256 !==
        manifest.runtime.collision.file.sha256
    ) {
      throw new Error(
        "[NAV] source report collision hash does not match runtime collision"
      );
    }
    if (
      manifest.runtime.heightmap &&
      diskSnapshot.inputs.heightmap.sha256 !==
        manifest.runtime.heightmap.file.sha256
    ) {
      throw new Error(
        "[NAV] source report heightmap hash does not match runtime heightmap"
      );
    }
  }

  if (manifest.runtime.semantics) {
    const report = manifest.runtime.semantics;
    const { file: _file, ...manifestSnapshot } = report;
    const reportPath = resolveArtifactFile(bundleRoot, report.file);
    const diskSnapshot = parseNavigationSemanticBakeReport(
      JSON.parse(readFileSync(reportPath, "utf8"))
    );
    const comparableDiskSnapshot = { ...diskSnapshot };
    if (manifest.provenance.status === "runtime-only") {
      for (const field of [
        "dynamicDoorObstaclesAcknowledged",
        "bakedSemanticsVerified"
      ] as const) {
        if (!Object.hasOwn(manifestSnapshot, field)) {
          delete comparableDiskSnapshot[field];
        }
      }
    }
    if (
      canonicalJson(comparableDiskSnapshot) !== canonicalJson(manifestSnapshot)
    ) {
      throw new Error(
        "[NAV] semantic bake report does not match manifested provenance"
      );
    }
  }

  if (manifest.provenance.composition) {
    const composition = manifest.provenance.composition;
    for (const [label, component] of [
      ["base", composition.base],
      ["regional", composition.regional]
    ] as const) {
      const componentPath = resolveArtifactFile(bundleRoot, component.manifest);
      const diskSnapshot = parseNavigationArtifactManifest(
        JSON.parse(readFileSync(componentPath, "utf8"))
      );
      if (canonicalJson(diskSnapshot) !== canonicalJson(component.snapshot)) {
        throw new Error(
          `[NAV] ${label} component manifest does not match manifested snapshot`
        );
      }
      const componentRoot = dirname(componentPath);
      const componentCacheDirectory = dirname(
        resolveArtifactFile(
          componentRoot,
          component.snapshot.runtime.cache.parts[0]
        )
      );
      const verifiedComponent = await verifyNavigationArtifact({
        manifestPath: componentPath,
        cacheDirectory: componentCacheDirectory
      });
      filesVerified += verifiedComponent.filesVerified;
      bytesVerified += verifiedComponent.bytesVerified;
    }

    const report = composition.mergeReport;
    const {
      path: _path,
      size: _size,
      sha256: _sha256,
      ...manifestSnapshot
    } = report;
    const reportPath = resolveArtifactFile(bundleRoot, report);
    const diskSnapshot = parseNavigationCacheMergeReport(
      JSON.parse(readFileSync(reportPath, "utf8"))
    );
    if (canonicalJson(diskSnapshot) !== canonicalJson(manifestSnapshot)) {
      throw new Error(
        "[NAV] cache merge report does not match manifested provenance"
      );
    }
  }

  const firstPart = resolveArtifactFile(bundleRoot, orderedParts[0]);
  const header = parseTsetHeader(readFileSync(firstPart).subarray(0, 92));
  if (canonicalJson(header) !== canonicalJson(manifest.runtime.cache.header)) {
    throw new Error("[NAV] artifact TSET header does not match the manifest");
  }

  return { manifest, manifestPath, filesVerified, bytesVerified };
}
