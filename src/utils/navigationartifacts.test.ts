import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCompleteNavigationArtifactProvenance,
  assertNavigationRuntimeConfiguration,
  calculateNavigationArtifactId,
  canonicalJson,
  NavigationArtifactFile,
  NavigationArtifactManifest,
  parseCollisionSemanticSourceReport,
  parseNavigationCacheMergeReport,
  parseNavigationSemanticBakeReport,
  parseTsetHeader,
  verifyNavigationArtifact
} from "./navigationartifacts";

function tsetBuffer(): Buffer {
  const buffer = Buffer.alloc(96);
  let offset = 0;
  const writeInt = (value: number) => {
    buffer.writeInt32LE(value, offset);
    offset += 4;
  };
  const writeFloat = (value: number) => {
    buffer.writeFloatLE(value, offset);
    offset += 4;
  };
  writeInt(
    ("T".charCodeAt(0) << 24) |
      ("S".charCodeAt(0) << 16) |
      ("E".charCodeAt(0) << 8) |
      "T".charCodeAt(0)
  );
  writeInt(1);
  writeInt(2);
  [0, 0, 0, 25.6, 25.6].forEach(writeFloat);
  writeInt(32768);
  writeInt(128);
  [0, 0, 0, 0.2, 0.1].forEach(writeFloat);
  writeInt(128);
  writeInt(128);
  [2, 0.2, 0.5, 1.3].forEach(writeFloat);
  writeInt(2_097_152);
  writeInt(20_000);
  return buffer;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function collisionSemanticSourceReport() {
  return {
    schema: "h1emu-collision-semantic-obj-v1",
    semanticContract: "h1emu-nav-semantics-v1",
    semanticMode: "per-triangle-h1sem1" as const,
    coordinateSpace: "h1z1-world-y-up-meters",
    sourceStrategy: "heightmap-plus-h1col2-only",
    renderGeometryMerged: false,
    bounds: { minX: -255, minZ: -1180, maxX: -210, maxZ: -1125 },
    terrainStep: 1,
    output: { file: "world.obj", sha256: "4".repeat(64) },
    inputs: {
      heightmap: { file: "heightmap.png", sha256: "1".repeat(64) },
      collision: { file: "z1_collision.bin", sha256: "2".repeat(64) },
      collisionMetadata: {
        file: "z1_collision.metadata.json",
        sha256: "3".repeat(64),
        matched: true
      },
      collisionTriangleSemantics: {
        file: "z1_collision.semantics.bin",
        sha256: "5".repeat(64),
        matched: true,
        format: "H1SEM1-u8le-v1" as const
      },
      collisionSemanticPolicy: {
        file: "z1_collision.semantic-policy.json",
        sha256: "6".repeat(64),
        matched: true,
        schema: "h1emu-h1col2-semantic-policy-v1" as const,
        canonical: true
      }
    },
    limitations: []
  };
}

function semanticBakeReport() {
  return {
    schemaVersion: 1,
    semanticContract: "h1emu-nav-semantics-v1" as const,
    semanticInput: true,
    legacyObjectFallback: false,
    dynamicDoorObstaclesAcknowledged: true,
    bakedSemanticsVerified: true,
    sourceTriangles: 1,
    keptTriangles: 1,
    excludedTriangles: 0,
    fallbackTriangles: 0,
    ordinaryMaterialTriangles: 0,
    materials: { nav_floor_exterior: 1 },
    warnings: [] as string[]
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "h1emu-nav-artifact-"));
  const cache = join(root, "collision");
  mkdirSync(cache);
  const part = tsetBuffer();
  writeFileSync(join(cache, "z1_cache_0.bin"), part);
  const semanticBytes = Buffer.from(JSON.stringify(semanticBakeReport()));
  writeFileSync(join(root, "navigation-semantics.json"), semanticBytes);
  const semanticFile = record("navigation-semantics.json", semanticBytes);
  const payload: Omit<NavigationArtifactManifest, "artifactId"> = {
    schemaVersion: 1,
    provenance: {
      status: "runtime-only",
      extractorCommit: null,
      recastCommit: null,
      recastNavigationCommit: null,
      sourceWorld: null,
      classifierConfig: null
    },
    runtime: {
      cache: {
        format: "TSET",
        parts: [
          {
            path: "collision/z1_cache_0.bin",
            size: part.length,
            sha256: sha256(part)
          }
        ],
        header: parseTsetHeader(part)
      },
      collision: null,
      heightmap: null,
      navigationMetadata: null,
      semantics: null,
      transitions: null
    }
  };
  const manifest: NavigationArtifactManifest = {
    ...payload,
    artifactId: calculateNavigationArtifactId(payload)
  };
  const manifestPath = join(root, "navigation-artifact-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, cache, manifestPath, manifest, semanticFile };
}

function claimCompleteProvenance(
  manifest: NavigationArtifactManifest,
  semanticFile: NavigationArtifactFile
): void {
  const file = manifest.runtime.cache.parts[0];
  manifest.provenance = {
    status: "complete",
    extractorCommit: "extractor",
    recastCommit: "recast",
    recastNavigationCommit: "recast-navigation",
    sourceWorld: { name: "world.obj", size: file.size, sha256: file.sha256 },
    classifierConfig: {
      name: "navigation.yml",
      size: file.size,
      sha256: file.sha256
    }
  };
  manifest.runtime.collision = {
    file,
    format: "H1COL2",
    version: 1,
    meshCount: 1,
    instanceCount: 1
  };
  manifest.runtime.heightmap = {
    file,
    format: "PNG",
    width: 8192,
    height: 8192
  };
  manifest.runtime.navigationMetadata = {
    file,
    schemaVersion: 2,
    instanceCount: 1,
    kinds: { walkable: 1 },
    semanticMode: "strict",
    bakedDoorGeometryExcluded: false
  };
  manifest.runtime.semantics = {
    file: semanticFile,
    ...semanticBakeReport()
  };
  manifest.runtime.transitions = { file, count: 0 };
}

function bindSourceReport(
  root: string,
  manifest: NavigationArtifactManifest,
  report: unknown
): void {
  const bytes = Buffer.from(JSON.stringify(report));
  writeFileSync(join(root, "navigation-source-report.json"), bytes);
  manifest.provenance.sourceReport = {
    file: {
      path: "navigation-source-report.json",
      size: bytes.length,
      sha256: sha256(bytes)
    },
    ...parseCollisionSemanticSourceReport(report)
  };
}

function bindCompleteSourceReport(manifest: NavigationArtifactManifest): void {
  const file = manifest.runtime.cache.parts[0];
  const base = collisionSemanticSourceReport();
  manifest.provenance.sourceReport = {
    file,
    ...parseCollisionSemanticSourceReport({
      ...base,
      output: { ...base.output, sha256: file.sha256 },
      inputs: {
        ...base.inputs,
        heightmap: { ...base.inputs.heightmap, sha256: file.sha256 },
        collision: { ...base.inputs.collision, sha256: file.sha256 }
      }
    })
  };
}

function makeCompleteSnapshot(
  source: NavigationArtifactManifest,
  coverage: "full" | "regional",
  semanticFile: NavigationArtifactFile
): NavigationArtifactManifest {
  const manifest = structuredClone(source);
  claimCompleteProvenance(manifest, semanticFile);
  const file = manifest.runtime.cache.parts[0];
  const base = collisionSemanticSourceReport();
  manifest.provenance.sourceReport = {
    file,
    ...parseCollisionSemanticSourceReport({
      ...base,
      output: { ...base.output, sha256: file.sha256 },
      inputs: {
        ...base.inputs,
        heightmap: { ...base.inputs.heightmap, sha256: file.sha256 },
        collision: { ...base.inputs.collision, sha256: file.sha256 }
      }
    })
  };
  manifest.runtime.cache.coverage =
    coverage === "full"
      ? { kind: "full" }
      : {
          kind: "regional",
          bounds: { minX: -255, minZ: -1180, maxX: -210, maxZ: -1125 }
        };
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  return manifest;
}

function record(path: string, bytes: Buffer): NavigationArtifactFile {
  return { path, size: bytes.length, sha256: sha256(bytes) };
}

function compositeFixture() {
  const result = fixture();
  const base = makeCompleteSnapshot(
    result.manifest,
    "full",
    result.semanticFile
  );
  const regional = makeCompleteSnapshot(
    result.manifest,
    "regional",
    result.semanticFile
  );
  const baseBytes = Buffer.from(JSON.stringify(base));
  const regionalBytes = Buffer.from(JSON.stringify(regional));
  writeFileSync(join(result.root, "base-manifest.json"), baseBytes);
  writeFileSync(join(result.root, "regional-manifest.json"), regionalBytes);

  result.manifest.runtime = structuredClone(base.runtime);
  result.manifest.runtime.cache.coverage = { kind: "full" };
  const mergeReport = {
    schema: "h1emu-navigation-cache-merge-v1" as const,
    schemaVersion: 1 as const,
    mode: "regional-overlay" as const,
    tool: { name: "h1emu-cache-merge", version: "1.0.0", commit: "abcdef1" },
    base: {
      artifactId: base.artifactId,
      manifestSha256: sha256(baseBytes),
      cacheParts: structuredClone(base.runtime.cache.parts)
    },
    regional: {
      artifactId: regional.artifactId,
      manifestSha256: sha256(regionalBytes),
      cacheParts: structuredClone(regional.runtime.cache.parts)
    },
    output: {
      cacheParts: structuredClone(result.manifest.runtime.cache.parts),
      collision: structuredClone(result.manifest.runtime.collision!.file),
      heightmap: structuredClone(result.manifest.runtime.heightmap!.file),
      navigationMetadata: structuredClone(
        result.manifest.runtime.navigationMetadata!.file
      ),
      semantics: structuredClone(result.manifest.runtime.semantics!.file),
      transitions: structuredClone(result.manifest.runtime.transitions!.file)
    }
  };
  const mergeBytes = Buffer.from(JSON.stringify(mergeReport));
  writeFileSync(join(result.root, "cache-merge-report.json"), mergeBytes);
  result.manifest.provenance = {
    status: "complete",
    extractorCommit: null,
    recastCommit: null,
    recastNavigationCommit: null,
    sourceWorld: null,
    classifierConfig: null,
    sourceReport: null,
    composition: {
      schema: "h1emu-navigation-cache-composition-v1",
      base: {
        manifest: record("base-manifest.json", baseBytes),
        snapshot: base
      },
      regional: {
        manifest: record("regional-manifest.json", regionalBytes),
        snapshot: regional
      },
      mergeReport: {
        ...record("cache-merge-report.json", mergeBytes),
        ...mergeReport
      }
    }
  };
  result.manifest.artifactId = calculateNavigationArtifactId(result.manifest);
  writeFileSync(result.manifestPath, JSON.stringify(result.manifest));
  return { ...result, base, regional, mergeReport };
}

function persistCompositeManifest(
  manifestPath: string,
  manifest: NavigationArtifactManifest
): void {
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function persistMergeReport(
  root: string,
  manifest: NavigationArtifactManifest
): void {
  const mergeReport = manifest.provenance.composition!.mergeReport;
  const {
    path: _path,
    size: _size,
    sha256: _sha256,
    ...snapshot
  } = mergeReport;
  const bytes = Buffer.from(JSON.stringify(snapshot));
  writeFileSync(join(root, "cache-merge-report.json"), bytes);
  Object.assign(mergeReport, record("cache-merge-report.json", bytes));
}

test("canonical JSON and artifact IDs ignore object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  const { manifest } = fixture();
  assert.equal(calculateNavigationArtifactId(manifest), manifest.artifactId);
});

test("verifies a runtime-only cache manifest", async () => {
  const { cache, manifestPath, manifest } = fixture();
  const verified = await verifyNavigationArtifact({
    manifestPath,
    cacheDirectory: cache
  });
  assert.equal(verified.manifest.artifactId, manifest.artifactId);
  assert.equal(verified.filesVerified, 1);
});

test("verifies a complete full plus regional cache composition", async () => {
  const { cache, manifestPath, manifest } = compositeFixture();
  const verified = await verifyNavigationArtifact({
    manifestPath,
    cacheDirectory: cache
  });
  assert.equal(verified.manifest.artifactId, manifest.artifactId);
  assert.equal(verified.manifest.runtime.cache.coverage?.kind, "full");
  assert.equal(
    verified.manifest.provenance.composition?.regional.snapshot.runtime.cache
      .coverage?.kind,
    "regional"
  );
});

test("composed complete artifacts cannot downgrade output semantic evidence", async () => {
  const { cache, manifestPath, manifest } = compositeFixture();
  manifest.runtime.semantics!.bakedSemanticsVerified = false;
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /incomplete or legacy semantic provenance/
  );
});

