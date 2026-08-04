import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  forbiddenProbeContainsNearestPoint,
  modelRouteEndpointGap,
  resolveModelInstanceCacheDirectory
} from "./modelroutevalidation";

test("model route endpoint gaps include vertical separation", () => {
  assert.equal(
    modelRouteEndpointGap({ x: 4, y: 2, z: 8 }, { x: 4, y: 5, z: 8 }),
    3
  );
});

test("forbidden probes ignore a different floor outside their vertical box", () => {
  const probe = { x: 4, y: 14.4, z: 8 };
  const halfExtents = { x: 0.6, y: 0.35, z: 0.6 };
  assert.equal(
    forbiddenProbeContainsNearestPoint(probe, halfExtents, {
      nearestRef: 7,
      nearestPoint: { x: 4, y: 13.7, z: 8 }
    }),
    false
  );
  assert.equal(
    forbiddenProbeContainsNearestPoint(probe, halfExtents, {
      nearestRef: 7,
      nearestPoint: { x: 4, y: 14.4, z: 8 }
    }),
    true
  );
});

test("model route validator resolves per-instance regional caches", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-model-cache-"));
  try {
    const instance = join(root, "42");
    mkdirSync(instance);
    writeFileSync(join(instance, "z1_cache_0.bin"), "cache");
    assert.equal(
      resolveModelInstanceCacheDirectory(root, 42),
      resolve(instance)
    );
    assert.throws(
      () => resolveModelInstanceCacheDirectory(root, 43),
      /instance 43 was not found/
    );
    assert.throws(
      () => resolveModelInstanceCacheDirectory(instance, 43),
      /belongs to instance 42, not 43/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model route validator accepts a direct deployed cache directory", () => {
  const root = mkdtempSync(join(tmpdir(), "h1emu-model-cache-"));
  try {
    writeFileSync(join(root, "z1_cache_0.bin"), "cache");
    assert.equal(resolveModelInstanceCacheDirectory(root, 7), resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
