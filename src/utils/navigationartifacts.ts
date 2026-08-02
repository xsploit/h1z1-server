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

export interface CollisionSemanticSourceInput {
  file: string;
  sha256: string;
}

export interface CollisionSemanticSourceReport {
  file: NavigationArtifactFile;
  schema: "h1emu-collision-semantic-obj-v1";
  semanticContract: "h1emu-nav-semantics-v1";
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
  };
  collisionMetadataMatched: boolean;
  limitations: string[];
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
    sourceWorld: {
      name: string;
      size: number;
      sha256: string;
    } | null;
    classifierConfig: {
      name: string;
      size: number;
      sha256: string;
    } | null;
    /** Optional for backward-compatible runtime-only manifests; mandatory for complete provenance. */
    sourceReport?: CollisionSemanticSourceReport | null;
  };
  runtime: {
    cache: {
      format: "TSET";
      parts: NavigationArtifactFile[];
      header: NavigationTsetHeader;
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
    semantics: {
      file: NavigationArtifactFile;
      schemaVersion: number;
      semanticContract: "h1emu-nav-semantics-v1";
      semanticInput: boolean;
      legacyObjectFallback: boolean;
      sourceTriangles: number;
      keptTriangles: number;
      excludedTriangles: number;
      fallbackTriangles: number;
      ordinaryMaterialTriangles: number;
      materials: Record<string, number>;
      warnings: string[];
    } | null;
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
  return {
    schema: "h1emu-collision-semantic-obj-v1",
    semanticContract: "h1emu-nav-semantics-v1",
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
    inputs: { heightmap, collision, collisionMetadata },
    collisionMetadataMatched,
    limitations: [...value.limitations]
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
  const runtime = value.runtime;
  if (!isRecord(runtime.cache) || !Array.isArray(runtime.cache.parts)) {
    throw new Error("[NAV] artifact manifest is missing cache parts");
  }
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
  return files;
}

function validateCompleteProvenance(
  manifest: NavigationArtifactManifest
): void {
  if (manifest.provenance.status !== "complete") return;
  for (const [name, value] of Object.entries({
    extractorCommit: manifest.provenance.extractorCommit,
    recastCommit: manifest.provenance.recastCommit,
    recastNavigationCommit: manifest.provenance.recastNavigationCommit,
    sourceWorld: manifest.provenance.sourceWorld,
    classifierConfig: manifest.provenance.classifierConfig,
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
  const semantics = manifest.runtime.semantics!;
  if (
    semantics.semanticContract !== "h1emu-nav-semantics-v1" ||
    !semantics.semanticInput ||
    semantics.legacyObjectFallback ||
    semantics.fallbackTriangles !== 0 ||
    semantics.ordinaryMaterialTriangles !== 0 ||
    semantics.warnings.length !== 0
  ) {
    throw new Error(
      "[NAV] complete artifact contains incomplete or legacy semantic provenance"
    );
  }
  const metadata = manifest.runtime.navigationMetadata!;
  if (metadata.schemaVersion !== 2 || metadata.semanticMode !== "strict") {
    throw new Error(
      "[NAV] complete artifact requires strict semantic navigation metadata"
    );
  }
}

function cachePartIndex(path: string): number {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const match = name.match(/^z1_cache_(\d+)\.bin$/);
  if (!match) throw new Error(`[NAV] invalid artifact cache part ${path}`);
  return Number(match[1]);
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
  validateCompleteProvenance(manifest);
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
  orderedParts.forEach((part, index) => {
    if (cachePartIndex(part.path) !== index) {
      throw new Error(
        `[NAV] artifact cache parts are not contiguous at index ${index}`
      );
    }
  });

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
    if (canonicalJson(diskSnapshot) !== canonicalJson(manifestSnapshot)) {
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

  const firstPart = resolveArtifactFile(bundleRoot, orderedParts[0]);
  const header = parseTsetHeader(readFileSync(firstPart).subarray(0, 92));
  if (canonicalJson(header) !== canonicalJson(manifest.runtime.cache.header)) {
    throw new Error("[NAV] artifact TSET header does not match the manifest");
  }

  return { manifest, manifestPath, filesVerified, bytesVerified };
}