test("rejects a runtime-only cache composition input", async () => {
  const { cache, manifestPath, manifest } = compositeFixture();
  const regional = manifest.provenance.composition!.regional.snapshot;
  regional.provenance.status = "runtime-only";
  regional.artifactId = calculateNavigationArtifactId(regional);
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /regional artifact requires complete provenance/
  );
});

test("rejects incorrect cache composition coverage", async () => {
  const { cache, manifestPath, manifest } = compositeFixture();
  manifest.provenance.composition!.regional.snapshot.runtime.cache.coverage = {
    kind: "full"
  };
  manifest.provenance.composition!.regional.snapshot.artifactId =
    calculateNavigationArtifactId(
      manifest.provenance.composition!.regional.snapshot
    );
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /regional artifact must have regional coverage/
  );
});

test("rejects a mismatched component manifest hash", async () => {
  const { root, cache, manifestPath, manifest } = compositeFixture();
  manifest.provenance.composition!.mergeReport.base.manifestSha256 = "f".repeat(
    64
  );
  persistMergeReport(root, manifest);
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /base manifest hash mismatch/
  );
});

test("rejects cache inputs that differ from the merge report", async () => {
  const { root, cache, manifestPath, manifest } = compositeFixture();
  manifest.provenance.composition!.mergeReport.regional.cacheParts[0].sha256 =
    "d".repeat(64);
  persistMergeReport(root, manifest);
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /regional cache parts mismatch/
  );
});

