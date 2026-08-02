import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  calculateNavigationArtifactId,
  canonicalJson,
  NavigationArtifactFile,
  NavigationArtifactManifest,
  parseTsetHeader,
  sha256File
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
    kinds
  };
}

function parseTransitions(path: string): number {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array`);
  return value.length;
}

function parseSemanticReport(path: string) {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
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
    !integerFields.every((field) => Number.isSafeInteger(value[field])) ||
    !value.materials ||
    typeof value.materials !== "object" ||
    Array.isArray(value.materials) ||
    !Array.isArray(value.warnings)
  ) {
    throw new Error(`${path} is not valid semantic provenance`);
  }
  return {
    schemaVersion: value.schemaVersion as number,
    semanticContract: "h1emu-nav-semantics-v1" as const,
    semanticInput: value.semanticInput as boolean,
    legacyObjectFallback: value.legacyObjectFallback as boolean,
    sourceTriangles: value.sourceTriangles as number,
    keptTriangles: value.keptTriangles as number,
    excludedTriangles: value.excludedTriangles as number,
    fallbackTriangles: value.fallbackTriangles as number,
    ordinaryMaterialTriangles: value.ordinaryMaterialTriangles as number,
    materials: value.materials as Record<string, number>,
    warnings: value.warnings as string[]
  };
}

function cachePartIndex(name: string): number {
  const match = name.match(/^z1_cache_(\d+)\.bin$/);
  if (!match) throw new Error(`invalid cache part name: ${name}`);
  return Number(match[1]);
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
        ...parseSemanticReport(semanticsPath)
      }
    : null;
  const sourceWorld = await sourceRecord(option("--source-world"));
  const classifierConfig = await sourceRecord(option("--classifier-config"));
  const status =
    option("--provenance-status") ??
    (sourceWorld && option("--extractor-commit") && option("--recast-commit")
      ? "complete"
      : "runtime-only");
  if (status !== "complete" && status !== "runtime-only") {
    throw new Error(`invalid provenance status: ${status}`);
  }
  if (status === "complete") {
    const required = {
      sourceWorld,
      classifierConfig,
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
      semantics!.fallbackTriangles !== 0 ||
      semantics!.ordinaryMaterialTriangles !== 0 ||
      semantics!.warnings.length !== 0
    ) {
      throw new Error(
        "complete provenance requires strict, warning-free semantic input"
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
      classifierConfig
    },
    runtime: {
      cache: { format: "TSET", parts: cacheParts, header: cacheHeader },
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
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        output,
        artifactId: manifest.artifactId,
        provenance: manifest.provenance.status,
        cacheParts: cacheParts.length,
        cacheLayers: cacheHeader.layers,
        runtimeBytes: [
          ...cacheParts,
          collision?.file,
          heightmap?.file,
          navigationMetadata?.file,
          semantics?.file,
          transitions?.file
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
