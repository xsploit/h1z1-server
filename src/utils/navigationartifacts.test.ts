import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  calculateNavigationArtifactId,
  canonicalJson,
  NavigationArtifactManifest,
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "h1emu-nav-artifact-"));
  const cache = join(root, "collision");
  mkdirSync(cache);
  const part = tsetBuffer();
  writeFileSync(join(cache, "z1_cache_0.bin"), part);
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
  return { root, cache, manifestPath, manifest };
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