test("rejects runtime dependency drift between composition inputs", async () => {
  const { cache, manifestPath, manifest } = compositeFixture();
  const composition = manifest.provenance.composition!;
  composition.regional.snapshot.runtime.transitions!.count = 7;
  composition.regional.snapshot.artifactId = calculateNavigationArtifactId(
    composition.regional.snapshot
  );
  composition.mergeReport.regional.artifactId =
    composition.regional.snapshot.artifactId;
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /regional transitions mismatch/
  );
});

test("rejects a merge report whose output hashes do not match the bundle", async () => {
  const { root, cache, manifestPath, manifest } = compositeFixture();
  manifest.provenance.composition!.mergeReport.output.cacheParts[0].sha256 =
    "e".repeat(64);
  persistMergeReport(root, manifest);
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /output cache parts mismatch/
  );
});

test("rejects a staged component manifest that differs from its snapshot", async () => {
  const { root, cache, manifestPath, manifest, base } = compositeFixture();
  const changedBase = structuredClone(base);
  changedBase.provenance.extractorCommit = "different-extractor";
  changedBase.artifactId = calculateNavigationArtifactId(changedBase);
  const changedBytes = Buffer.from(JSON.stringify(changedBase));
  writeFileSync(join(root, "base-manifest.json"), changedBytes);
  const composition = manifest.provenance.composition!;
  composition.base.manifest = record("base-manifest.json", changedBytes);
  composition.mergeReport.base.manifestSha256 = sha256(changedBytes);
  persistMergeReport(root, manifest);
  persistCompositeManifest(manifestPath, manifest);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /base component manifest does not match manifested snapshot/
  );
});

