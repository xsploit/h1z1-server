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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  for (const entry of [
    manifest.runtime.collision,
    manifest.runtime.heightmap,
    manifest.runtime.navigationMetadata,
    manifest.runtime.transitions
  ]) {
    if (entry) files.push(entry.file);
  }
  return files;
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

  const firstPart = resolveArtifactFile(bundleRoot, orderedParts[0]);
  const header = parseTsetHeader(readFileSync(firstPart).subarray(0, 92));
  if (canonicalJson(header) !== canonicalJson(manifest.runtime.cache.header)) {
    throw new Error("[NAV] artifact TSET header does not match the manifest");
  }

  return { manifest, manifestPath, filesVerified, bytesVerified };
}
