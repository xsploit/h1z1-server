import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  assertCompleteNavigationArtifactProvenance,
  calculateNavigationArtifactId,
  canonicalJson,
  NavigationCacheCompositionProvenance,
  NavigationCacheCoverage,
  NavigationArtifactFile,
  NavigationArtifactManifest,
  parseCollisionSemanticSourceReport,
  parseNavigationCacheMergeReport,
  parseNavigationSemanticBakeReport,
  parseTsetHeader,
  sha256File,
  verifyNavigationArtifact
} from "../src/utils/navigationartifacts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionalPath(path: string): string | null {
  return existsSync(path) ? path : null;
}

async function fileRecord(
  bundleRoot: string,
  path: string
): Promise<NavigationArtifactFile> {
  const rel = relative(bundleRoot, path).replaceAll("\\", "/");
  if (rel.startsWith("../") || rel === "..") {
    throw new Error(`runtime artifact is outside bundle root: ${path}`);
  }
  return {
    path: rel,
    size: statSync(path).size,
    sha256: await sha256File(path)
  };
}

async function sourceRecord(path: string | undefined) {
  if (!path) return null;
  const resolved = resolve(path);
  return {
    name: basename(resolved),
    size: statSync(resolved).size,
    sha256: await sha256File(resolved)
  };
}

function parseH1col2(path: string) {
  const header = readFileSync(path).subarray(0, 20);
  if (
    header.length < 20 ||
    header.subarray(0, 6).toString("latin1") !== "H1COL2"
  ) {
    throw new Error(`${path} is not an H1COL2 collision artifact`);
  }
  return {
    version: header.readUInt32LE(8),
    meshCount: header.readUInt32LE(12),
    instanceCount: header.readUInt32LE(16)
  };
}