test("rejects invalid merge tool provenance", () => {
  const { mergeReport } = compositeFixture();
  assert.throws(
    () =>
      parseNavigationCacheMergeReport({
        ...mergeReport,
        tool: { ...mergeReport.tool, commit: "not-a-commit" }
      }),
    /invalid tool provenance/
  );
});

test("binds and verifies a collision-first semantic source report", async () => {
  const { root, cache, manifestPath, manifest } = fixture();
  const reportPath = join(root, "navigation-source-report.json");
  const report = collisionSemanticSourceReport();
  const bytes = Buffer.from(JSON.stringify(report));
  writeFileSync(reportPath, bytes);
  manifest.provenance.sourceReport = {
    file: {
      path: "navigation-source-report.json",
      size: bytes.length,
      sha256: sha256(bytes)
    },
    ...parseCollisionSemanticSourceReport(report)
  };
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const verified = await verifyNavigationArtifact({
    manifestPath,
    cacheDirectory: cache
  });
  assert.equal(verified.filesVerified, 2);
  assert.equal(
    verified.manifest.provenance.sourceReport?.collisionMetadataMatched,
    true
  );
  assert.equal(
    verified.manifest.provenance.sourceReport?.semanticMode,
    "per-triangle-h1sem1"
  );
  assert.equal(
    verified.manifest.provenance.sourceReport?.inputs.collisionTriangleSemantics
      ?.format,
    "H1SEM1-u8le-v1"
  );
  assert.equal(
    verified.manifest.provenance.sourceReport?.inputs.collisionSemanticPolicy
      ?.canonical,
    true
  );

  const legacySnapshot = manifest.provenance.sourceReport!;
  delete legacySnapshot.semanticMode;
  delete legacySnapshot.inputs.collisionInstanceIds;
  delete legacySnapshot.inputs.collisionTriangleSemantics;
  delete legacySnapshot.inputs.collisionSemanticPolicy;
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.doesNotReject(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache })
  );
});

test("rejects source claims that differ from the bound source report", async () => {
  const { root, cache, manifestPath, manifest } = fixture();
  const reportPath = join(root, "navigation-source-report.json");
  const report = collisionSemanticSourceReport();
  const bytes = Buffer.from(JSON.stringify(report));
  writeFileSync(reportPath, bytes);
  manifest.provenance.sourceReport = {
    file: {
      path: "navigation-source-report.json",
      size: bytes.length,
      sha256: sha256(bytes)
    },
    ...parseCollisionSemanticSourceReport(report),
    sourceStrategy: "tampered-strategy"
  };
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /source report does not match manifested provenance/
  );
});

test("rejects an inconsistent source sidecar matched state", () => {
  assert.throws(
    () =>
      parseCollisionSemanticSourceReport({
        ...collisionSemanticSourceReport(),
        collisionMetadataMatched: false
      }),
    /matched state is inconsistent/
  );
});

test("rejects a false complete-provenance claim", async () => {
  const { cache, manifestPath, manifest } = fixture();
  manifest.provenance.status = "complete";
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /complete artifact provenance is missing extractorCommit/
  );
});

test("complete provenance requires a collision semantic source report", async () => {
  const { cache, manifestPath, manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /complete artifact provenance is missing sourceReport/
  );
});

test("complete provenance requires a matched collision metadata sidecar", async () => {
  const { root, cache, manifestPath, manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  const file = manifest.runtime.cache.parts[0];
  const base = collisionSemanticSourceReport();
  const report = {
    ...base,
    output: { ...base.output, sha256: file.sha256 },
    inputs: {
      ...base.inputs,
      heightmap: { ...base.inputs.heightmap, sha256: file.sha256 },
      collision: { ...base.inputs.collision, sha256: file.sha256 },
      collisionMetadata: null
    }
  };
  bindSourceReport(root, manifest, report);
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /does not match its sidecar, source world, or runtime inputs/
  );
});

test("complete provenance binds the source report output to sourceWorld", async () => {
  const { root, cache, manifestPath, manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  const file = manifest.runtime.cache.parts[0];
  const base = collisionSemanticSourceReport();
  const report = {
    ...base,
    output: { file: "different.obj", sha256: file.sha256 },
    inputs: {
      ...base.inputs,
      heightmap: { ...base.inputs.heightmap, sha256: file.sha256 },
      collision: { ...base.inputs.collision, sha256: file.sha256 }
    }
  };
  bindSourceReport(root, manifest, report);
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /does not match its sidecar, source world, or runtime inputs/
  );
});

test("runtime-only semantic reports preserve optional verification evidence", async () => {
  const { cache, manifestPath, manifest, semanticFile } = fixture();
  manifest.runtime.semantics = {
    file: semanticFile,
    ...semanticBakeReport()
  };
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const verified = await verifyNavigationArtifact({
    manifestPath,
    cacheDirectory: cache
  });
  assert.equal(
    verified.manifest.runtime.semantics?.dynamicDoorObstaclesAcknowledged,
    true
  );
  assert.equal(
    verified.manifest.runtime.semantics?.bakedSemanticsVerified,
    true
  );

  delete manifest.runtime.semantics!.dynamicDoorObstaclesAcknowledged;
  delete manifest.runtime.semantics!.bakedSemanticsVerified;
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.doesNotReject(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache })
  );

  const legacy = semanticBakeReport();
  delete (legacy as { dynamicDoorObstaclesAcknowledged?: boolean })
    .dynamicDoorObstaclesAcknowledged;
  delete (legacy as { bakedSemanticsVerified?: boolean })
    .bakedSemanticsVerified;
  assert.doesNotThrow(() => parseNavigationSemanticBakeReport(legacy));
});

test("rejects semantic verification evidence invented only in the manifest", async () => {
  const { cache, manifestPath, manifest, semanticFile } = fixture();
  manifest.runtime.semantics = {
    file: semanticFile,
    ...semanticBakeReport(),
    bakedSemanticsVerified: false
  };
  manifest.artifactId = calculateNavigationArtifactId(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /semantic bake report does not match manifested provenance/
  );
});