function parsePng(path: string) {
  const header = readFileSync(path).subarray(0, 24);
  const signature = "89504e470d0a1a0a";
  if (
    header.length < 24 ||
    header.subarray(0, 8).toString("hex") !== signature
  ) {
    throw new Error(`${path} is not a PNG heightmap`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function parseMetadata(path: string) {
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    version?: number;
    semanticMode?: "strict" | "legacy";
    bakedDoorGeometryExcluded?: boolean;
    instances?: Array<{ kind?: string }>;
  };
  if (!Number.isInteger(value.version) || !Array.isArray(value.instances)) {
    throw new Error(`${path} is not valid navigation metadata`);
  }
  const kinds: Record<string, number> = {};
  for (const entry of value.instances) {
    const kind = entry.kind ?? "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    schemaVersion: value.version as number,
    instanceCount: value.instances.length,
    kinds,
    semanticMode: value.semanticMode,
    bakedDoorGeometryExcluded: value.bakedDoorGeometryExcluded
  };
}

function parseTransitions(path: string): number {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array`);
  return value.length;
}

function cachePartIndex(name: string): number {
  const match = name.match(/^z1_cache_(\d+)\.bin$/);
  if (!match) throw new Error(`invalid cache part name: ${name}`);
  return Number(match[1]);
}

function parseCacheCoverage(): NavigationCacheCoverage | undefined {
  const kind = option("--cache-coverage");
  const rawBounds = option("--cache-bounds");
  if (!kind && !rawBounds) return undefined;
  if (kind === "full") {
    if (rawBounds) throw new Error("full cache coverage cannot include bounds");
    return { kind: "full" };
  }
  if (kind !== "regional" || !rawBounds) {
    throw new Error(
      "regional cache coverage requires --cache-bounds minX,minZ,maxX,maxZ"
    );
  }
  const [minX, minZ, maxX, maxZ, ...extra] = rawBounds.split(",").map(Number);
  if (
    extra.length ||
    ![minX, minZ, maxX, maxZ].every(Number.isFinite) ||
    minX >= maxX ||
    minZ >= maxZ
  ) {
    throw new Error(`invalid regional cache bounds: ${rawBounds}`);
  }
  return { kind: "regional", bounds: { minX, minZ, maxX, maxZ } };
}

async function createComposition(
  bundleRoot: string
): Promise<NavigationCacheCompositionProvenance | null> {
  const raw = {
    baseManifest: option("--base-artifact-manifest"),
    baseCacheDirectory: option("--base-cache-dir"),
    regionalManifest: option("--regional-artifact-manifest"),
    regionalCacheDirectory: option("--regional-cache-dir"),
    mergeReport: option("--cache-merge-report")
  };
  const configured = Object.values(raw).filter(Boolean).length;
  if (!configured) return null;
  if (configured !== Object.keys(raw).length) {
    throw new Error(
      "cache composition requires base/regional manifest and cache paths plus --cache-merge-report"
    );
  }

  const baseManifestPath = resolve(raw.baseManifest!);
  const regionalManifestPath = resolve(raw.regionalManifest!);
  const mergeReportPath = resolve(raw.mergeReport!);
  const [base, regional] = await Promise.all([
    verifyNavigationArtifact({
      manifestPath: baseManifestPath,
      cacheDirectory: resolve(raw.baseCacheDirectory!)
    }),
    verifyNavigationArtifact({
      manifestPath: regionalManifestPath,
      cacheDirectory: resolve(raw.regionalCacheDirectory!)
    })
  ]);
  if (
    base.manifest.provenance.status !== "complete" ||
    regional.manifest.provenance.status !== "complete"
  ) {
    throw new Error("cache composition inputs must have complete provenance");
  }
  const mergeReport = parseNavigationCacheMergeReport(
    JSON.parse(readFileSync(mergeReportPath, "utf8"))
  );
  const provenanceDirectory = resolve(bundleRoot, "provenance");
  mkdirSync(provenanceDirectory, { recursive: true });
  const stagedBaseManifest = resolve(
    provenanceDirectory,
    "base-navigation-artifact-manifest.json"
  );
  const stagedRegionalManifest = resolve(
    provenanceDirectory,
    "regional-navigation-artifact-manifest.json"
  );
  const stagedMergeReport = resolve(
    provenanceDirectory,
    "cache-merge-report.json"
  );
  writeFileSync(stagedBaseManifest, readFileSync(baseManifestPath));
  writeFileSync(stagedRegionalManifest, readFileSync(regionalManifestPath));
  writeFileSync(stagedMergeReport, readFileSync(mergeReportPath));
  return {
    schema: "h1emu-navigation-cache-composition-v1",
    base: {
      manifest: await fileRecord(bundleRoot, stagedBaseManifest),
      snapshot: base.manifest
    },
    regional: {
      manifest: await fileRecord(bundleRoot, stagedRegionalManifest),
      snapshot: regional.manifest
    },
    mergeReport: {
      ...(await fileRecord(bundleRoot, stagedMergeReport)),
      ...mergeReport
    }
  };
}

async function main() {
  const bundleRoot = resolve(option("--bundle-root") ?? "data/2016");
  const cacheDirectory = resolve(
    option("--cache-dir") ?? resolve(bundleRoot, "collision")
  );
  const output = resolve(
    option("--output") ??
      resolve(bundleRoot, "navigation-artifact-manifest.json")
  );
  const collisionPath = optionalPath(
    resolve(
      option("--collision") ?? resolve(cacheDirectory, "z1_collision.bin")
    )
  );
  const heightmapPath = optionalPath(
    resolve(
      option("--heightmap") ?? resolve(bundleRoot, "zoneData/heightmap.png")
    )
  );
  const metadataPath = optionalPath(
    resolve(
      option("--navigation-metadata") ??
        resolve(bundleRoot, "navigation_metadata.json")
    )
  );
  const transitionsPath = optionalPath(
    resolve(
      option("--transitions") ??
        resolve(bundleRoot, "navigationTransitions.json")
    )
  );
  const semanticsPath = optionalPath(
    resolve(
      option("--semantic-report") ??
        resolve(bundleRoot, "navigation-semantics.json")
    )
  );
  const sourceReportPath = option("--source-report")
    ? resolve(option("--source-report")!)
    : null;
  const partNames = readdirSync(cacheDirectory)
    .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
    .sort((left, right) => cachePartIndex(left) - cachePartIndex(right));
  if (!partNames.length)
    throw new Error(`no cache parts found in ${cacheDirectory}`);
  partNames.forEach((name, index) => {
    if (name !== `z1_cache_${index}.bin`) {
      throw new Error(
        `cache parts are not contiguous at index ${index}: ${name}`
      );
    }
  });

  const cacheParts: NavigationArtifactFile[] = [];
  for (const name of partNames) {
    cacheParts.push(
      await fileRecord(bundleRoot, resolve(cacheDirectory, name))
    );
  }
  const cacheHeader = parseTsetHeader(
    readFileSync(resolve(cacheDirectory, partNames[0])).subarray(0, 92)
  );

  const collision = collisionPath
    ? {
        file: await fileRecord(bundleRoot, collisionPath),
        format: "H1COL2" as const,
        ...parseH1col2(collisionPath)
      }
    : null;
  const heightmap = heightmapPath
    ? {
        file: await fileRecord(bundleRoot, heightmapPath),
        format: "PNG" as const,
        ...parsePng(heightmapPath)
      }
    : null;
  const navigationMetadata = metadataPath
    ? {
        file: await fileRecord(bundleRoot, metadataPath),
        ...parseMetadata(metadataPath)
      }
    : null;
  const transitions = transitionsPath
    ? {
        file: await fileRecord(bundleRoot, transitionsPath),
        count: parseTransitions(transitionsPath)
      }
    : null;
  const semantics = semanticsPath
    ? {
        file: await fileRecord(bundleRoot, semanticsPath),
        ...parseNavigationSemanticBakeReport(
          JSON.parse(readFileSync(semanticsPath, "utf8"))
        )
      }
    : null;
  const sourceWorld = await sourceRecord(option("--source-world"));
  const classifierConfig = await sourceRecord(option("--classifier-config"));
  const sourceReport = sourceReportPath
    ? {
        file: await fileRecord(bundleRoot, sourceReportPath),
        ...parseCollisionSemanticSourceReport(
          JSON.parse(readFileSync(sourceReportPath, "utf8"))
        )
      }
    : null;
  const composition = await createComposition(bundleRoot);
  const requestedCacheCoverage = parseCacheCoverage();
  if (composition && requestedCacheCoverage?.kind === "regional") {
    throw new Error("cache composition output must have full coverage");
  }
  const cacheCoverage = composition
    ? { kind: "full" as const }
    : requestedCacheCoverage;
  const status =
    option("--provenance-status") ??
    (composition ||
    (sourceWorld && option("--extractor-commit") && option("--recast-commit"))
      ? "complete"
      : "runtime-only");
  if (status !== "complete" && status !== "runtime-only") {
    throw new Error(`invalid provenance status: ${status}`);
  }
  if (composition && status !== "complete") {
    throw new Error("cache composition requires complete provenance status");
  }
  if (status === "complete" && !composition) {
    const required = {
      sourceWorld,
      classifierConfig,
      sourceReport,
      extractorCommit: option("--extractor-commit"),
      recastCommit: option("--recast-commit"),
      recastNavigationCommit: option("--recast-navigation-commit"),
      collision,
      heightmap,
      navigationMetadata,
      semantics,
      transitions
    };
    for (const [name, value] of Object.entries(required)) {
      if (!value) throw new Error(`complete provenance requires ${name}`);
    }
    if (
      !semantics!.semanticInput ||
      semantics!.legacyObjectFallback ||
      semantics!.bakedSemanticsVerified !== true ||
      semantics!.fallbackTriangles !== 0 ||
      semantics!.ordinaryMaterialTriangles !== 0 ||
      semantics!.warnings.length !== 0
    ) {
      throw new Error(
        "complete provenance requires strict, warning-free semantic input"
      );
    }
    if (
      navigationMetadata!.schemaVersion !== 2 ||
      navigationMetadata!.semanticMode !== "strict"
    ) {
      throw new Error(
        "complete provenance requires strict semantic navigation metadata"
      );
    }
    if (
      typeof navigationMetadata!.bakedDoorGeometryExcluded !== "boolean" ||
      typeof semantics!.dynamicDoorObstaclesAcknowledged !== "boolean"
    ) {
      throw new Error(
        "complete provenance requires dynamic door semantic provenance"
      );
    }
    if (
      !sourceReport!.collisionMetadataMatched ||
      sourceReport!.inputs.collision.sha256 !== collision!.file.sha256 ||
      sourceReport!.inputs.heightmap.sha256 !== heightmap!.file.sha256 ||
      sourceReport!.output.file !== sourceWorld!.name ||
      sourceReport!.output.sha256 !== sourceWorld!.sha256
    ) {
      throw new Error(
        "complete provenance requires a matched collision sidecar and source-report output/input hashes to match the source world and runtime"
      );
    }
    if (
      sourceReport!.sourceStrategy.includes(
        "actor_default_pending_per_triangle_table"
      ) ||
      sourceReport!.limitations.some((limitation) =>
        limitation.includes("actor_default_pending_per_triangle_table")
      )
    ) {
      throw new Error(
        "complete provenance cannot use actor-default pending per-triangle semantics"
      );
    }
    if (sourceReport!.semanticMode === "legacy-actor-diagnostic") {
      throw new Error(
        "complete provenance cannot use diagnostic actor-default semantics"
      );
    }
    if (
      sourceReport!.semanticMode !== "per-triangle-h1sem1" ||
      sourceReport!.inputs.collisionTriangleSemantics?.matched !== true ||
      sourceReport!.inputs.collisionTriangleSemantics.format !==
        "H1SEM1-u8le-v1"
    ) {
      throw new Error(
        "complete provenance requires matched per-triangle H1SEM1 source provenance"
      );
    }
    if (
      sourceReport!.inputs.collisionSemanticPolicy?.matched !== true ||
      sourceReport!.inputs.collisionSemanticPolicy.schema !==
        "h1emu-h1col2-semantic-policy-v1" ||
      sourceReport!.inputs.collisionSemanticPolicy.canonical !== true
    ) {
      throw new Error(
        "complete provenance requires a matched canonical semantic policy"
      );
    }
    if (sourceReport!.limitations.length !== 0) {
      throw new Error(
        "complete provenance cannot contain unresolved semantic limitations"
      );
    }
    if (
      navigationMetadata!.bakedDoorGeometryExcluded === true &&
      semantics!.dynamicDoorObstaclesAcknowledged !== true
    ) {
      throw new Error(
        "complete provenance excludes door geometry without acknowledged dynamic door obstacles"
      );
    }
  }

  const payload: Omit<NavigationArtifactManifest, "artifactId"> = {
    schemaVersion: 1,
    provenance: {
      status,
      extractorCommit: option("--extractor-commit") ?? null,
      recastCommit: option("--recast-commit") ?? null,
      recastNavigationCommit: option("--recast-navigation-commit") ?? null,
      sourceWorld,
      classifierConfig,
      sourceReport,
      composition
    },
    runtime: {
      cache: {
        format: "TSET",
        parts: cacheParts,
        header: cacheHeader,
        coverage: cacheCoverage
      },
      collision,
      heightmap,
      navigationMetadata,
      semantics,
      transitions
    }
  };
  const manifest: NavigationArtifactManifest = {
    ...payload,
    artifactId: calculateNavigationArtifactId(payload)
  };
  assertCompleteNavigationArtifactProvenance(manifest);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        artifactId: manifest.artifactId,
        provenance: manifest.provenance.status,
        composition: Boolean(composition),
        cacheParts: cacheParts.length,
        cacheLayers: cacheHeader.layers,
        runtimeBytes: [
          ...cacheParts,
          collision?.file,
          heightmap?.file,
          navigationMetadata?.file,
          semantics?.file,
          transitions?.file,
          sourceReport?.file,
          composition?.base.manifest,
          composition?.regional.manifest,
          composition?.mergeReport
        ]
          .filter(Boolean)
          .reduce((sum, file) => sum + (file?.size ?? 0), 0),
        canonicalSha256: createHash("sha256")
          .update(canonicalJson(manifest))
          .digest("hex")
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