test("complete provenance requires verified baked semantics", () => {
  const { manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  bindCompleteSourceReport(manifest);
  delete (manifest.runtime.semantics as { bakedSemanticsVerified?: boolean })
    .bakedSemanticsVerified;

  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /incomplete or legacy semantic provenance/
  );
});

test("complete provenance rejects actor-default and unresolved source limitations", () => {
  const { manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  bindCompleteSourceReport(manifest);
  manifest.provenance.sourceReport!.limitations = [
    "actor_default_pending_per_triangle_table"
  ];
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /actor-default pending per-triangle semantics/
  );

  manifest.provenance.sourceReport!.limitations = [
    "Composite floors remain unresolved."
  ];
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /unresolved semantic limitations/
  );
});

test("complete provenance requires matched H1SEM1 and canonical policy inputs", () => {
  const { manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  bindCompleteSourceReport(manifest);
  const report = manifest.provenance.sourceReport!;
  const triangleSemantics = report.inputs.collisionTriangleSemantics;
  const semanticPolicy = report.inputs.collisionSemanticPolicy;

  report.semanticMode = "legacy-actor-diagnostic";
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /diagnostic actor-default semantics/
  );

  report.semanticMode = "per-triangle-h1sem1";
  report.inputs.collisionTriangleSemantics = null;
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /matched per-triangle H1SEM1 source provenance/
  );

  report.inputs.collisionTriangleSemantics = triangleSemantics;
  report.inputs.collisionSemanticPolicy = null;
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /matched canonical semantic policy/
  );

  report.inputs.collisionSemanticPolicy = semanticPolicy;
  assert.doesNotThrow(() =>
    assertCompleteNavigationArtifactProvenance(manifest)
  );
});

test("complete provenance binds excluded doors to dynamic obstacle acknowledgement", () => {
  const { manifest, semanticFile } = fixture();
  claimCompleteProvenance(manifest, semanticFile);
  bindCompleteSourceReport(manifest);
  delete manifest.runtime.semantics!.dynamicDoorObstaclesAcknowledged;
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /missing dynamic door semantic provenance/
  );

  manifest.runtime.navigationMetadata!.bakedDoorGeometryExcluded = true;
  manifest.runtime.semantics!.dynamicDoorObstaclesAcknowledged = false;
  assert.throws(
    () => assertCompleteNavigationArtifactProvenance(manifest),
    /without acknowledged dynamic door obstacles/
  );

  manifest.runtime.semantics!.dynamicDoorObstaclesAcknowledged = true;
  assert.doesNotThrow(() =>
    assertCompleteNavigationArtifactProvenance(manifest)
  );
});

test("rejects a cache part whose bytes changed", async () => {
  const { cache, manifestPath } = fixture();
  const path = join(cache, "z1_cache_0.bin");
  const changed = readFileSync(path);
  changed[95] ^= 0xff;
  writeFileSync(path, changed);
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /SHA-256 mismatch/
  );
});

test("rejects an unmanifested cache part", async () => {
  const { cache, manifestPath } = fixture();
  writeFileSync(join(cache, "z1_cache_1.bin"), Buffer.from("extra"));
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /unmanifested part/
  );
});

test("rejects a tampered artifactId", async () => {
  const { cache, manifestPath, manifest } = fixture();
  manifest.artifactId = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    verifyNavigationArtifact({ manifestPath, cacheDirectory: cache }),
    /artifactId mismatch/
  );
});

test("requires collision, heightmap, and transitions for a runtime bundle", async () => {
  const { cache, manifestPath } = fixture();
  await assert.rejects(
    verifyNavigationArtifact({
      manifestPath,
      cacheDirectory: cache,
      requireRuntimeDependencies: true
    }),
    /runtime artifact dependency is not manifested/
  );
});

test("complete artifacts cannot exclude doors without runtime obstacles", () => {
  const { manifest } = fixture();
  manifest.provenance.status = "complete";
  manifest.runtime.navigationMetadata = {
    file: manifest.runtime.cache.parts[0],
    schemaVersion: 2,
    instanceCount: 1,
    kinds: { door: 1 },
    semanticMode: "strict",
    bakedDoorGeometryExcluded: true
  };
  assert.throws(
    () => assertNavigationRuntimeConfiguration(manifest, undefined),
    /H1EMU_DYNAMIC_DOOR_OBSTACLES=1/
  );
  assert.doesNotThrow(() =>
    assertNavigationRuntimeConfiguration(manifest, "1")
  );
});
